'use client';

import { isValidPassword } from '@bigtours/shared';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, createClient, type PasswordLink } from '../../../../lib/api';
import { t } from '../../../../messages/zh-TW';
import { brandStyle } from '../../../../lib/brand';

export function SetPasswordFlow({ slug, token }: { slug: string; token: string }) {
  const api = useMemo(() => createClient(slug), [slug]);
  const [link, setLink] = useState<PasswordLink | null>(null);
  const [view, setView] = useState<'loading' | 'invalid' | 'failed' | 'form'>('loading');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [employeeNo, setEmployeeNo] = useState<string | null>(null);
  const [lineUrl, setLineUrl] = useState<string | null>(null);

  useEffect(() => {
    api.lookupPasswordLink(token).then((l) => { setLink(l); setView('form'); }).catch((e) => {
      setView(e instanceof ApiError && (e.code === 'LINK_INVALID' || e.status === 404) ? 'invalid' : 'failed');
    });
  }, [api, token]);

  if (view === 'loading') return <main className="center-note" aria-busy="true"><p>{t.loading}</p></main>;
  if (view === 'failed') return <main className="center-note"><p role="alert">{t.loadFailed}</p></main>;
  if (view === 'invalid' || !link) {
    return (
      <main className="center-note">
        <h1>{t.linkInvalidTitle}</h1>
        <p>{t.linkInvalidHint}</p>
        <p className="muted">{t.linkInvalidLogin}</p>
        <a className="primary-link" href={`/${encodeURIComponent(slug)}`}>{t.goLogin}</a>
      </main>
    );
  }

  const brand = brandStyle(link.event.themeColor);
  if (employeeNo) return <div style={brand}><PasswordDone slug={slug} agency={link.agency.name} employeeNo={employeeNo} lineUrl={lineUrl} /></div>;

  const ruleBroken = checked && !isValidPassword(password);
  const mismatch = checked && !ruleBroken && password !== confirm;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setChecked(true); setError(null);
    if (!isValidPassword(password) || password !== confirm) return;
    setBusy(true);
    try {
      const done = await api.setPassword(token, password);
      setLineUrl(done.lineUrl);
      setEmployeeNo(done.employeeNo);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'LINK_INVALID') setView('invalid');
      else setError(t.errors[err instanceof ApiError ? err.code : 'fallback'] ?? t.errors.fallback!);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={brand}>
      <header className="masthead">
        <p className="agency">{link.agency.name}</p>
        <h1>{t.setPasswordTitle(link.employee.name)}</h1>
        <p className="who">{t.setPasswordEvent(link.event.name)}</p>
      </header>
      <main className="page">
        <form className="block auth-form" onSubmit={submit} noValidate>
          {error && <p className="error" role="alert">{error}</p>}
          <label className={`field${ruleBroken ? ' invalid' : ''}`}>
            <span>{t.password}</span>
            <input type={show ? 'text' : 'password'} autoComplete="new-password" value={password} aria-invalid={ruleBroken} onChange={(e) => setPassword(e.target.value)} />
            {ruleBroken ? <small className="error">{t.passwordRuleError} {t.passwordRule}</small> : <small>{t.passwordRule}</small>}
          </label>
          <label className={`field${mismatch ? ' invalid' : ''}`}>
            <span>{t.passwordConfirm}</span>
            <input type={show ? 'text' : 'password'} autoComplete="new-password" value={confirm} aria-invalid={mismatch} onChange={(e) => setConfirm(e.target.value)} />
            {mismatch && <small className="error">{t.passwordMismatch}</small>}
          </label>
          <button type="button" className="link password-toggle" onClick={() => setShow(!show)}>{show ? t.hidePassword : t.showPassword}</button>
          <button type="submit" className="primary wide" disabled={busy}>{busy ? t.settingPassword : t.setPasswordSubmit}</button>
        </form>
      </main>
    </div>
  );
}

function PasswordDone({ slug, agency, employeeNo, lineUrl }: { slug: string; agency: string; employeeNo: string; lineUrl: string | null }) {
  const [copied, setCopied] = useState(false);
  const path = `/${encodeURIComponent(slug)}`;
  const copy = () => navigator.clipboard?.writeText(employeeNo).then(() => setCopied(true)).catch(() => undefined);
  return (
    <>
      <header className="masthead">
        <p className="agency">{agency}</p>
        <h1>{t.passwordDoneTitle}</h1>
        <p className="who">{t.passwordDoneHint}</p>
      </header>
      <main className="page">
        <section className="block account-no">
          <div>
            <p className="muted">{t.yourAccount}</p>
            <strong>{employeeNo}</strong>
          </div>
          <button type="button" className="ghost" onClick={copy}>{copied ? t.copied : t.copy}</button>
        </section>
        <section className="block">
          <h2>{t.site}</h2>
          <a className="site-link" href={path}>{typeof window === 'undefined' ? path : `${window.location.host}${path}`}</a>
          <p className="muted">{t.siteHint}</p>
        </section>
        {lineUrl && (
          <section className="block">
            <h2>{t.line.openWithLine}</h2>
            <a className="primary-link" href={lineUrl}>{t.line.openWithLine}</a>
            <p className="muted">{t.line.openWithLineHint}</p>
          </section>
        )}
      </main>
    </>
  );
}
