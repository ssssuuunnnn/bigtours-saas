import type { Response } from 'express';
import { DomainError } from './errors.ts';
import { SESSION_COOKIE } from './access.service.ts';
import { AGENCY_HEADER, agencyApiPrefix } from './agency-path.ts';

export type RequestHeaders = Record<string, string | undefined>;

export const requestHost = (h: RequestHeaders) => h['x-forwarded-host'] ?? h['host'];

/** 網址路徑中的旅行社代號（見 agency-path.ts）。 */
export const requestAgency = (h: RequestHeaders) => h[AGENCY_HEADER];

export function cookieValue(h: RequestHeaders, cookie: string): string | undefined {
  for (const part of (h['cookie'] ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === cookie) return value.join('=') || undefined;
  }
  return undefined;
}

export const CONTACT_COOKIE = 'bt_contact_session';

const baseCookie = (path: string) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path,
});

/** 後台登入 Cookie 只送往該旅行社的 API 路徑，各旅行社的登入狀態互不相送。 */
export const cookieOptions = (agencyCode: string) => baseCookie(`${agencyApiPrefix(agencyCode)}/agency`);
export const contactCookieOptions = (agencyCode: string) => baseCookie(`${agencyApiPrefix(agencyCode)}/company`);
/** 員工登入 Cookie 限定此活動：帳號不跨活動共用，同一個瀏覽器也能分別登入不同活動。 */
export const employeeCookieOptions = (agencyCode: string, slug: string) => baseCookie(`${agencyApiPrefix(agencyCode)}/public/events/${slug}`);

export const sessionTokenFrom = (h: RequestHeaders) => cookieValue(h, SESSION_COOKIE);

/**
 * 登入狀態放在 Cookie。瀏覽器帶 Origin 時必須與目前網址相同，
 * 擋下其他網站（包括同一個上層網域的其他子網域）送來的請求。
 */
export function assertSameOrigin(h: RequestHeaders) {
  const origin = h['origin'];
  if (!origin) return;
  const host = requestHost(h)?.split(',')[0]?.trim().toLowerCase();
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    // 格式錯誤視為不同來源
  }
  if (originHost !== host) throw new DomainError('FORBIDDEN_ORIGIN');
}

/** 由瀏覽器分頁開啟 PDF；檔案只給已登入的使用者，不留快取。 */
export function sendPdf(res: Response, name: string, content: Buffer) {
  res.set({
    'content-type': 'application/pdf',
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
  });
  res.end(content);
}

export function sendXlsx(res: Response, name: string, content: Buffer) {
  res.set({
    'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'content-disposition': `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
  });
  res.end(content);
}

/** 前台圖片在登入前就要顯示，可以快取；網址帶版本，更換後會是新網址。 */
export function sendImage(res: Response, contentType: string, content: Buffer, cache = 'public, max-age=86400') {
  res.set({ 'content-type': contentType, 'x-content-type-options': 'nosniff', 'cache-control': cache });
  // SVG 直接開啟時不能執行任何內容。
  if (contentType === 'image/svg+xml') res.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.end(content);
}
