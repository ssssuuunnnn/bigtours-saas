'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, createClient, type Landing } from '../../../lib/api';
import { formatDateTime, t } from '../../../messages/zh-TW';
import { RegistrationFlow } from './registration-flow';
import { useAgency } from '../../../lib/agency';
import { brandStyle } from '../../../lib/brand';

type View = 'loading' | 'not_found' | 'failed' | 'flow' | 'login' | 'page_closed';

/** 活動網址的入口：依活動頁狀態與登入狀態，顯示關閉頁、登入頁或報名流程。 */
export function EventEntry({ slug }: { slug: string }) {
  const agency = useAgency();
  const api = useMemo(() => createClient(agency, slug), [agency, slug]);
  const [landing, setLanding] = useState<Landing | null>(null);
  const [view, setView] = useState<View>('loading');

  const load = useCallback(() => {
    api.landing().then((l) => {
      setLanding(l);
      setView(l.event.pageState === 'open' ? 'flow' : 'page_closed');
    }).catch((e) => setView(e instanceof ApiError && e.status === 404 ? 'not_found' : 'failed'));
  }, [api]);

  useEffect(load, [load]);

  const onSignedOut = useCallback(() => setView('login'), []);

  if (view === 'loading') return <main className="center-note" aria-busy="true"><p>{t.loading}</p></main>;
  if (view === 'not_found') return <main className="center-note"><h1>{t.notFoundTitle}</h1><p>{t.notFoundHint}</p></main>;
  if (view === 'failed' || !landing) return <main className="center-note"><p role="alert">{t.loadFailed}</p></main>;
  if (view === 'flow') return <RegistrationFlow slug={slug} onSignedOut={onSignedOut} onPageClosed={load} />;
  if (view === 'page_closed') {
    const notYet = landing.event.pageState === 'not_open';
    return (
      <main className="center-note">
        <p className="muted">{landing.agency.name}</p>
        <h1>{notYet ? t.pageNotOpenTitle : t.pageClosedTitle}</h1>
        <p>{notYet ? (landing.event.pageOpensAt ? t.pageNotOpenAt(formatDateTime(landing.event.pageOpensAt)) : t.pageNotOpenHint) : t.pageClosedHint}</p>
      </main>
    );
  }
  return <LoginView slug={slug} landing={landing} onLoggedIn={() => setView('flow')} onPageClosed={load} />;
}

interface LoginCopy { title: string; hint: string; submit: string; busy: string }

/** 密碼登入表單；LINE 第一次綁定也用同一個表單，只換送出方式與文字。 */
export function LoginView({ slug, landing, onLoggedIn, onPageClosed, submitLogin, copy }: {
  slug: string; landing: Landing; onLoggedIn: () => void; onPageClosed: () => void;
  submitLogin?: (employeeNo: string, password: string) => Promise<void>; copy?: LoginCopy;
}) {
  const agencyCode = useAgency();
  const api = useMemo(() => createClient(agencyCode, slug), [agencyCode, slug]);
  const [employeeNo, setEmployeeNo] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await (submitLogin ?? api.login)(employeeNo, password);
      onLoggedIn();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PAGE_CLOSED') { onPageClosed(); return; }
      setError(t.errors[err instanceof ApiError ? err.code : 'fallback'] ?? t.errors.fallback!);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const { event, agency } = landing;
  return (
    <div style={brandStyle(event.themeColor)} className={event.images.login ? 'login-shell' : undefined}>
      {/* 背景圖鋪滿整頁，頁首與登入卡都疊在圖上，不分成兩個區塊。 */}
      {event.images.login && (
        <picture className="login-bg">
          {event.images.loginMobile && <source media="(max-width: 640px)" srcSet={event.images.loginMobile} />}
          <img src={event.images.login} alt="" />
        </picture>
      )}
      <header className="masthead">
        <p className="agency">{agency.name}</p>
        <h1>{event.name}</h1>
        <dl className="entry-dates">
          <div><dt>{t.registrationOpens}</dt><dd>{formatDateTime(event.registrationOpensAt) || t.notSet}</dd></div>
          <div><dt>{t.registrationCloses}</dt><dd>{formatDateTime(event.registrationClosesAt) || t.notSet}</dd></div>
        </dl>
      </header>
      <div className={event.images.login ? 'login-scene' : undefined}>
      <main className="page">
        <form className="block auth-form" onSubmit={submit}>
          <h2>{copy?.title ?? t.loginTitle}</h2>
          {copy && <p>{copy.hint}</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <label className="field">
            <span>{t.account}</span>
            <input type="text" autoComplete="username" required value={employeeNo} onChange={(e) => setEmployeeNo(e.target.value)} />
          </label>
          <label className="field">
            <span>{t.password}</span>
            <input type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button type="button" className="link password-toggle" onClick={() => setShow(!show)}>{show ? t.hidePassword : t.showPassword}</button>
          <button type="submit" className="primary wide" disabled={busy}>{busy ? copy?.busy ?? t.loggingIn : copy?.submit ?? t.login}</button>
          <p className="muted">{t.loginHelp}</p>
        </form>
      </main>
      </div>
    </div>
  );
}
