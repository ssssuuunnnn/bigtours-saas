'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { contactApi, type ContactOverview } from '../../../../../lib/admin-api';
import { a } from '../../../../../messages/admin';
import { adminError } from '../../../../admin/admin-shell';
import { useContactMe } from '../../../contact-shell';

const money = (n: number) => `$${n.toLocaleString('en-US')}`;

export function ContactOverviewPanel({ id }: { id: string }) {
  const me = useContactMe();
  const [o, setO] = useState<ContactOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { contactApi.overview(id).then(setO).catch((e) => setError(adminError(e))); }, [id]);
  if (!o) return error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>;
  const base = `/company/events/${id}`;
  return (
    <section className="admin-panel">
      <p className="muted"><strong>{o.name}</strong>・{a.c.states[o.state]}</p>
      <div className="admin-stat-cards">
        <div><span>{a.c.progressTitle}</span><strong>{a.c.progress(o.registered, o.roster)}</strong><Link href={`${base}/roster?registration=unregistered`}>{a.c.viewUnregistered(Math.max(o.roster - o.registered, 0))}</Link></div>
        <div><span>{a.c.accountsTitle}</span><strong>{a.c.progress(o.accountsPending, o.roster).replace(/／\d+/, '')}</strong><Link href={`${base}/roster`}>{a.c.goHandle}</Link></div>
        <div><span>{a.c.subsidyTitle}</span><strong>{money(o.subsidyTotal)}</strong><Link href={`${base}/registrations`}>{a.c.viewRegistrations}</Link></div>
      </div>
      <div className="admin-card">
        <h2>{a.c.bySession}</h2>
        {o.sessions.map((s) => <div key={s.id} className="admin-email-actions"><span>{s.name}{s.departsOn ? ` ${s.departsOn}～${s.returnsOn}` : ''}</span><strong>{a.c.travelersN(s.travelers)}</strong></div>)}
      </div>
      <small className="muted">{a.c.handledBy(me.agencyName)}</small>
    </section>
  );
}
