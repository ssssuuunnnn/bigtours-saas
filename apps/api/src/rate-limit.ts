import { DomainError } from './errors.ts';
import type { RequestHeaders } from './http.ts';

/** 反向代理（Caddy、Next.js）會帶 x-forwarded-for，取最前面的用戶端位址。 */
export function clientIp(h: RequestHeaders): string | null {
  const ip = (h['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  return ip && /^[0-9a-fA-F.:]{3,45}$/.test(ip) ? ip : null;
}

/**
 * 單一程序內的簡單限流，用於公開表單與試玩這類不需登入的入口。
 * 多台 API 時各自計算，上限會變寬，但仍能擋下大量重複請求。
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  hit(key: string, now = Date.now()) {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      throw new DomainError('TOO_MANY_REQUESTS');
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) {
      for (const [k, times] of this.hits) if (!times.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    }
  }
}
