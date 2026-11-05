import type { Response } from 'express';
import { DomainError } from './errors.ts';
import { SESSION_COOKIE } from './access.service.ts';

export type RequestHeaders = Record<string, string | undefined>;

export const requestHost = (h: RequestHeaders) => h['x-forwarded-host'] ?? h['host'];

export function cookieValue(h: RequestHeaders, cookie: string): string | undefined {
  for (const part of (h['cookie'] ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === cookie) return value.join('=') || undefined;
  }
  return undefined;
}

export const sessionTokenFrom = (h: RequestHeaders) => cookieValue(h, SESSION_COOKIE);

/**
 * 登入狀態放在 Cookie。各旅行社子網域屬於同一個網站，SameSite 擋不住彼此的請求，
 * 因此瀏覽器帶 Origin 時必須與目前網址相同。
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

/** 前台圖片在登入前就要顯示，可以快取；網址帶版本，更換後會是新網址。 */
export function sendImage(res: Response, contentType: string, content: Buffer, cache = 'public, max-age=86400') {
  res.set({ 'content-type': contentType, 'x-content-type-options': 'nosniff', 'cache-control': cache });
  res.end(content);
}
