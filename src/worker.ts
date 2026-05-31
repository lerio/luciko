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

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i += 1) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return result === 0;
}

async function signToken(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function createTokenPayload(deviceId: string): string {
  return JSON.stringify({ u: 'luciko', ts: Date.now(), did: deviceId });
}

async function createAuthToken(secret: string, deviceId: string): Promise<string> {
  const payload = createTokenPayload(deviceId);
  const payloadB64 = btoa(payload);
  const sig = await signToken(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

async function verifyToken(token: string, secret: string): Promise<{ valid: boolean; deviceId?: string }> {
  const idx = token.lastIndexOf('.');
  if (idx < 0) return { valid: false };
  const payloadB64 = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expectedSig = await signToken(payloadB64, secret);
  if (!timingSafeEqual(sig, expectedSig)) return { valid: false };

  try {
    const payload = JSON.parse(atob(payloadB64));
    return { valid: true, deviceId: payload.did };
  } catch {
    return { valid: false };
  }
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

function basicAuthValid(request: Request, env: Env): boolean {
  const expectedPassword = env.LUCIKO_BASIC_AUTH_PASSWORD;
  if (!expectedPassword) return false;

  const credentials = parseBasicAuth(request);
  if (!credentials) return false;

  return (
    timingSafeEqual(credentials.username, BASIC_AUTH_USER) &&
    timingSafeEqual(credentials.password, expectedPassword)
  );
}

function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
}

function json(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    headers: { 'cache-control': 'no-store' },
    ...init,
  });
}

// --- D1 device operations ---

async function registerDevice(
  db: NonNullable<Env['LUCIKO_DB']>,
  deviceId: string,
  userAgent: string,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      'INSERT INTO devices (id, name, public_key, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(deviceId, userAgent.slice(0, 255), '', now, now)
    .run();
}

async function isDeviceRevoked(
  db: NonNullable<Env['LUCIKO_DB']>,
  deviceId: string,
): Promise<boolean> {
  const result = await db
    .prepare('SELECT revoked_at FROM devices WHERE id = ?')
    .bind(deviceId)
    .all<{ revoked_at: number | null }>();
  if (result.results.length === 0) return true; // unknown device = revoked
  return result.results[0].revoked_at !== null;
}

async function revokeDevice(
  db: NonNullable<Env['LUCIKO_DB']>,
  deviceId: string,
): Promise<void> {
  await db
    .prepare('UPDATE devices SET revoked_at = ? WHERE id = ?')
    .bind(Date.now(), deviceId)
    .run();
}

async function touchDevice(
  db: NonNullable<Env['LUCIKO_DB']>,
  deviceId: string,
): Promise<void> {
  await db
    .prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
    .bind(Date.now(), deviceId)
    .run();
}

// --- Auth helpers ---

async function requireBearerAuth(
  request: Request,
  env: Env,
): Promise<{ authenticated: true; deviceId: string } | { authenticated: false; response: Response }> {
  const secret = env.LUCIKO_BASIC_AUTH_PASSWORD;
  if (!secret) {
    return { authenticated: false, response: json({ error: 'Server not configured' }, { status: 500 }) };
  }

  const token = extractBearerToken(request);
  if (!token) {
    return { authenticated: false, response: json({ authenticated: false }, { status: 401 }) };
  }

  const result = await verifyToken(token, secret);
  if (!result.valid || !result.deviceId) {
    return { authenticated: false, response: json({ authenticated: false }, { status: 401 }) };
  }

  // Check device revocation in D1
  if (env.LUCIKO_DB) {
    const revoked = await isDeviceRevoked(env.LUCIKO_DB, result.deviceId);
    if (revoked) {
      return { authenticated: false, response: json({ authenticated: false }, { status: 401 }) };
    }
    // Update last_seen_at (fire-and-forget)
    void touchDevice(env.LUCIKO_DB, result.deviceId);
  }

  return { authenticated: true, deviceId: result.deviceId };
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      // POST /api/auth/login — Basic Auth → Bearer token + device registration
      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        if (!basicAuthValid(request, env)) {
          return json({ ok: false, error: 'Invalid credentials' }, { status: 401 });
        }

        const deviceId = crypto.randomUUID();
        const userAgent = request.headers.get('User-Agent') || 'unknown';
        const token = await createAuthToken(env.LUCIKO_BASIC_AUTH_PASSWORD!, deviceId);

        if (env.LUCIKO_DB) {
          try {
            await registerDevice(env.LUCIKO_DB, deviceId, userAgent);
          } catch (err) {
            console.error('Failed to register device:', err);
          }
        }

        return json({ ok: true, token, device_id: deviceId });
      }

      // GET /api/auth/status — validate Bearer token
      if (url.pathname === '/api/auth/status' && request.method === 'GET') {
        const auth = await requireBearerAuth(request, env);
        if (!auth.authenticated) return auth.response;
        return json({ authenticated: true, device_id: auth.deviceId });
      }

      // POST /api/auth/logout — revoke device
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        const auth = await requireBearerAuth(request, env);
        if (!auth.authenticated) return auth.response;

        if (env.LUCIKO_DB) {
          try {
            await revokeDevice(env.LUCIKO_DB, auth.deviceId);
          } catch (err) {
            console.error('Failed to revoke device:', err);
          }
        }

        return json({ ok: true });
      }

      // GET /api/health — requires Bearer auth
      if (url.pathname === '/api/health' && request.method === 'GET') {
        const auth = await requireBearerAuth(request, env);
        if (!auth.authenticated) return auth.response;

        return json({
          ok: true,
          service: 'luciko',
          mode: 'worker',
          bindings: {
            d1: Boolean(env.LUCIKO_DB),
            r2: Boolean(env.LUCIKO_BUCKET),
          },
        });
      }

      // POST /api/sync/external-ids/exist — Pass 2 dedup: check which externalIds already exist in D1
      if (url.pathname === '/api/sync/external-ids/exist' && request.method === 'POST') {
        const auth = await requireBearerAuth(request, env);
        if (!auth.authenticated) return auth.response;
        if (!env.LUCIKO_DB) return json({ ok: false, error: 'D1 not available' }, { status: 503 });

        const body = await request.json() as { entity: string; ids: string[] };
        if (!['messages', 'posts'].includes(body.entity) || !Array.isArray(body.ids) || body.ids.length === 0) {
          return json({ ok: false, error: 'Invalid request: entity must be messages|posts and ids must be a non-empty array' }, { status: 400 });
        }
        if (body.ids.length > 100) {
          return json({ ok: false, error: 'Too many IDs: maximum batch size is 100 (D1 parameter limit)' }, { status: 400 });
        }

        const table = body.entity === 'messages' ? 'archive_messages' : 'archive_posts';
        // Using json_extract to pull externalId from the JSON payload column.
        // For a single-user archive with thousands of items, the lack of an index is acceptable.
        const placeholders = body.ids.map(() => '?').join(',');
        const query = `SELECT DISTINCT json_extract(payload, '$.externalId') AS eid FROM ${table} WHERE json_extract(payload, '$.externalId') IN (${placeholders})`;

        const result = await env.LUCIKO_DB.prepare(query).bind(...body.ids).all<{ eid: string | null }>();
        const existingIds = result.results.map(r => r.eid).filter(Boolean) as string[];

        return json({ existingIds });
      }

      // POST /api/sync/upload — Upload a chunk of items to D1
      if (url.pathname === '/api/sync/upload' && request.method === 'POST') {
        const auth = await requireBearerAuth(request, env);
        if (!auth.authenticated) return auth.response;
        if (!env.LUCIKO_DB) return json({ ok: false, error: 'D1 not available' }, { status: 503 });

        try {
          const body = await request.json() as {
            entity: string;
            chunkIndex: number;
            totalChunks: number;
            items: Record<string, unknown>[];
          };

          if (!['messages', 'posts'].includes(body.entity) || !Array.isArray(body.items) || body.items.length === 0) {
            return json({ ok: false, error: 'Invalid request' }, { status: 400 });
          }

          const db = env.LUCIKO_DB;
          const now = Date.now();

          // Compute payload hash for archive_chunks dedup tracking
          const payloadStr = JSON.stringify(body.items);
          const encoder = new TextEncoder();
          const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(payloadStr));
          const hashArray = Array.from(new Uint8Array(hashBuffer));
          const payloadHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

          let insertedCount = 0;

          // Insert each item individually
          for (const item of body.items) {
            const itemPayload = JSON.stringify(item);

            try {
              if (body.entity === 'messages') {
                const msg = item as { id: string; chatId: string; timestamp: number | string };
                const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : new Date(msg.timestamp).getTime();

                const result = await db.prepare(
                  `INSERT OR IGNORE INTO archive_messages (id, chat_id, timestamp, payload, updated_at) VALUES (?, ?, ?, ?, ?)`
                ).bind(msg.id, msg.chatId || '', timestamp, itemPayload, now).run() as { meta?: { changes?: number }; changes?: number };
                const changes = result.meta?.changes ?? result.changes ?? 0;
                if (changes > 0) insertedCount++;
              } else {
                const post = item as { id: string; timestamp: number };
                const result = await db.prepare(
                  `INSERT OR IGNORE INTO archive_posts (id, timestamp, payload, updated_at) VALUES (?, ?, ?, ?)`
                ).bind(post.id, post.timestamp, itemPayload, now).run() as { meta?: { changes?: number }; changes?: number };
                const changes = result.meta?.changes ?? result.changes ?? 0;
                if (changes > 0) insertedCount++;
              }
            } catch (itemErr) {
              console.error('Failed to insert item:', itemErr);
              // Skip individual insert failures (e.g., constraint violations)
            }
          }

          // Record chunk metadata
          await db.prepare(
            `INSERT OR REPLACE INTO archive_chunks (entity, chunk_index, payload, item_count, updated_at, payload_hash) VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(body.entity, body.chunkIndex, payloadStr, body.items.length, now, payloadHash).run();

          // Update sync_state
          await db.prepare(
            `INSERT OR REPLACE INTO sync_state (id, value, updated_at) VALUES ('last_upload_at', ?, ?)`
          ).bind(String(now), now).run();

          return json({ ok: true, inserted: insertedCount, chunkHash: payloadHash });
        } catch (err) {
          console.error('[upload] Upload failed:', err);
          return json(
            { ok: false, error: err instanceof Error ? err.message : 'Upload failed' },
            { status: 500 },
          );
        }
      }

      // GET /api/sync/pull — Download new items from D1 since a given cursor
      if (url.pathname === '/api/sync/pull' && request.method === 'GET') {
        const auth = await requireBearerAuth(request, env);
        if (!auth.authenticated) return auth.response;
        if (!env.LUCIKO_DB) return json({ ok: false, error: 'D1 not available' }, { status: 503 });

        try {
          const entity = url.searchParams.get('entity');
          if (entity !== 'messages' && entity !== 'posts') {
            return json({ ok: false, error: 'entity must be messages or posts' }, { status: 400 });
          }

          const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
          const sinceId = url.searchParams.get('sinceId') || '';
          const chatId = url.searchParams.get('chatId') || '';
          const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 500);

          if (entity === 'messages' && !chatId) {
            return json({ ok: false, error: 'chatId is required for messages' }, { status: 400 });
          }

          const db = env.LUCIKO_DB;
          const table = entity === 'messages' ? 'archive_messages' : 'archive_posts';

          // Composite cursor (updated_at, id) avoids skipping items that share
          // the same updated_at value — a classic keyset pagination bug.
          let query: string;
          let bindValues: unknown[];

          if (entity === 'messages') {
            if (sinceId) {
              query = `SELECT payload, updated_at, id FROM ${table} WHERE chat_id = ? AND (updated_at > ? OR (updated_at = ? AND id > ?)) ORDER BY updated_at ASC, id ASC LIMIT ?`;
              bindValues = [chatId, since, since, sinceId, limit + 1];
            } else {
              query = `SELECT payload, updated_at, id FROM ${table} WHERE chat_id = ? AND updated_at >= ? ORDER BY updated_at ASC, id ASC LIMIT ?`;
              bindValues = [chatId, since, limit + 1];
            }
          } else {
            if (sinceId) {
              query = `SELECT payload, updated_at, id FROM ${table} WHERE (updated_at > ? OR (updated_at = ? AND id > ?)) ORDER BY updated_at ASC, id ASC LIMIT ?`;
              bindValues = [since, since, sinceId, limit + 1];
            } else {
              query = `SELECT payload, updated_at, id FROM ${table} WHERE updated_at >= ? ORDER BY updated_at ASC, id ASC LIMIT ?`;
              bindValues = [since, limit + 1];
            }
          }

          const result = await db.prepare(query).bind(...bindValues).all<{ payload: string; updated_at: number; id: string }>();

          const rows = result.results;
          const hasMore = rows.length > limit;
          const items = rows.slice(0, limit).map(r => {
            try {
              return JSON.parse(r.payload) as Record<string, unknown>;
            } catch {
              return null;
            }
          }).filter(Boolean);

          const lastRow = rows.length > 0 ? rows[Math.min(items.length, rows.length) - 1] : null;
          const nextSince = lastRow ? lastRow.updated_at : since;
          const nextSinceId = lastRow ? lastRow.id : sinceId;

          return json({ ok: true, items, hasMore, nextSince, nextSinceId });
        } catch (err) {
          console.error('[pull] Pull failed:', err);
          return json(
            { ok: false, error: err instanceof Error ? err.message : 'Pull failed' },
            { status: 500 },
          );
        }
      }

      // GET /api/sync/counts — Return total counts from remote D1
      if (url.pathname === '/api/sync/counts' && request.method === 'GET') {
        const auth = await requireBearerAuth(request, env);
        if (!auth.authenticated) return auth.response;
        if (!env.LUCIKO_DB) return json({ ok: false, error: 'D1 not available' }, { status: 503 });

        try {
          const chatId = url.searchParams.get('chatId') || '';
          const db = env.LUCIKO_DB;

          let messages = 0;
          let posts = 0;

          if (chatId) {
            const msgResult = await db.prepare(
              'SELECT COUNT(*) AS cnt FROM archive_messages WHERE chat_id = ?'
            ).bind(chatId).all<{ cnt: number }>();
            messages = msgResult.results[0]?.cnt ?? 0;
          }

          const postResult = await db.prepare(
            'SELECT COUNT(*) AS cnt FROM archive_posts'
          ).all<{ cnt: number }>();
          posts = postResult.results[0]?.cnt ?? 0;

          return json({ ok: true, messages, posts });
        } catch (err) {
          console.error('[counts] Query failed:', err);
          return json(
            { ok: false, error: err instanceof Error ? err.message : 'Count query failed' },
            { status: 500 },
          );
        }
      }

      // All other routes: serve static assets (no auth gate — SPA handles auth on client)
      return env.ASSETS.fetch(request);
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
