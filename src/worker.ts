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

type SerializedMessage = {
  id: string;
  chatId: string;
  timestamp: string;
  [key: string]: unknown;
};

type SerializedPost = {
  id: string;
  timestamp: number;
  [key: string]: unknown;
};

type SyncPayload = {
  messages?: SerializedMessage[];
  posts?: SerializedPost[];
};

async function readArchive(env: Env) {
  if (!env.LUCIKO_DB) {
    return { messages: [], posts: [] };
  }

  const messageRows = await env.LUCIKO_DB
    .prepare('SELECT payload FROM archive_messages ORDER BY timestamp ASC, id ASC')
    .bind()
    .all<{ payload: string }>();
  const postRows = await env.LUCIKO_DB
    .prepare('SELECT payload FROM archive_posts ORDER BY timestamp ASC, id ASC')
    .bind()
    .all<{ payload: string }>();

  return {
    messages: messageRows.results.map((row) => JSON.parse(row.payload) as SerializedMessage),
    posts: postRows.results.map((row) => JSON.parse(row.payload) as SerializedPost),
  };
}

async function writeArchive(env: Env, payload: SyncPayload) {
  if (!env.LUCIKO_DB) {
    return false;
  }

  const now = Date.now();
  const messages = payload.messages ?? [];
  const posts = payload.posts ?? [];

  for (const message of messages) {
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
      .bind(message.id, message.chatId, new Date(message.timestamp).getTime(), JSON.stringify(message), now)
      .run();
  }

  for (const post of posts) {
    await env.LUCIKO_DB
      .prepare(
        `INSERT INTO archive_posts (id, timestamp, payload, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           timestamp = excluded.timestamp,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
      )
      .bind(post.id, post.timestamp, JSON.stringify(post), now)
      .run();
  }

  return messages.length > 0 || posts.length > 0;
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
        const archive = await readArchive(env);
        return json({
          ok: true,
          route: '/api/sync',
          schemaReady,
          messages: archive.messages,
          posts: archive.posts,
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
