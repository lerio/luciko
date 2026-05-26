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
const AUTH_COOKIE = 'luciko_auth';
const COOKIE_MAX_AGE = 31536000; // 1 year

function parseCookies(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq >= 0) {
      result[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  return result;
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

async function createAuthToken(secret: string): Promise<string> {
  const payload = JSON.stringify({ u: 'luciko', ts: Date.now() });
  const payloadB64 = btoa(payload);
  const sig = await signToken(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

async function verifyToken(token: string, secret: string): Promise<boolean> {
  const idx = token.lastIndexOf('.');
  if (idx < 0) return false;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expectedSig = await signToken(payload, secret);
  return timingSafeEqual(sig, expectedSig);
}

function setAuthCookie(response: Response, token: string): Response {
  const headers = new Headers(response.headers);
  headers.set(
    'Set-Cookie',
    `${AUTH_COOKIE}=${token}; Path=/; SameSite=Lax; Secure; Max-Age=${COOKIE_MAX_AGE}`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function clearAuthCookie(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Set-Cookie', `${AUTH_COOKIE}=; Path=/; SameSite=Lax; Secure; Max-Age=0`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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

async function checkAuth(
  request: Request,
  env: Env,
): Promise<{ authenticated: boolean; newToken?: string }> {
  const secret = env.LUCIKO_BASIC_AUTH_PASSWORD;
  if (!secret) return { authenticated: false };

  // 1. Check signed cookie
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = parseCookies(cookieHeader);
  const cookieToken = cookies[AUTH_COOKIE];
  if (cookieToken && (await verifyToken(cookieToken, secret))) {
    return { authenticated: true };
  }

  // 2. Check Bearer token header
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7);
    if (await verifyToken(bearerToken, secret)) {
      return { authenticated: true };
    }
  }

  // 3. Fall back to Basic Auth
  if (isAuthenticated(request, env)) {
    const newToken = await createAuthToken(secret);
    return { authenticated: true, newToken };
  }

  return { authenticated: false };
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

      // Logout — clears auth cookie, no auth required
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        return clearAuthCookie(json({ ok: true }));
      }

      // Auth status — returns whether the request is authenticated without triggering browser dialog
      if (url.pathname === '/api/auth/status' && request.method === 'GET') {
        const statusAuth = await checkAuth(request, env);
        if (!statusAuth.authenticated) {
          return json({ authenticated: false }, { status: 401 });
        }
        const statusResponse = json({ authenticated: true });
        if (statusAuth.newToken) {
          return setAuthCookie(statusResponse, statusAuth.newToken);
        }
        return statusResponse;
      }

      // Auth gate for all other routes
      const auth = await checkAuth(request, env);
      if (!auth.authenticated) {
        return authChallenge();
      }

      // Attach auth cookie to successful responses when Basic Auth was just used
      const respond = (res: Response) =>
        auth.newToken ? setAuthCookie(res, auth.newToken) : res;

      if (url.pathname === '/api/health' && request.method === 'GET') {
        return respond(json({
          ok: true,
          service: 'luciko',
          mode: 'worker',
          bindings: {
            d1: Boolean(env.LUCIKO_DB),
            r2: Boolean(env.LUCIKO_BUCKET),
          },
        }));
      }

      return respond(await env.ASSETS.fetch(request));
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
