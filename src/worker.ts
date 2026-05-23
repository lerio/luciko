type Env = {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>;
  };
  LUCIKO_BASIC_AUTH_PASSWORD?: string;
  LUCIKO_DB?: {
    prepare: (sql: string) => {
      bind: (...values: unknown[]) => {
        run: () => Promise<unknown>;
        all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
      };
      run: () => Promise<unknown>;
      all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
    };
    exec: (sql: string) => Promise<unknown>;
  };
  LUCIKO_BUCKET?: unknown;
};

const BASIC_AUTH_USER = 'luciko';

async function hasTable(env: Env, tableName: string): Promise<boolean> {
  if (!env.LUCIKO_DB) return false;
  try {
    const result = await env.LUCIKO_DB
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .bind(tableName)
      .all<{ name: string }>();
    return result.results.length > 0;
  } catch (error) {
    console.error(`Failed to inspect table ${tableName}`, error);
    return false;
  }
}

async function ensureSchema(env: Env) {
  const [messagesReady, postsReady, chunksReady] = await Promise.all([
    hasTable(env, 'archive_messages'),
    hasTable(env, 'archive_posts'),
    hasTable(env, 'archive_chunks'),
  ]);
  return messagesReady && postsReady && chunksReady;
}

type SyncPayload = {
  messages?: Array<Record<string, unknown>>;
  posts?: Array<Record<string, unknown>>;
};

type SyncDiffPayload = {
  entity?: unknown;
  items?: unknown;
  chunks?: unknown;
};

const PAGE_SIZE = 50;
const ARCHIVE_CHUNK_SIZE = 500;

async function hashText(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashBuffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function writeArchive(env: Env, payload: SyncPayload) {
  if (!env.LUCIKO_DB) {
    return false;
  }

  const now = Date.now();
  const messages = payload.messages ?? [];
  const posts = payload.posts ?? [];

  for (const message of messages) {
    const chatId = typeof message.chatId === 'string' ? message.chatId : '';
    const id = typeof message.id === 'string' ? message.id : '';
    const timestampValue = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN;
    if (!id || !chatId || Number.isNaN(timestampValue)) {
      continue;
    }

    await env.LUCIKO_DB
      .prepare(
        `INSERT INTO archive_messages (id, chat_id, timestamp, payload, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           chat_id = excluded.chat_id,
           timestamp = excluded.timestamp,
           payload = excluded.payload,
           updated_at = excluded.updated_at
         WHERE archive_messages.payload != excluded.payload`,
      )
      .bind(id, chatId, timestampValue, JSON.stringify(message), now)
      .run();
  }

  for (const post of posts) {
    const id = typeof post.id === 'string' ? post.id : '';
    const timestamp = typeof post.timestamp === 'number' ? post.timestamp : NaN;
    if (!id || Number.isNaN(timestamp)) {
      continue;
    }

    await env.LUCIKO_DB
      .prepare(
        `INSERT INTO archive_posts (id, timestamp, payload, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           timestamp = excluded.timestamp,
           payload = excluded.payload,
           updated_at = excluded.updated_at
         WHERE archive_posts.payload != excluded.payload`,
      )
      .bind(id, timestamp, JSON.stringify(post), now)
      .run();
  }

  return true;
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i += 1) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return result === 0;
}

function parseBasicAuth(request: Request) {
  const header = request.headers.get('authorization');
  if (!header) return null;

  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return null;

  try {
    const decoded = atob(encoded);
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex < 0) return null;

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

function isAuthenticated(request: Request, env: Env) {
  const expectedPassword = env.LUCIKO_BASIC_AUTH_PASSWORD;
  if (!expectedPassword) return false;

  const credentials = parseBasicAuth(request);
  if (!credentials) return false;

  return (
    timingSafeEqual(credentials.username, BASIC_AUTH_USER) &&
    timingSafeEqual(credentials.password, expectedPassword)
  );
}

function authChallenge() {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="luciko", charset="UTF-8"',
      'cache-control': 'no-store',
    },
  });
}

function json(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    headers: {
      'cache-control': 'no-store',
    },
    ...init,
  });
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (!isAuthenticated(request, env)) {
        return authChallenge();
      }

      if (url.pathname === '/api/health' && request.method === 'GET') {
        const schemaReady = await ensureSchema(env);
        return json({
          ok: true,
          service: 'luciko',
          mode: 'worker',
          schemaReady,
          bindings: {
            d1: Boolean(env.LUCIKO_DB),
            r2: Boolean(env.LUCIKO_BUCKET),
          },
        });
      }

      if (url.pathname === '/api/sync' && request.method === 'GET') {
        const schemaReady = await ensureSchema(env);
        if (!schemaReady) {
          return json(
            {
              ok: false,
              error: 'Archive schema is not ready',
              schemaReady,
            },
            { status: 503 },
          );
        }
        const entity = url.searchParams.get('entity');
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0') || 0);
        const limit = Math.max(1, Math.min(ARCHIVE_CHUNK_SIZE, Number(url.searchParams.get('limit') ?? String(PAGE_SIZE)) || PAGE_SIZE));

        if (entity === 'messages' || entity === 'posts') {
          const table = entity === 'messages' ? 'archive_messages' : 'archive_posts';
          const totalRows = await env.LUCIKO_DB
            ?.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
            .bind()
            .all<{ count: number }>();
          const rowTotal = totalRows?.results[0]?.count ?? 0;
          const chunkCount = await env.LUCIKO_DB
            ?.prepare('SELECT COUNT(*) AS count FROM archive_chunks WHERE entity = ?')
            .bind(entity)
            .all<{ count: number }>();
          const chunkTotalRows = await env.LUCIKO_DB
            ?.prepare('SELECT COALESCE(SUM(item_count), 0) AS count FROM archive_chunks WHERE entity = ?')
            .bind(entity)
            .all<{ count: number }>();
          const chunkTotal = chunkTotalRows?.results[0]?.count ?? 0;

          if ((chunkCount?.results[0]?.count ?? 0) > 0 && chunkTotal >= rowTotal) {
            const chunkStart = Math.floor(offset / ARCHIVE_CHUNK_SIZE);
            const chunkEnd = Math.floor((offset + limit - 1) / ARCHIVE_CHUNK_SIZE);
            const rows = await env.LUCIKO_DB
              ?.prepare(
                `SELECT chunk_index, payload FROM archive_chunks
                 WHERE entity = ? AND chunk_index BETWEEN ? AND ?
                 ORDER BY chunk_index ASC`,
              )
              .bind(entity, chunkStart, chunkEnd)
              .all<{ chunk_index: number; payload: string }>();
            const items: unknown[] = [];

            for (const row of rows?.results ?? []) {
              const chunkItems = JSON.parse(row.payload) as unknown[];
              const chunkOffset = row.chunk_index * ARCHIVE_CHUNK_SIZE;
              for (let index = 0; index < chunkItems.length; index += 1) {
                const itemOffset = chunkOffset + index;
                if (itemOffset >= offset && items.length < limit) {
                  items.push(chunkItems[index]);
                }
              }
            }

            return json({
              ok: true,
              route: '/api/sync',
              schemaReady,
              entity,
              offset,
              limit,
              total: chunkTotal,
              items,
            });
          }

          const rows = await env.LUCIKO_DB
            ?.prepare(`SELECT payload FROM ${table} ORDER BY timestamp ASC, id ASC LIMIT ? OFFSET ?`)
            .bind(limit, offset)
            .all<{ payload: string }>();

          return json({
            ok: true,
            route: '/api/sync',
            schemaReady,
            entity,
            offset,
            limit,
            total: rowTotal,
            items: rows?.results.map((row) => JSON.parse(row.payload)) ?? [],
          });
        }

        return json({
          ok: true,
          route: '/api/sync',
          schemaReady,
          entities: ['messages', 'posts'],
        });
      }

      if (url.pathname === '/api/sync' && request.method === 'POST') {
        const schemaReady = await ensureSchema(env);
        if (!schemaReady) {
          return json(
            {
              ok: false,
              error: 'Archive schema is not ready',
              schemaReady,
            },
            { status: 503 },
          );
        }

        const contentType = request.headers.get('content-type') ?? '';
        if (!contentType.includes('application/json')) {
          return new Response('Expected application/json', { status: 415 });
        }

        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return new Response('Invalid JSON body', { status: 400 });
        }

        const accepted = await writeArchive(env, payload as SyncPayload);
        return json({
          ok: true,
          accepted,
          schemaReady,
        });
      }

      if (url.pathname === '/api/sync/chunk' && request.method === 'POST') {
        const schemaReady = await ensureSchema(env);
        if (!schemaReady) {
          return json(
            {
              ok: false,
              error: 'Archive schema is not ready',
              schemaReady,
            },
            { status: 503 },
          );
        }

        const contentType = request.headers.get('content-type') ?? '';
        if (!contentType.includes('application/json')) {
          return new Response('Expected application/json', { status: 415 });
        }

        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return new Response('Invalid JSON body', { status: 400 });
        }

        if (!payload || typeof payload !== 'object') {
          return new Response('Invalid JSON body', { status: 400 });
        }

        const chunk = payload as { entity?: unknown; chunkIndex?: unknown; items?: unknown };
        if (chunk.entity !== 'messages' && chunk.entity !== 'posts') {
          return new Response('Expected entity to be messages or posts', { status: 400 });
        }
        if (typeof chunk.chunkIndex !== 'number' || !Number.isInteger(chunk.chunkIndex) || chunk.chunkIndex < 0) {
          return new Response('Expected non-negative chunkIndex', { status: 400 });
        }
        if (!Array.isArray(chunk.items)) {
          return new Response('Expected items array', { status: 400 });
        }
        const chunkIndex = chunk.chunkIndex as number;

        await env.LUCIKO_DB
          ?.prepare(
            `INSERT INTO archive_chunks (entity, chunk_index, payload, item_count, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(entity, chunk_index) DO UPDATE SET
               payload = excluded.payload,
               item_count = excluded.item_count,
               updated_at = excluded.updated_at
             WHERE archive_chunks.payload != excluded.payload`,
          )
          .bind(chunk.entity, chunkIndex, JSON.stringify(chunk.items), chunk.items.length, Date.now())
          .run();

        return json({
          ok: true,
          accepted: true,
          schemaReady,
        });
      }

      if (url.pathname === '/api/sync/diff' && request.method === 'POST') {
        const schemaReady = await ensureSchema(env);
        if (!schemaReady) {
          return json(
            {
              ok: false,
              error: 'Archive schema is not ready',
              schemaReady,
            },
            { status: 503 },
          );
        }

        const contentType = request.headers.get('content-type') ?? '';
        if (!contentType.includes('application/json')) {
          return new Response('Expected application/json', { status: 415 });
        }

        let payload: SyncDiffPayload;
        try {
          payload = (await request.json()) as SyncDiffPayload;
        } catch {
          return new Response('Invalid JSON body', { status: 400 });
        }

        const entity = payload.entity;
        if (entity !== 'messages' && entity !== 'posts') {
          return new Response('Expected entity to be messages or posts', { status: 400 });
        }

        if (Array.isArray(payload.chunks)) {
          const chunks = payload.chunks
            .map((chunk) => {
              if (!chunk || typeof chunk !== 'object') {
                return null;
              }
              const candidate = chunk as { chunkIndex?: unknown; hash?: unknown };
              if (!Number.isInteger(candidate.chunkIndex) || typeof candidate.hash !== 'string') {
                return null;
              }
              return {
                chunkIndex: candidate.chunkIndex as number,
                hash: candidate.hash,
              };
            })
            .filter((chunk): chunk is { chunkIndex: number; hash: string } => Boolean(chunk));

          if (chunks.length === 0) {
            return json({
              ok: true,
              schemaReady,
              entity,
              chunks: [],
            });
          }

          const placeholders = chunks.map(() => '?').join(', ');
          const rows = await env.LUCIKO_DB
            ?.prepare(
              `SELECT chunk_index, payload FROM archive_chunks
               WHERE entity = ? AND chunk_index IN (${placeholders})`,
            )
            .bind(entity, ...chunks.map((chunk) => chunk.chunkIndex))
            .all<{ chunk_index: number; payload: string }>();
          const serverRows = new Map(rows?.results.map((row) => [row.chunk_index, row.payload]) ?? []);
          const changedChunks: number[] = [];

          for (const chunk of chunks) {
            const serverPayload = serverRows.get(chunk.chunkIndex);
            if (!serverPayload || (await hashText(serverPayload)) !== chunk.hash) {
              changedChunks.push(chunk.chunkIndex);
            }
          }

          return json({
            ok: true,
            schemaReady,
            entity,
            chunks: changedChunks,
          });
        }

        if (!Array.isArray(payload.items)) {
          return new Response('Expected chunks or items array', { status: 400 });
        }

        const items = payload.items
          .map((item) => {
            if (!item || typeof item !== 'object') {
              return null;
            }
            const candidate = item as { id?: unknown; hash?: unknown };
            if (typeof candidate.id !== 'string' || typeof candidate.hash !== 'string') {
              return null;
            }
            return {
              id: candidate.id,
              hash: candidate.hash,
            };
          })
          .filter((item): item is { id: string; hash: string } => Boolean(item));

        if (items.length === 0) {
          return json({
            ok: true,
            schemaReady,
            entity,
            ids: [],
          });
        }

        const table = entity === 'messages' ? 'archive_messages' : 'archive_posts';
        const placeholders = items.map(() => '?').join(', ');
        const rows = await env.LUCIKO_DB
          ?.prepare(`SELECT id, payload FROM ${table} WHERE id IN (${placeholders})`)
          .bind(...items.map((item) => item.id))
          .all<{ id: string; payload: string }>();
        const serverRows = new Map(rows?.results.map((row) => [row.id, row.payload]) ?? []);
        const changedIds: string[] = [];

        for (const item of items) {
          const serverPayload = serverRows.get(item.id);
          if (!serverPayload || (await hashText(serverPayload)) !== item.hash) {
            changedIds.push(item.id);
          }
        }

        return json({
          ok: true,
          schemaReady,
          entity,
          ids: changedIds,
        });
      }

      return await env.ASSETS.fetch(request);
    } catch (error) {
      console.error('Worker request failed', error);
      return json(
        {
          ok: false,
          error: error instanceof Error ? error.message : 'Unknown worker error',
        },
        { status: 500 },
      );
    }
  },
};

export default worker;
