import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { raw, type NextFunction, type Request, type Response } from 'express';
import { AccessService } from './access.service.ts';
import { AccountController } from './account.controller.ts';
import { AccountService } from './account.service.ts';
import { AgencyAdminService } from './agency-admin.service.ts';
import { AgencyController } from './agency.controller.ts';
import { DatabaseService } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { PublicController } from './public.controller.ts';
import { DomainError } from './errors.ts';
import { RegistrationService } from './registration.service.ts';
import { StorageService } from './storage.service.ts';

const pdfBody = raw({ type: 'application/pdf', limit: '10mb' });

/** 超過上限時回傳明確的錯誤代碼，而不是通用的錯誤。 */
function parsePdf(req: Request, res: Response, next: NextFunction) {
  pdfBody(req, res, (err?: { status?: number }) => next(err?.status === 413 ? new DomainError('FILE_TOO_LARGE') : err));
}

@Module({
  controllers: [AccountController, AgencyController, PublicController],
  providers: [DatabaseService, EncryptionService, AccessService, AccountService, AgencyAdminService, RegistrationService, StorageService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(parsePdf).forRoutes({ path: 'api/v1/agency/events/:eventId/terms', method: RequestMethod.PUT });
  }
}
