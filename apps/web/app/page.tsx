import type { Metadata } from 'next';
import { Landing } from './site/landing';
import { siteContext } from './site/host';

const TITLE = 'Bookdex 大團報名｜員工旅遊報名系統・免費試用 30 天';
const DESCRIPTION = '給旅行社的團體旅遊報名系統。員工登入就能報名，名額保留 15 分鐘不超賣，公司補助自動計算，名單一鍵匯出。';

export async function generateMetadata(): Promise<Metadata> {
  const site = await siteContext();
  if (!site.isSite) return {};
  return {
    title: TITLE,
    description: DESCRIPTION,
    robots: { index: true, follow: true },
    alternates: { canonical: `${site.origin}/` },
    openGraph: { type: 'website', siteName: 'Bookdex 大團報名', locale: 'zh_TW', title: TITLE, description: DESCRIPTION, url: `${site.origin}/` },
  };
}

export default async function Home() {
  const site = await siteContext();
  if (site.isSite) {
    return (
      <Landing
        domain={site.domain}
        demoUrl={`${site.proto}://demo.${site.domain}${site.port}/try`}
        lineUrl={process.env.SITE_LINE_URL || null}
        siblingUrl={process.env.SITE_SIBLING_URL || 'https://bookdex.cc'}
      />
    );
  }
  return <main className="center-note"><h1>請使用公司提供的報名網址</h1></main>;
}
