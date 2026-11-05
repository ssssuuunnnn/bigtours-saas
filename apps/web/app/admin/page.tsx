'use client';

import { can } from '@bigtours/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { adminApi, type AdminEventSummary, type QuotaTier } from '../../lib/admin-api';
import { a } from '../../messages/admin';
import { useAdminMe } from './admin-shell';

const shortDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('zh-TW') : '');

export default function EventList() {
  const me = useAdminMe();
  const canConfigure = can(me.user.role, 'configureEvents');
  const [events, setEvents] = useState<AdminEventSummary[] | null>(null);
  const [quota, setQuota] = useState<QuotaTier[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    adminApi.events().then(setEvents).catch(() => setFailed(true));
    if (canConfigure) adminApi.quota().then(setQuota).catch(() => setFailed(true));
  }, [canConfigure]);
  if (failed) return <main className="admin-main"><p role="alert" className="error">{a.loadFailed}</p></main>;
  if (!events) return <main className="admin-main" aria-busy="true"><p>{a.loading}</p></main>;
  return (
    <main className="admin-main">
      <div className="admin-panel-head">
        <h1>{a.events}</h1>
        {canConfigure && <Link className="primary-link" href="/admin/events/new">{a.createEvent}</Link>}
      </div>
      {canConfigure && quota.some((t) => t.remaining > 0) && (
        <section className="admin-quota" aria-label={a.quotaTitle}>
          {quota.filter((t) => t.remaining > 0).map((t) => <div key={t.id}><span>{a.tierRange(t.minTravelers, t.maxTravelers)}</span><strong>{a.quotaLeft(t.remaining)}</strong></div>)}
        </section>
      )}
      {events.length === 0 ? <p className="muted">{a.noEvents}</p> : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>{a.eventName}</th><th>{a.company}</th><th>{a.eventStatus}</th><th>{a.registrationPeriod}</th><th>{a.travelersOfTier}</th>{canConfigure && <th>{a.actions}</th>}</tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td><Link href={`/admin/events/${e.id}`}>{e.name}</Link><br /><small className="muted">/{e.slug}</small></td>
                  <td>{e.companyName}</td>
                  <td>{a.status[e.status] ?? e.status}</td>
                  <td>{e.registrationOpensAt ? `${shortDate(e.registrationOpensAt)} – ${shortDate(e.registrationClosesAt)}` : a.notSet}</td>
                  <td>{e.travelerCount.toLocaleString()}／{e.tierMax.toLocaleString()}</td>
                  {canConfigure && <td><Link href={`/admin/events/new?from=${e.id}`} aria-label={a.copyEventNamed(e.name)}>{a.copy}</Link></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
