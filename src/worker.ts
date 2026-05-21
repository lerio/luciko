type Env = {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>;
  };
  LUCIKO_DB?: {
    exec: (sql: string) => Promise<unknown>;
  };
  LUCIKO_BUCKET?: unknown;
};

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
