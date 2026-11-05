'use client';

import { useEffect, useState } from 'react';
import { adminApi, type AdminEvent } from '../../../../lib/admin-api';
import { a } from '../../../../messages/admin';
import { AdminShell } from '../../admin-shell';
import { FieldsPanel } from './fields-panel';
import { SessionsPanel } from './sessions-panel';

export function EventSettings({ id }: { id: string }) {
  return <AdminShell>{() => <Settings id={id} />}</AdminShell>;
}

function Settings({ id }: { id: string }) {
  const [event, setEvent] = useState<AdminEvent | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<'sessions' | 'fields'>('sessions');
  useEffect(() => { adminApi.event(id).then(setEvent).catch(() => setFailed(true)); }, [id]);
  if (failed) return <main className="admin-main"><p role="alert" className="error">{a.loadFailed}</p></main>;
  if (!event) return <main className="admin-main" aria-busy="true"><p>{a.loading}</p></main>;
  return (
    <main className="admin-main">
      <a href="/admin" className="admin-back">{a.backToEvents}</a>
      <h1>{event.name}</h1>
      <div className="admin-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'sessions'} onClick={() => setTab('sessions')}>{a.sessionsTab}</button>
        <button type="button" role="tab" aria-selected={tab === 'fields'} onClick={() => setTab('fields')}>{a.fieldsTab}</button>
      </div>
      {tab === 'sessions' ? <SessionsPanel event={event} /> : <FieldsPanel event={event} />}
    </main>
  );
}
