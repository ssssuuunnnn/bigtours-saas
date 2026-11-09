import { LineEntry } from '../line-entry';

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <LineEntry slug={slug} />;
}
