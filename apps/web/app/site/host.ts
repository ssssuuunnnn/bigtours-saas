import { headers } from 'next/headers';

/** 官網只在 平台網域 與 www.平台網域 顯示；其他網址是各旅行社。 */
export async function siteContext() {
  const h = await headers();
  const host = (h.get('x-forwarded-host') ?? h.get('host') ?? '').split(',')[0]!.trim().toLowerCase();
  const hostname = host.split(':')[0]!;
  const domain = (process.env.PLATFORM_DOMAIN ?? '').toLowerCase();
  const isSite = !!domain && (hostname === domain || hostname === `www.${domain}`);
  const proto = (h.get('x-forwarded-proto') ?? (process.env.NODE_ENV === 'production' ? 'https' : 'http')).split(',')[0]!.trim();
  const port = host.includes(':') ? `:${host.split(':')[1]}` : '';
  return { isSite, domain, proto, port, origin: `${proto}://${domain}${port}` };
}
