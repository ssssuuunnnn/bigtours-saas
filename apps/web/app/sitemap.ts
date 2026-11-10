import type { MetadataRoute } from 'next';
import { siteContext } from './site/host';

/** 只列官網首頁；其餘頁面不開放索引。 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = await siteContext();
  return [{ url: `${site.origin}/`, changeFrequency: 'monthly', priority: 1 }];
}
