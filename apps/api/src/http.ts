import { DomainError } from './errors.ts';
import { SESSION_COOKIE } from './access.service.ts';

export type RequestHeaders = Record<string, string | undefined>;

export const requestHost = (h: RequestHeaders) => h['x-forwarded-host'] ?? h['host'];

export function sessionTokenFrom(h: RequestHeaders): string | undefined {
  for (const part of (h['cookie'] ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE) return value.join('=') || undefined;
  }
  return undefined;
}

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
