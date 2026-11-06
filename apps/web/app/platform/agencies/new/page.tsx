'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { platformApi } from '../../../../lib/admin-api';
import { p } from '../../../../messages/platform';
import { platformError, usePlatformMe } from '../../platform-shell';

export default function PlatformCreateAgency() {
  const me = usePlatformMe();
  const router = useRouter();
  const [v, setV] = useState({ name: '', code: '', adminName: '', adminEmail: '', planNote: '', contractStartsOn: '', contractEndsOn: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = (key: keyof typeof v) => ({ value: v[key], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [key]: e.target.value }) });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await platformApi.create(v);
      router.push(`/platform/agencies/${r.id}?created=${r.mailFailed ? 'mail_failed' : 'ok'}`);
    } catch (err) {
      setError(platformError(err));
      setBusy(false);
    }
  };
  return (
    <main className="admin-main">
      <h1>{p.createAgency}</h1>
      <section className="admin-panel">
        <p className="muted">{p.createHint}</p>
        {error && <p className="error" role="alert">{error}</p>}
        <form className="admin-reg-col" onSubmit={submit}>
          <fieldset className="admin-card">
            <legend className="sr-only">{p.sectionAgency}</legend>
            <h2>{p.sectionAgency}</h2>
            <label className="field"><span>{p.name}</span><input type="text" required maxLength={100} {...field('name')} /></label>
            <label className="field"><span>{p.code}</span><input type="text" required pattern="[a-z0-9][a-z0-9\-]{1,28}[a-z0-9]" maxLength={30} {...field('code')} /><small>{p.codeHint(v.code, me.domain)}</small></label>
          </fieldset>
          <fieldset className="admin-card">
            <legend className="sr-only">{p.sectionAdmin}</legend>
            <h2>{p.sectionAdmin}</h2>
            <label className="field"><span>{p.adminName}</span><input type="text" required maxLength={100} {...field('adminName')} /></label>
            <label className="field"><span>{p.adminEmail}</span><input type="email" required maxLength={254} {...field('adminEmail')} /></label>
          </fieldset>
          <fieldset className="admin-card">
            <legend className="sr-only">{p.sectionContract}</legend>
            <h2>{p.sectionContract}</h2>
            <label className="field"><span>{p.planNote}</span><input type="text" required maxLength={200} {...field('planNote')} /></label>
            <label className="field"><span>{p.startsOn}</span><input type="date" required {...field('contractStartsOn')} /></label>
            <label className="field"><span>{p.endsOn}</span><input type="date" required min={v.contractStartsOn || undefined} {...field('contractEndsOn')} /></label>
            <small className="muted">{p.quotaLater}</small>
          </fieldset>
          <div className="admin-form-actions">
            <Link className="ghost-link" href="/platform">{p.cancel}</Link>
            <button type="submit" className="primary" disabled={busy}>{busy ? p.saving : p.createSubmit}</button>
          </div>
        </form>
      </section>
    </main>
  );
}
