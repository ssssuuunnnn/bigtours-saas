import { RegistrationFlow } from './registration-flow';

export default async function Page({ params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  return <RegistrationFlow slug={slug} token={token} />;
}
