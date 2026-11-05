import { Module } from '@nestjs/common';
import { AccessService } from './access.service.ts';
import { AccountController } from './account.controller.ts';
import { AccountService } from './account.service.ts';
import { AgencyAdminService } from './agency-admin.service.ts';
import { AgencyController } from './agency.controller.ts';
import { DatabaseService } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { PublicController } from './public.controller.ts';
import { RegistrationService } from './registration.service.ts';

@Module({
  controllers: [AccountController, AgencyController, PublicController],
  providers: [DatabaseService, EncryptionService, AccessService, AccountService, AgencyAdminService, RegistrationService],
})
export class AppModule {}
