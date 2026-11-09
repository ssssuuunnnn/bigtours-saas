'use client';

import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { type ComponentProps, useMemo } from 'react';

export { agencyApi, agencyLocation, currentAgency } from './agency-path';

/**
 * 所有旅行社共用一個網址，代號是路徑第一段：/{代號}/admin、/{代號}/company、/{代號}/{活動}。
 * 頁面內的連結寫成旅行社內的路徑（/admin/...），由這裡加上代號。
 */

export function useAgency(): string {
  const params = useParams<{ agency?: string }>();
  return decodeURIComponent(String(params?.agency ?? '')).toLowerCase();
}

/** 旅行社內的路徑 → 完整路徑。 */
export function useAgencyHref() {
  const agency = useAgency();
  return (path: string) => `/${encodeURIComponent(agency)}${path}`;
}

/** 目前網址去掉代號之後的部分，例如 /abc/admin/events → /admin/events。 */
export function useAgencyPathname(): string {
  const pathname = usePathname() ?? '/';
  return pathname.replace(/^\/[^/]+/, '') || '/';
}

export function useAgencyRouter() {
  const router = useRouter();
  const agency = useAgency();
  return useMemo(() => {
    const full = (path: string) => `/${encodeURIComponent(agency)}${path}`;
    return { push: (path: string) => router.push(full(path)), replace: (path: string) => router.replace(full(path)) };
  }, [router, agency]);
}

/** 與 next/link 相同，href 寫旅行社內的路徑。 */
export function AgencyLink({ href, ...props }: Omit<ComponentProps<typeof Link>, 'href'> & { href: string }) {
  const full = useAgencyHref();
  return <Link {...props} href={full(href)} />;
}
