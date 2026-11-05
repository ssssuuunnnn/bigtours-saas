'use client';

import { can } from '@bigtours/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { adminApi, type AdminCompany, type QuotaTier } from '../../../../lib/admin-api';
import { a } from '../../../../messages/admin';
import { adminError, useAdminMe } from '../../admin-shell';

export default function NewEventPage() {
  return <Suspense><NewEvent /></Suspense>;
}

/** 網址帶 from 時是複製該活動。 */
function NewEvent() {
  const from = useSearchParams().get('from');
  const me = useAdminMe();
  const router = useRouter();
  const allowed = can(me.user.role, 'configureEvents');
  const [companies, setCompanies] = useState<AdminCompany[] | null>(null);
  const [quota, setQuota] = useState<QuotaTier[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [tierId, setTierId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!allowed) return;
    Promise.all([adminApi.companies(), adminApi.quota()]).then(([c, q]) => {
      setCompanies(c);
      setQuota(q);
      setCompanyId(c[0]?.id ?? '');
      setTierId(q.find((t) => t.remaining > 0)?.id ?? '');
    }).catch((e) => setError(adminError(e)));
    if (from) adminApi.event(from).then((e) => setName(e.name)).catch((e) => setError(adminError(e)));
  }, [allowed, from]);

  if (!allowed) return <main className="admin-main"><p role="alert" className="error">{a.forbidden}</p></main>;
  if (!companies) return <main className="admin-main" aria-busy="true">{error ? <p role="alert" className="error">{error}</p> : <p>{a.loading}</p>}</main>;

  const tier = quota.find((t) => t.id === tierId);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const values = { companyId, name, slug, pricingTierId: tierId };
      const { id } = await (from ? adminApi.copyEvent(from, values) : adminApi.createEvent(values));
      router.push(`/admin/events/${id}/basic`);
    } catch (err) {
      setError(adminError(err));
      setBusy(false);
    }
  };

  return (
    <main className="admin-main">
      <h1>{from ? a.copyEventTitle : a.createEvent}</h1>
      {from && <div className="admin-note"><p>{a.copyCarried}</p><p>{a.copyNotCarried}</p></div>}
      {companies.length === 0 ? (
        <p className="admin-note">{a.needCompany} <Link href="/admin/companies">{a.agencySections.companies}</Link></p>
      ) : (
        <form className="admin-form" onSubmit={submit}>
          {error && <p className="error span-3" role="alert">{error}</p>}
          <label className="field">
            <span>{a.company}</span>
            <select required value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="field"><span>{a.eventName}</span><input type="text" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field">
            <span>{a.slug}</span>
            <input type="text" required minLength={2} maxLength={50} pattern="[A-Za-z0-9]([A-Za-z0-9\-]*[A-Za-z0-9])?" title={a.slugRule} value={slug} onChange={(e) => setSlug(e.target.value)} aria-describedby="slug-hint" />
            <small id="slug-hint" className="muted">{a.slugRule}</small>
          </label>
          <fieldset className="span-3">
            <legend>{a.tier}</legend>
            <div className="admin-tiers">
              {quota.map((t) => (
                <label key={t.id} className={`choice${t.id === tierId ? ' on' : ''}`}>
                  <input type="radio" name="tier" value={t.id} checked={t.id === tierId} disabled={t.remaining < 1} onChange={() => setTierId(t.id)} />
                  <span>{a.tierRange(t.minTravelers, t.maxTravelers)}<br /><small className="muted">${t.price.toLocaleString()}・{t.remaining > 0 ? a.quotaLeft(t.remaining) : a.quotaEmpty}</small></span>
                </label>
              ))}
            </div>
          </fieldset>
          {tier && <p className="admin-note span-3">{a.quotaDeduct(a.tierRange(tier.minTravelers, tier.maxTravelers))}</p>}
          <div className="admin-form-actions span-3">
            <button type="submit" className="primary" disabled={busy || !tierId}>{from ? a.copyAndContinue : a.createAndContinue}</button>
            <Link className="ghost-link" href="/admin">{a.cancel}</Link>
          </div>
        </form>
      )}
    </main>
  );
}
