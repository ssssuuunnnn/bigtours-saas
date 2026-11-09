import { EventEntry } from './event-entry';

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <EventEntry slug={slug} />;
}
