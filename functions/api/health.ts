const TABLES_SQL = `
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

async function ensureSchema(env: Record<string, unknown>) {
  const db = env.LUCIKO_DB as { exec?: (sql: string) => Promise<unknown> } | undefined;
  if (!db?.exec) return false;
  await db.exec(TABLES_SQL);
  return true;
}

export async function onRequestGet(context: { env: Record<string, unknown> }) {
  const schemaReady = await ensureSchema(context.env ?? {});
  const body = {
    ok: true,
    service: 'luciko',
    mode: 'local-first',
    schemaReady,
    bindings: {
      d1: Boolean(context.env?.LUCIKO_DB),
      r2: Boolean(context.env?.LUCIKO_BUCKET),
    },
  };

  return Response.json(body, {
    headers: {
      'cache-control': 'no-store',
    },
  });
}
