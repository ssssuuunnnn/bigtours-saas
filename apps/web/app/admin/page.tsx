'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { adminApi, type AdminEventSummary } from '../../lib/admin-api';
import { a } from '../../messages/admin';

export default function EventList() {
  const [events, setEvents] = useState<AdminEventSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { adminApi.events().then(setEvents).catch(() => setFailed(true)); }, []);
  if (failed) return <main className="admin-main"><p role="alert" className="error">{a.loadFailed}</p></main>;
  if (!events) return <main className="admin-main" aria-busy="true"><p>{a.loading}</p></main>;
  return (
    <main className="admin-main">
      <h1>{a.events}</h1>
      {events.length === 0 && <p className="muted">{a.noEvents}</p>}
      <ul className="admin-events">
        {events.map((e) => (
          <li key={e.id}>
            <Link href={`/admin/events/${e.id}`}>
              <strong>{e.name}</strong>
              <span className="muted">{e.companyName}・/{e.slug}・{a.status[e.status] ?? e.status}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
