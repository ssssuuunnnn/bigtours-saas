'use client';

import { can } from '@bigtours/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { adminApi, type AdminEvent, type EventOverview } from '../../../../lib/admin-api';
import { a } from '../../../../messages/admin';
import { adminError, useAdminMe } from '../../admin-shell';

const when = (iso: string) => new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

export function OverviewPanel({ event }: { event: AdminEvent }) {
  const me = useAdminMe();
  const [data, setData] = useState<EventOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { adminApi.overview(event.id).then(setData).catch((e) => setError(adminError(e))); }, [event.id]);
  if (!data) return error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>;

  const base = `/admin/events/${event.id}`;
  const running = data.status === 'published' && data.registrationClosesAt && new Date(data.registrationClosesAt) > new Date();
  return (
    <section className="admin-panel">
      <p className="muted">{running ? a.overviewOpen(when(data.registrationClosesAt!)) : a.overviewStates[data.status]}</p>
      <div className="admin-stat-cards">
        <div>
          <span>{a.overviewProgress}</span>
          <strong>{a.overviewProgressValue(data.registered, data.roster)}</strong>
          {can(me.user.role, 'configureEvents') && <Link href={`${base}/roster?registration=unregistered`}>{a.overviewUnregistered}</Link>}
        </div>
        <div>
          <span>{a.overviewCancels}</span>
          <strong>{a.countOf(data.pendingCancels)}</strong>
          <Link href={`${base}/registrations?status=cancel_requested`}>{a.overviewCancelsAction}</Link>
        </div>
        <div>
          <span>{a.overviewUnpaid}</span>
          <strong>{a.countOf(data.unpaid)}</strong>
          <Link href={`${base}/registrations?payment=unpaid`}>{a.overviewUnpaidAction}</Link>
        </div>
      </div>
      <h2>{a.overviewSeats}</h2>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead><tr><th scope="col">{a.regCols.session}</th><th scope="col">{a.overviewSold}</th><th scope="col">{a.overviewHeld}</th><th scope="col">{a.overviewRemaining}</th><th scope="col">{a.overviewCapacity}</th></tr></thead>
          <tbody>
            {data.sessions.map((s) => (
              <tr key={s.id}><td><strong>{s.name}</strong></td><td>{s.sold}</td><td>{s.held}</td><td>{s.remaining}</td><td>{s.capacity}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">{a.overviewTravelers(data.travelers, data.tierMax)}</p>
    </section>
  );
}
