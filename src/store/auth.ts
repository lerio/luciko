export async function checkAuthStatus(): Promise<boolean> {
  try {
    const response = await fetch('/api/auth/status');
    if (!response.ok) return false;
    const data = (await response.json()) as { authenticated?: boolean };
    return data.authenticated === true;
  } catch {
    return false;
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    // Logout is best-effort; the cookie will expire naturally regardless
  }
}
