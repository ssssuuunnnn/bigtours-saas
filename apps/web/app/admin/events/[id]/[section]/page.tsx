import { EVENT_NAV_KEYS, type EventNavKey } from '@bigtours/shared';
import { notFound } from 'next/navigation';
import { EventSection } from '../event-section';

export default async function Page({ params }: { params: Promise<{ id: string; section: string }> }) {
  const { id, section } = await params;
  if (!(EVENT_NAV_KEYS as readonly string[]).includes(section)) notFound();
  return <EventSection id={id} section={section as EventNavKey} />;
}
