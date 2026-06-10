/**
 * Luciko root application component.
 *
 * Wraps the app in an {@link AuthProvider} and gates rendering on
 * authentication state: shows a loading spinner while checking stored
 * credentials, the {@link LoginScreen} when unauthenticated, or the main
 * {@link AppLayout} once authenticated.
 *
 * @module App
 */

import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AppLayout } from './components/layout/AppLayout';
import { LoginScreen } from './components/auth/LoginScreen';

/**
 * Internal component that reads auth state and decides what to render.
 *
 * Three states:
 * - `loading` — full-screen dark loading indicator while validating stored token.
 * - `unauthenticated` — the login form.
 * - `authenticated` — the main app layout, centered and capped at 1600px.
 */
function AppContent() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100dvh',
        background: '#1a1a2e',
        color: '#888',
        fontFamily: 'system-ui, sans-serif',
      }}>
        Loading...
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return <LoginScreen />;
  }

  return (
    <div style={{ width: '100%', height: '100%', maxWidth: '1600px', margin: '0 auto', boxShadow: '0 0 10px rgba(0,0,0,0.1)' }}>
      <AppLayout />
    </div>
  );
}

/**
 * Top-level application component.
 *
 * Provides the authentication context to the entire component tree so that
 * any descendant can read auth state via {@link useAuth}.
 */
function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
