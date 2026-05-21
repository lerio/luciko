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
    };
    exec: (sql: string) => Promise<unknown>;
  };
  LUCIKO_BUCKET?: unknown;
};

const BASIC_AUTH_USER = 'luciko';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sync_state (
  id TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS sync_events (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS archive_messages (
  id TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS archive_messages_chat_timestamp ON archive_messages (chat_id, timestamp);
CREATE TABLE IF NOT EXISTS archive_posts (
  id TEXT PRIMARY KEY NOT NULL,
  timestamp INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS archive_posts_timestamp ON archive_posts (timestamp);
`;

async function ensureSchema(env: Env) {
  if (!env.LUCIKO_DB) return false;
  try {
    await env.LUCIKO_DB.exec(SCHEMA_SQL);
    return true;
  } catch (error) {
    console.error('Failed to ensure schema', error);
    return false;
  }
}

type SyncPayload = {
  messages?: Array<Record<string, unknown>>;
  posts?: Array<Record<string, unknown>>;
};

const PAGE_SIZE = 50;

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
           updated_at = excluded.updated_at`,
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
           updated_at = excluded.updated_at`,
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
        const entity = url.searchParams.get('entity');
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0') || 0);
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? String(PAGE_SIZE)) || PAGE_SIZE));

        if (entity === 'messages' || entity === 'posts') {
          const table = entity === 'messages' ? 'archive_messages' : 'archive_posts';
          const totalRows = await env.LUCIKO_DB
            ?.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
            .bind()
            .all<{ count: number }>();
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
            total: totalRows?.results[0]?.count ?? 0,
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
