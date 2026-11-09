import { Controller, Get, Inject } from '@nestjs/common';
import { DatabaseService } from './database.service.ts';

/** 容器健康檢查與部署後檢查用：只回報服務與資料庫是否可用，不帶任何資料。 */
@Controller('api/v1/health')
export class HealthController {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  @Get()
  async check() {
    await this.db.pool.query('SELECT 1');
    return { ok: true, version: process.env.GIT_SHA ?? 'dev' };
  }
}
