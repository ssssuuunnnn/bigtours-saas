import { FAQS } from './landing';

/** 官網的結構化資料（JSON-LD）：組織、網站、軟體產品、常見問題。 */
export function StructuredData({ origin, description, lineUrl }: { origin: string; description: string; lineUrl: string | null }) {
  const org = {
    '@type': 'Organization',
    '@id': `${origin}/#organization`,
    name: 'Bookdex',
    url: `${origin}/`,
    logo: `${origin}/apple-icon.png`,
    ...(lineUrl ? { sameAs: [lineUrl] } : {}),
  };
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      org,
      { '@type': 'WebSite', '@id': `${origin}/#website`, name: 'Bookdex 大團報名', url: `${origin}/`, inLanguage: 'zh-TW', publisher: { '@id': org['@id'] } },
      {
        '@type': 'SoftwareApplication',
        name: 'Bookdex 大團報名',
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        url: `${origin}/`,
        image: `${origin}/og.png`,
        description,
        inLanguage: 'zh-TW',
        publisher: { '@id': org['@id'] },
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'TWD', description: '免費試用 30 天，不需要信用卡' },
      },
      {
        '@type': 'FAQPage',
        mainEntity: FAQS.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
      },
    ],
  };
  // < 轉成 <，避免內容裡的 </script> 提早結束標籤
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }} />;
}
