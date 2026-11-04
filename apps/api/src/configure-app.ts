import type { INestApplication } from '@nestjs/common';
import express from 'express';
import { DatabaseErrorFilter } from './database-error.filter.ts';

/** 匯入名單需要較大的請求內容，其他介面維持 1MB。 */
export function configureApp(app: INestApplication) {
  app.use('/api/v1/admin/events/:id/employees/import/preview', express.json({ limit: '10mb' }));
  app.use('/api/v1/admin/events/:id/employees/import/commit', express.json({ limit: '5mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.useGlobalFilters(new DatabaseErrorFilter());
}
