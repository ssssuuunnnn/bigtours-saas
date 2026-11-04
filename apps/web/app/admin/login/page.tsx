'use client';

import { useState } from 'react';
import { adminFetch, errorMessage } from '../../../lib/admin-api';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminFetch('POST', '/auth/login', { email, password });
      window.location.href = '/admin';
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-box" onSubmit={submit}>
        <h1>登入旅行社後台</h1>
        <label className="lab">Email<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="lab">密碼<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <p className="msg-error" role="alert">{error}</p>}
        <button className="btn main" disabled={busy} type="submit">登入</button>
      </form>
    </div>
  );
}
