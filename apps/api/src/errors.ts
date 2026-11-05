import { HttpException } from '@nestjs/common';
import type { ErrorCode } from '@bigtours/shared';

const STATUS: Record<ErrorCode, number> = {
  NOT_FOUND: 404,
  REGISTRATION_NOT_OPEN: 409,
  REGISTRATION_CLOSED: 409,
  ALREADY_REGISTERED: 409,
  HOLD_EXISTS: 409,
  HOLD_EXPIRED: 410,
  HOLD_MISMATCH: 409,
  SESSION_FULL: 409,
  OPTION_FULL: 409,
  INVALID_SELECTION: 422,
  INVALID_DETAILS: 422,
  NOT_CANCELLABLE: 409,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  PAGE_CLOSED: 403,
  FORBIDDEN_ORIGIN: 403,
  LINK_INVALID: 410,
  INVALID_PASSWORD: 422,
};

/** 回傳錯誤代碼，文字由前端依語系顯示。 */
export class DomainError extends HttpException {
  constructor(public readonly code: ErrorCode, detail?: unknown) {
    super({ code, detail }, STATUS[code]);
  }
}
