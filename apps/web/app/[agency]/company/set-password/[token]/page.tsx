'use client';

import { useAgencyHref } from '../../../../../lib/agency';
import { isValidPassword } from '@bigtours/shared';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { contactApi } from '../../../../../lib/admin-api';
import { a } from '../../../../../messages/admin';

export default function ContactSetPassword() {
  const agencyHref = useAgencyHref();
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<{ name: string; companyName: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [done, setDone] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { contactApi.lookupLink(token).then(setInfo).catch(() => setInvalid(true)); }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidPassword(password)) { setError(a.c.passwordRule); return; }
    if (password !== confirm) { setError(a.c.passwordMismatch); return; }
    setBusy(true); setError(null);
    try {
      await contactApi.setPassword(token, password);
      setDone(true);
    } catch {
      setInvalid(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="admin-login">
      <div className="block auth-form">
        <h1>{a.c.setPasswordTitle}</h1>
        {invalid ? <p className="error" role="alert">{a.c.linkInvalid}</p>
          : done ? (<><p role="status">{a.c.passwordDone}</p><a className="primary wide" href={agencyHref('/admin')}>{a.c.goLogin}</a></>)
          : !info ? <p aria-busy="true">{a.loading}</p>
          : (
            <form onSubmit={submit}>
              <p className="muted">{a.c.setPasswordHint(info.name, info.companyName)}</p>
              {error && <p className="error" role="alert">{error}</p>}
              <label className="field"><span>{a.c.newPassword}</span><input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} /><small>{a.c.passwordRule}</small></label>
              <label className="field"><span>{a.c.confirmPassword}</span><input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
              <button type="submit" className="primary wide" disabled={busy}>{a.c.savePassword}</button>
            </form>
          )}
      </div>
    </main>
  );
}
