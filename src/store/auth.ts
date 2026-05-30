const STORAGE_KEY = 'luciko_auth';

interface StoredAuth {
  token: string;
  deviceId: string;
}

export function getStoredAuth(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAuth;
    if (parsed.token && parsed.deviceId) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function setStoredAuth(auth: StoredAuth): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
}

export function clearStoredAuth(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function getAuthHeaders(): Record<string, string> {
  const auth = getStoredAuth();
  if (!auth) return {};
  return { Authorization: `Bearer ${auth.token}` };
}

export async function login(username: string, password: string): Promise<StoredAuth> {
  const credentials = btoa(`${username}:${password}`);
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials}` },
  });

  if (!response.ok) {
    throw new Error('Invalid credentials');
  }

  const data = (await response.json()) as { ok: boolean; token: string; device_id: string };
  return { token: data.token, deviceId: data.device_id };
}

export async function logout(): Promise<void> {
  try {
    const headers = getAuthHeaders();
    await fetch('/api/auth/logout', { method: 'POST', headers });
  } catch {
    // best-effort
  }
  clearStoredAuth();
}
