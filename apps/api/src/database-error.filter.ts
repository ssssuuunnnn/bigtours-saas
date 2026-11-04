import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import pg from 'pg';

const MAP: Record<string, [number, string]> = {
  '23503': [409, 'IN_USE'],
  '23505': [409, 'DUPLICATE'],
  '23514': [409, 'CONSTRAINT_VIOLATION'],
  '22P02': [404, 'NOT_FOUND'],
};

/** 把資料庫限制轉成錯誤代碼；其他資料庫錯誤一律 500，且不外洩內容。 */
@Catch(pg.DatabaseError)
export class DatabaseErrorFilter implements ExceptionFilter {
  catch(err: pg.DatabaseError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const mapped = MAP[err.code ?? ''];
    if (mapped) {
      res.status(mapped[0]).json({ code: mapped[1] });
      return;
    }
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
}
