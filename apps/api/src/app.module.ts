import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { raw, type NextFunction, type Request, type Response } from 'express';
import { AccessService } from './access.service.ts';
import { AccountController } from './account.controller.ts';
import { AccountService } from './account.service.ts';
import { AgencyAdminService } from './agency-admin.service.ts';
import { AgencyController } from './agency.controller.ts';
import { ExportService } from './export.service.ts';
import { RoomService } from './rooms.service.ts';
import { EmailAdminService } from './email-admin.service.ts';
import { DatabaseService } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { PublicController } from './public.controller.ts';
import { DomainError } from './errors.ts';
import { RegistrationService } from './registration.service.ts';
import { MailService } from './mail.service.ts';
import { NotificationService } from './notification.service.ts';
import { RegistrationAdminService } from './registration-admin.service.ts';
import { RosterService } from './roster.service.ts';
import { StorageService } from './storage.service.ts';

const pdfBody = raw({ type: 'application/pdf', limit: '10mb' });
const csvBody = raw({ type: 'text/csv', limit: '5mb' });
const imageBody = raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' });

/** 超過上限時回傳明確的錯誤代碼，而不是通用的錯誤。 */
const parseFile = (parser: typeof pdfBody) => (req: Request, res: Response, next: NextFunction) => {
  parser(req, res, (err?: { status?: number }) => next(err?.status === 413 ? new DomainError('FILE_TOO_LARGE') : err));
};

@Module({
  controllers: [AccountController, AgencyController, PublicController],
  providers: [ExportService, RoomService, EmailAdminService, DatabaseService, EncryptionService, AccessService, AccountService, AgencyAdminService, RegistrationService, StorageService, MailService, RosterService, NotificationService, RegistrationAdminService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(parseFile(pdfBody)).forRoutes(
      { path: 'api/v1/agency/events/:eventId/terms', method: RequestMethod.PUT },
      { path: 'api/v1/agency/events/:eventId/options/:optionId/pdf', method: RequestMethod.PUT },
    );
    consumer.apply(parseFile(csvBody)).forRoutes(
      { path: 'api/v1/agency/events/:eventId/employees/import', method: RequestMethod.POST },
      { path: 'api/v1/agency/events/:eventId/employees/import/preview', method: RequestMethod.POST },
    );
    consumer.apply(parseFile(imageBody)).forRoutes({ path: 'api/v1/agency/events/:eventId/images/:kind', method: RequestMethod.PUT });
  }
}
