import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AppLayout } from './components/layout/AppLayout';
import { LoginScreen } from './components/auth/LoginScreen';

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

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
