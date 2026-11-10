import type { Metadata } from 'next';
import { Landing } from './site/landing';
import { siteContext } from './site/host';
import { GoogleTagManager } from './site/gtm';
import { StructuredData } from './site/structured-data';

const TITLE = '大人數活動報名系統｜員工旅遊・會議報名｜Bookdex 大團報名';
const DESCRIPTION = '給旅行社、企業福委與 HR 的大人數活動報名系統。員工旅遊、家庭日、會議與活動報名，名額保留 15 分鐘不超賣，公司補助自動計算，名單一鍵匯出。免費試用 30 天。';

export async function generateMetadata(): Promise<Metadata> {
  const site = await siteContext();
  const image = { url: `${site.origin}/og.png`, width: 1200, height: 630, alt: 'Bookdex 大團報名：大人數活動報名系統' };
  return {
    title: TITLE,
    description: DESCRIPTION,
    robots: { index: true, follow: true },
    alternates: { canonical: `${site.origin}/` },
    openGraph: { type: 'website', siteName: 'Bookdex 大團報名', locale: 'zh_TW', title: TITLE, description: DESCRIPTION, url: `${site.origin}/`, images: [image] },
    twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: [image.url] },
  };
}

export default async function Home() {
  const site = await siteContext();
  return (
    <>
      <GoogleTagManager />
      <StructuredData origin={site.origin} description={DESCRIPTION} lineUrl={process.env.SITE_LINE_URL || null} />
      <Landing
        domain={site.domain}
        demoUrl="/try"
        lineUrl={process.env.SITE_LINE_URL || null}
        siblingUrl={process.env.SITE_SIBLING_URL || 'https://bookdex.cc'}
      />
    </>
  );
}
