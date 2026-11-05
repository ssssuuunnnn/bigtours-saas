'use client';

import type { EventNavKey } from '@bigtours/shared';
import { useEffect, useState } from 'react';
import { adminApi, type AdminEvent } from '../../../../lib/admin-api';
import { canSeeEventSection } from '../../../../lib/admin-nav';
import { a } from '../../../../messages/admin';
import { useAdminMe } from '../../admin-shell';
import { FieldsPanel } from './fields-panel';
import { SessionsPanel } from './sessions-panel';

export function EventSection({ id, section }: { id: string; section: EventNavKey }) {
  const me = useAdminMe();
  const allowed = canSeeEventSection(me.user.role, section);
  const [event, setEvent] = useState<AdminEvent | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (allowed) adminApi.event(id).then(setEvent).catch(() => setFailed(true));
  }, [id, allowed]);

  if (!allowed) return <main className="admin-main"><p role="alert" className="error">{a.forbidden}</p></main>;
  if (failed) return <main className="admin-main"><p role="alert" className="error">{a.loadFailed}</p></main>;
  if (!event) return <main className="admin-main" aria-busy="true"><p>{a.loading}</p></main>;
  return (
    <main className="admin-main">
      <h1>{a.eventSections[section]}</h1>
      {section === 'sessions' && <SessionsPanel event={event} />}
      {section === 'fields' && <FieldsPanel event={event} />}
      {section !== 'sessions' && section !== 'fields' && <p className="muted">{a.comingSoon}</p>}
    </main>
  );
}
