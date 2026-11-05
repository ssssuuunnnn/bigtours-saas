'use client';

import type { EventNavKey } from '@bigtours/shared';
import { useCallback, useEffect, useState } from 'react';
import { adminApi, type AdminEvent } from '../../../../lib/admin-api';
import { canSeeEventSection } from '../../../../lib/admin-nav';
import { a } from '../../../../messages/admin';
import { useAdminMe } from '../../admin-shell';
import { BasicPanel } from './basic-panel';
import { ContactsPanel } from './contacts-panel';
import { FieldsPanel } from './fields-panel';
import { OptionsPanel } from './options-panel';
import { PaymentTermsPanel } from './payment-terms-panel';
import { PublishPanel } from './publish-panel';
import { RosterPanel } from './roster-panel';
import { SchedulePanel } from './schedule-panel';
import { SessionsPanel } from './sessions-panel';
import { TypesPanel } from './types-panel';

const BUILT: EventNavKey[] = ['basic', 'schedule', 'sessions', 'types', 'options', 'fields', 'payment-terms', 'contacts', 'publish', 'roster'];

export function EventSection({ id, section }: { id: string; section: EventNavKey }) {
  const me = useAdminMe();
  const allowed = canSeeEventSection(me.user.role, section);
  const [event, setEvent] = useState<AdminEvent | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => { adminApi.event(id).then(setEvent).catch(() => setFailed(true)); }, [id]);
  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  if (!allowed) return <main className="admin-main"><p role="alert" className="error">{a.forbidden}</p></main>;
  if (failed) return <main className="admin-main"><p role="alert" className="error">{a.loadFailed}</p></main>;
  if (!event) return <main className="admin-main" aria-busy="true"><p>{a.loading}</p></main>;
  return (
    <main className="admin-main">
      <h1>{a.eventSections[section]}</h1>
      {section === 'basic' && <BasicPanel key={event.slug} event={event} onSaved={load} />}
      {section === 'schedule' && <SchedulePanel event={event} onSaved={load} />}
      {section === 'sessions' && <SessionsPanel event={event} />}
      {section === 'types' && <TypesPanel event={event} />}
      {section === 'options' && <OptionsPanel event={event} />}
      {section === 'fields' && <FieldsPanel event={event} />}
      {section === 'payment-terms' && <PaymentTermsPanel event={event} onSaved={load} />}
      {section === 'contacts' && <ContactsPanel event={event} />}
      {section === 'publish' && <PublishPanel event={event} onPublished={load} />}
      {section === 'roster' && <RosterPanel event={event} />}
      {!BUILT.includes(section) && <p className="muted">{a.comingSoon}</p>}
    </main>
  );
}
