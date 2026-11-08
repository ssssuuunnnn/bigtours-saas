'use client';

import { notFound, useParams } from 'next/navigation';
import { Suspense } from 'react';
import { contactApi } from '../../../../../../lib/admin-api';
import { a } from '../../../../../../messages/admin';
import { RosterPanel } from '../../../../admin/events/[id]/roster-panel';
import { ContactOverviewPanel } from './overview';
import { ContactRegistrationsPanel } from './registrations';

export default function ContactEventSection() {
  const { id, section } = useParams<{ id: string; section: string }>();
  if (!['overview', 'roster', 'registrations'].includes(section)) notFound();
  return (
    <main className="admin-main">
      <h1>{a.c.nav[section]}</h1>
      <Suspense>
        {section === 'overview' && <ContactOverviewPanel id={id} />}
        {section === 'roster' && (
          <>
            <RosterPanel event={{ id }} api={contactApi} />
            <p className="muted">{a.c.rosterHint}</p>
          </>
        )}
        {section === 'registrations' && <ContactRegistrationsPanel id={id} />}
      </Suspense>
    </main>
  );
}
