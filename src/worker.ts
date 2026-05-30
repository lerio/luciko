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
