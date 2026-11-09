import type { Liff } from '@line/liff';

let ready: Promise<Liff> | null = null;

/** LIFF SDK 只在瀏覽器載入，且同一頁只初始化一次。 */
export function initLiff(liffId: string): Promise<Liff> {
  ready ??= import('@line/liff').then(async ({ default: liff }) => {
    await liff.init({ liffId });
    return liff;
  });
  return ready;
}

/** 在 LINE 以外的瀏覽器不需要載入 SDK，直接導到一般登入頁。 */
export const inLineApp = () => typeof navigator !== 'undefined' && /\bLine\//i.test(navigator.userAgent);

/**
 * LINE 連結在 LINE 以外開啟時，liff.line.me 會轉到 Endpoint 並把原本的路徑放在 liff.state，
 * 例如 /line?liff.state=%2Facme-2027。取出第一段當活動代碼。
 */
export function slugFromLiffState(search: string): string | null {
  const state = new URLSearchParams(search).get('liff.state');
  const first = state?.split('?')[0]?.split('/').filter(Boolean)[0];
  return first && /^[a-z0-9-]{2,50}$/.test(first) ? first : null;
}
