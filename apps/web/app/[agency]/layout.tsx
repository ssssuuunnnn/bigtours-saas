import { AGENCY_CODE_PATTERN, DEMO_AGENCY_CODE, RESERVED_AGENCY_CODES } from '@bigtours/shared';
import { notFound } from 'next/navigation';

/** 平台網域/{代號}/...：代號格式不對就是不存在的網址；旅行社是否存在由 API 判斷。 */
export default async function AgencyLayout({ children, params }: { children: React.ReactNode; params: Promise<{ agency: string }> }) {
  const code = decodeURIComponent((await params).agency).toLowerCase();
  if (!AGENCY_CODE_PATTERN.test(code) || (RESERVED_AGENCY_CODES.includes(code) && code !== DEMO_AGENCY_CODE)) notFound();
  return children;
}
