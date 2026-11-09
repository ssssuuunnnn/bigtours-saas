import { headers } from 'next/headers';

/** 官網的網址資訊：平台網域本身（旅行社在 平台網域/{代號}/...）。 */
export async function siteContext() {
  const h = await headers();
  const host = (h.get('x-forwarded-host') ?? h.get('host') ?? '').split(',')[0]!.trim().toLowerCase();
  const domain = (process.env.PLATFORM_DOMAIN ?? host).toLowerCase();
  const proto = (h.get('x-forwarded-proto') ?? (process.env.NODE_ENV === 'production' ? 'https' : 'http')).split(',')[0]!.trim();
  return { domain, origin: `${proto}://${domain}` };
}
