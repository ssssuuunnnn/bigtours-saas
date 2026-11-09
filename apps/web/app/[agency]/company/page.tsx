'use client';

import { AgencyLink as Link } from '../../../lib/agency';
import { useEffect, useState } from 'react';
import { contactApi, type ContactEvent } from '../../../lib/admin-api';
import { a } from '../../../messages/admin';
import { adminError } from '../admin/admin-shell';
import { useContactMe } from './contact-shell';

export const shortDate = (iso: string) => new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

export default function ContactEventsPage() {
  const me = useContactMe();
  const [events, setEvents] = useState<ContactEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { contactApi.events().then(setEvents).catch((e) => setError(adminError(e))); }, []);
  return (
    <main className="admin-main">
      <h1>{a.c.events}</h1>
      <section className="admin-panel">
        <p className="muted">{a.c.eventsHint(me.companyName, me.agencyName)}</p>
        {error && <p className="error" role="alert">{error}</p>}
        {!events && !error && <p aria-busy="true">{a.loading}</p>}
        {events?.length === 0 && <p className="muted">{a.c.noEvents}</p>}
        {!!events?.length && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th scope="col">{a.c.cols.event}</th><th scope="col">{a.c.cols.state}</th><th scope="col">{a.c.cols.period}</th><th scope="col">{a.c.cols.progress}</th><th scope="col">{a.c.cols.go}</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td><Link href={`/company/events/${e.id}/overview`}><strong>{e.name}</strong></Link><br /><small className="muted">{e.firstDay ? `${e.firstDay}～${e.lastDay}，` : ''}{a.c.sessions(e.sessionCount)}</small></td>
                    <td>{a.c.states[e.state]}</td>
                    <td>{e.registrationClosesAt ? a.c.closesAt(shortDate(e.registrationClosesAt)) : '—'}</td>
                    <td className="admin-nowrap">{a.c.progress(e.registered, e.roster)}</td>
                    <td><Link href={`/company/events/${e.id}/roster`}>{a.c.nav.roster}</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
