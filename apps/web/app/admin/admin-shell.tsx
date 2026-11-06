'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError } from '../../lib/api';
import { adminApi, contactApi, type AdminMe } from '../../lib/admin-api';
import { a } from '../../messages/admin';
import { Sidebar } from './sidebar';

export const adminError = (e: unknown) => a.errors[e instanceof ApiError ? e.code : 'fallback'] ?? a.errors.fallback!;

const MeContext = createContext<AdminMe | null>(null);

/** 只能在 AdminShell 內使用：登入完成後才會渲染內容。 */
export function useAdminMe() {
  const me = useContext(MeContext);
  if (!me) throw new Error('useAdminMe 必須在 AdminShell 內使用');
  return me;
}

/** 共用外框：確認登入狀態，未登入時顯示登入表單；登入後顯示左側選單。 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [view, setView] = useState<'loading' | 'login' | 'ready' | 'failed'>('loading');

  const load = useCallback(() => {
    adminApi.me().then((m) => { setMe(m); setView('ready'); }).catch((e) => {
      if (!(e instanceof ApiError && e.status === 401)) { setView('failed'); return; }
      // 企業窗口共用這個登入頁，登入後到自己的後台。
      contactApi.me().then(() => window.location.replace('/company')).catch(() => setView('login'));
    });
  }, []);
  useEffect(load, [load]);

  if (view === 'loading') return <main className="center-note" aria-busy="true"><p>{a.loading}</p></main>;
  if (view === 'failed') return <main className="center-note"><p role="alert">{a.loadFailed}</p></main>;
  if (view === 'login' || !me) return <AdminLogin onDone={load} />;
  return (
    <MeContext.Provider value={me}>
      <div className="admin">
        <Sidebar
          me={me}
          onPinned={(pinnedNavItems) => setMe({ ...me, pinnedNavItems })}
          onLogout={() => adminApi.logout().finally(() => { setMe(null); setView('login'); })}
        />
        {children}
      </div>
    </MeContext.Provider>
  );
}

function AdminLogin({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await adminApi.login(email, password);
      onDone();
    } catch {
      setError(a.loginFailed);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="admin-login">
      <form className="block auth-form" onSubmit={submit}>
        <h1>{a.title}</h1>
        {error && <p className="error" role="alert">{error}</p>}
        <label className="field"><span>{a.email}</span><input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field"><span>{a.password}</span><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <button type="submit" className="primary wide" disabled={busy}>{busy ? a.loggingIn : a.login}</button>
      </form>
    </main>
  );
}

export function MoveButtons({ name, canUp, canDown, onUp, onDown }: { name: string; canUp: boolean; canDown: boolean; onUp: () => void; onDown: () => void }) {
  return (
    <span className="move">
      <button type="button" aria-label={a.moveUp(name)} disabled={!canUp} onClick={onUp}>▲</button>
      <button type="button" aria-label={a.moveDown(name)} disabled={!canDown} onClick={onDown}>▼</button>
    </span>
  );
}

/** 交換相鄰兩項後的 ID 順序。 */
export const swapped = <T,>(list: T[], i: number, j: number) => {
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};
