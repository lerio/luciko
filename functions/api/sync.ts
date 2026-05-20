const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS sync_state (
  id TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_events (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

async function ensureSchema(env: Record<string, unknown>) {
  const db = env.LUCIKO_DB as { exec?: (sql: string) => Promise<unknown> } | undefined;
  if (!db?.exec) return false;
  await db.exec(TABLES_SQL);
  return true;
}

export async function onRequestGet(context: { env: Record<string, unknown> }) {
  const schemaReady = await ensureSchema(context.env ?? {});
  return Response.json({
    ok: true,
    route: '/api/sync',
    supported: false,
    schemaReady,
    message: 'Sync API scaffold is deployed. Full encrypted sync will be wired next.',
  }, {
    headers: {
      'cache-control': 'no-store',
    },
  });
}

export async function onRequestPost(context: { request: Request; env: Record<string, unknown> }) {
  await ensureSchema(context.env ?? {});

  const contentType = context.request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return new Response('Expected application/json', { status: 415 });
  }

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  return Response.json({
    ok: true,
    accepted: false,
    receivedType: typeof payload,
    message: 'Push endpoint scaffold is live but not yet enabled for production sync.',
  }, {
    headers: {
      'cache-control': 'no-store',
    },
  });
}
