/**
 * 所有旅行社共用一個網址，代號是路徑第一段：/{代號}/admin、/{代號}/company、/{代號}/{活動}。
 * 這個檔案只放不依賴 React 的函式；元件用的 hook 在 agency.tsx。
 */

/** API 網址：/api/v1/a/{代號}/agency/...；代號一律小寫，Cookie 的 Path 才會相符。 */
export const agencyApi = (agency: string, path: string) => `/api/v1/a/${encodeURIComponent(agency.toLowerCase())}${path}`;

/** 只在瀏覽器呼叫 API 時使用；畫面上的連結請用 useAgency()，伺服器端繪製時才會一致。 */
export function currentAgency(): string {
  if (typeof window === 'undefined') return '';
  return decodeURIComponent(window.location.pathname.split('/')[1] ?? '').toLowerCase();
}

/** 在瀏覽器中直接換頁（登出、切換身分）時使用。 */
export const agencyLocation = (path: string) => `/${encodeURIComponent(currentAgency())}${path}`;
