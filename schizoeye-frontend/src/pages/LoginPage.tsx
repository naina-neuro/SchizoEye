import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { LoginResult } from '../api/auth.ts';

/** Same screen and messages as the original #login-screen. */
export function LoginPage({ onLogin }: { onLogin: (username: string, password: string) => Promise<LoginResult> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pwRef = useRef<HTMLInputElement>(null);

  async function submit() {
    if (busy) return;
    const u = username.trim();
    const p = password.trim();
    setError('');
    if (!u || !p) { setError('Please enter username and password.'); return; }
    setBusy(true);
    const r = await onLogin(u, p);
    setBusy(false);
    if (!r.ok) setError(r.error); // on success the parent swaps this page for the role dashboard
  }

  return (
    <div id="login-screen">
      <div className="login-card">
        <h1>Oculomotor Battery</h1>
        <div className="login-subtitle">Clinical Data Collection System — Secure Login</div>
        <div className="login-field">
          <label htmlFor="login-username">Username</label>
          <input id="login-username" type="text" placeholder="admin / doctor / clinician" autoComplete="username"
            value={username} onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') pwRef.current?.focus(); }} />
        </div>
        <div className="login-field">
          <label htmlFor="login-password">Password</label>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <input id="login-password" ref={pwRef} type={show ? 'text' : 'password'} placeholder="••••••••" autoComplete="current-password"
              style={{ width: '100%', paddingRight: 44 }} value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') void submit(); }} />
            <button type="button" id="toggle-pw" title="Show/hide password" onClick={() => setShow((v) => !v)}
              style={{ position: 'absolute', right: 10, background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, padding: 4, opacity: 0.6, lineHeight: 1 }}>
              {show ? '🙈' : '👁'}
            </button>
          </div>
        </div>
        <div id="login-error">{error}</div>
        <button id="login-btn" onClick={() => void submit()}>Sign In</button>
        <div><span className="login-role-badge" id="login-role-display">Enter credentials to continue</span></div>
      </div>
    </div>
  );
}
