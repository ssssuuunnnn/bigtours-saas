import { EventSettings } from './event-settings';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EventSettings id={id} />;
}
