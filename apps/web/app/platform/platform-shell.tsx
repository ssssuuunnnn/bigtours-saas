'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError } from '../../lib/api';
import { platformApi } from '../../lib/admin-api';
import { p } from '../../messages/platform';
import { DoneToast } from '../../lib/done-toast';

export const platformError = (e: unknown) => p.errors[e instanceof ApiError ? e.code : 'fallback'] ?? p.errors.fallback!;

type Me = { user: { id: string; name: string }; domain: string };
const MeContext = createContext<Me | null>(null);
export const usePlatformMe = () => {
  const me = useContext(MeContext);
  if (!me) throw new Error('usePlatformMe 必須在 PlatformShell 內使用');
  return me;
};

export function PlatformShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<'loading' | 'login' | 'ready' | 'denied'>('loading');
  const load = useCallback(() => {
    platformApi.me().then((m) => { setMe(m); setView('ready'); }).catch((e) => {
      setView(e instanceof ApiError && e.status === 401 ? 'login' : 'denied');
    });
  }, []);
  useEffect(load, [load]);

  if (view === 'loading') return <main className="center-note" aria-busy="true"><p>{p.loading}</p></main>;
  if (view === 'denied') return <main className="center-note"><p role="alert">{p.errors.NOT_FOUND}</p></main>;
  if (view === 'login' || !me) return <PlatformLogin onDone={load} />;
  const usage = pathname.startsWith('/platform/usage');
  const applications = pathname.startsWith('/platform/applications');
  return (
    <MeContext.Provider value={me}>
      <div className="admin">
        <aside className="admin-side">
          <Link href="/platform" className="admin-brand">{p.brand}</Link>
          <nav aria-label={p.brand} className="admin-nav">
            <Link href="/platform" className="admin-nav-link" aria-current={!usage && !applications ? 'page' : undefined}>{p.nav.agencies}</Link>
            <Link href="/platform/applications" className="admin-nav-link" aria-current={applications ? 'page' : undefined}>{p.nav.applications}</Link>
            <Link href="/platform/usage" className="admin-nav-link" aria-current={usage ? 'page' : undefined}>{p.nav.usage}</Link>
          </nav>
          <div className="admin-side-foot">
            <span><strong>{me.user.name}</strong><br />{p.role}</span>
            <button type="button" className="link" onClick={() => { void platformApi.logout().finally(() => { setMe(null); setView('login'); }); }}>{p.logout}</button>
          </div>
        </aside>
        {children}
        <DoneToast />
      </div>
    </MeContext.Provider>
  );
}

function PlatformLogin({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await platformApi.login(email, password);
      onDone();
    } catch {
      setError(p.loginFailed);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="admin-login">
      <form className="block auth-form" onSubmit={submit}>
        <small className="muted">{p.brand}</small>
        <h1>{p.loginTitle}</h1>
        {error && <p className="error" role="alert">{error}</p>}
        <label className="field"><span>{p.email}</span><input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field"><span>{p.password}</span><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <button type="submit" className="primary wide" disabled={busy}>{busy ? p.loggingIn : p.login}</button>
        <small className="muted">{p.loginHint}</small>
      </form>
    </main>
  );
}
