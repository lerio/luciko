import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { getStoredAuth, setStoredAuth, clearStoredAuth, login as apiLogin, logout as apiLogout, getAuthHeaders } from '../store/auth';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthState {
  status: AuthStatus;
  deviceId: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [deviceId, setDeviceId] = useState<string | null>(null);

  // Validate stored token on mount
  useEffect(() => {
    let cancelled = false;

    async function check() {
      const stored = getStoredAuth();
      if (!stored) {
        if (!cancelled) setStatus('unauthenticated');
        return;
      }

      try {
        const response = await fetch('/api/auth/status', {
          headers: { Authorization: `Bearer ${stored.token}` },
        });
        if (!cancelled) {
          if (response.ok) {
            setStatus('authenticated');
            setDeviceId(stored.deviceId);
          } else {
            clearStoredAuth();
            setStatus('unauthenticated');
          }
        }
      } catch {
        if (!cancelled) {
          // Network error — still consider authenticated (offline use)
          setStatus('authenticated');
          setDeviceId(stored.deviceId);
        }
      }
    }

    void check();
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await apiLogin(username, password);
    setStoredAuth(result);
    setStatus('authenticated');
    setDeviceId(result.deviceId);
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    clearStoredAuth();
    setStatus('unauthenticated');
    setDeviceId(null);
  }, []);

  return (
    <AuthContext.Provider value={{ status, deviceId, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

// Standalone helper for non-React code that needs auth headers
export { getAuthHeaders };
