/**
 * Login screen — password-only authentication form.
 *
 * The username is fixed to `"luciko"` and displayed as a read-only field.
 * Only the password is collected. On submit, calls the {@link useAuth}
 * `login` function which exchanges Basic Auth credentials for a Bearer token
 * via `POST /api/auth/login`.
 *
 * States:
 * - **Idle** — empty password field with autofocus.
 * - **Loading** — "Signing in..." with disabled submit button.
 * - **Error** — "Invalid credentials" message, password cleared.
 *
 * @module LoginScreen
 */

import { useState, type FormEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import styles from './LoginScreen.module.css';

/**
 * Login form component.
 *
 * Renders a centered login form with a fixed username, password input,
 * and sign-in button. Handles loading and error states.
 */
export function LoginScreen() {
  const { login } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;

    setError('');
    setLoading(true);

    try {
      await login('luciko', password);
    } catch {
      setError('Invalid credentials');
      setPassword('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <form onSubmit={handleSubmit} className={styles.form}>
        <h1 className={styles.title}>Luciko</h1>
        <p className={styles.subtitle}>Sign in to access your archive</p>

        <div className={styles.field}>
          <label htmlFor="username" className={styles.label}>Username</label>
          <input
            id="username"
            type="text"
            value="luciko"
            readOnly
            className={styles.input}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="password" className={styles.label}>Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            autoFocus
            className={styles.input}
          />
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <button type="submit" disabled={loading || !password.trim()} className={styles.button}>
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
