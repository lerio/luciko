type Env = {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>;
  };
  LUCIKO_BASIC_AUTH_PASSWORD?: string;
  LUCIKO_DB?: {
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
        return json({
          ok: true,
          route: '/api/sync',
          supported: false,
          schemaReady,
          message: 'Sync API scaffold is deployed. Full encrypted sync will be wired next.',
        });
      }

      if (url.pathname === '/api/sync' && request.method === 'POST') {
        await ensureSchema(env);

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

        return json({
          ok: true,
          accepted: false,
          receivedType: typeof payload,
          message: 'Push endpoint scaffold is live but not yet enabled for production sync.',
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
