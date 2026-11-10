import { connection } from 'next/server';

/** 只接受 GTM 容器 ID 的格式，避免環境變數內容被插進 script。 */
const GTM_ID = /^GTM-[A-Z0-9]+$/;

/**
 * Google Tag Manager。只放在官網（/）與試玩（/try），不放在旅行社、企業窗口、員工報名、
 * 開通與平台後台等頁面，避免個資與開通連結的 token 送到 Google。
 * 容器 ID 由 SITE_GTM_ID 設定，執行時讀取；留空（本機、測試）時不載入。
 */
export async function GoogleTagManager() {
  await connection();
  const id = process.env.SITE_GTM_ID?.trim();
  if (!id || !GTM_ID.test(id)) return null;
  return (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${id}');`,
        }}
      />
      <noscript>
        <iframe
          src={`https://www.googletagmanager.com/ns.html?id=${id}`}
          height="0"
          width="0"
          style={{ display: 'none', visibility: 'hidden' }}
        />
      </noscript>
    </>
  );
}
