import { SetPasswordFlow } from './set-password-flow';

export default async function Page({ params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  return <SetPasswordFlow slug={slug} token={token} />;
}
