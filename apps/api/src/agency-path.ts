import type { INestApplication } from '@nestjs/common';
import express, { type NextFunction, type Request, type Response } from 'express';

/**
 * 所有旅行社共用一個網址，旅行社代號放在路徑第一段：
 *   /api/v1/a/{代號}/agency/...   旅行社後台
 *   /api/v1/a/{代號}/company/...  企業窗口
 *   /api/v1/a/{代號}/public/...   員工前台
 * 進入路由前改寫成 /api/v1/agency/... 等原本的路徑，並把代號放進 AGENCY_HEADER；
 * 使用者自己送來的 AGENCY_HEADER 一律先刪除，只認路徑。
 * 登入 Cookie 的 Path 包含代號，不同旅行社的登入狀態互不相送，可以同時登入。
 */
export const AGENCY_HEADER = 'x-bt-agency';
const PREFIXED = /^\/api\/v1\/a\/([^/?#]+)\/(agency|company|public)(?=[/?#]|$)/;

/** SNS 用 text/plain 送出 JSON；這個路徑保留原始文字，由 SesFeedbackService 驗證簽章後才解析。 */
export const SES_WEBHOOK_PATH = '/api/v1/webhooks/ses';

export const agencyApiPrefix = (code: string) => `/api/v1/a/${code}`;

export function agencyPathMiddleware(req: Request, _res: Response, next: NextFunction) {
  delete req.headers[AGENCY_HEADER];
  const m = PREFIXED.exec(req.url);
  if (m) {
    let code = '';
    try {
      code = decodeURIComponent(m[1]!).toLowerCase();
    } catch {
      // 格式錯誤：不帶代號，後續一律 NOT_FOUND
    }
    req.headers[AGENCY_HEADER] = code;
    req.url = `/api/v1/${m[2]}${req.url.slice(m[0].length)}`;
  } else if (/^\/api\/v1\/(agency|company|public\/events)(?=[/?#]|$)/.test(req.url)) {
    // 沒有代號的舊路徑不提供，避免同一個功能有兩個網址
    req.url = '/api/v1/__not_found__';
  }
  next();
}

/** main.ts 與測試共用；要在 listen／init 之前呼叫，才會排在路由與其他中介層前面。 */
export function configureApp(app: INestApplication) {
  app.use(agencyPathMiddleware);
  app.use(SES_WEBHOOK_PATH, express.text({ type: () => true, limit: '300kb' }));
  return app;
}
