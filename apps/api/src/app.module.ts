import { Module } from '@nestjs/common';
import { AccessService } from './access.service.ts';
import { AdminAuthController, AdminController } from './admin.controller.ts';
import { AdminAuthService, AdminGuard } from './admin-auth.service.ts';
import { AdminService } from './admin.service.ts';
import { DatabaseService } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { PublicController } from './public.controller.ts';
import { RegistrationService } from './registration.service.ts';

@Module({
  controllers: [PublicController, AdminAuthController, AdminController],
  providers: [DatabaseService, EncryptionService, AccessService, RegistrationService, AdminAuthService, AdminGuard, AdminService],
})
export class AppModule {}
