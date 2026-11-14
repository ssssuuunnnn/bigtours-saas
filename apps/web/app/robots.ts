import type { MetadataRoute } from 'next';
import { siteContext } from './site/host';

/**
 * 只讓搜尋引擎抓官網首頁。旅行社後台、企業窗口、員工報名（/{代號}/...）、開通連結與平台後台
 * 都在同一個網域，用「只允許首頁、其餘不抓」的方式擋掉，之後新增的路徑也不會意外被收錄。
 * /_next/ 要開放，搜尋引擎才能載入 CSS 與字型正確呈現首頁。
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const site = await siteContext();
  return {
    rules: { userAgent: '*', allow: ['/$', '/_next/', '/og.png', '/logo-light.svg', '/logo-dark.svg', '/icon.svg', '/apple-icon.png'], disallow: '/' },
    sitemap: `${site.origin}/sitemap.xml`,
  };
}
