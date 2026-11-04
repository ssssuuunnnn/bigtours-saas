import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import {
  companyRequest, createEventRequest, employeeRequest, fieldRequest, importCommitRequest, importPreviewRequest, loginRequest, optionGroupRequest,
  optionRequest, paymentRequest, sessionRequest, travelerTypeRequest, updateEventRequest,
} from '@bigtours/shared/admin';
import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import { AdminAuthService, AdminGuard, SESSION_COOKIE, assertSameOrigin, readCookie, requestHost, type AdminRequest } from './admin-auth.service.ts';
import { AdminService } from './admin.service.ts';
import { DomainError } from './errors.ts';

function parse<T>(schema: ZodType<T, any, any>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new DomainError('INVALID_INPUT', { issues: result.error.issues.map((i) => i.path.join('.')) });
  return result.data;
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function sendXlsx(res: Response, name: string, buffer: Buffer) {
  res.setHeader('Content-Type', XLSX);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(buffer);
}

@Controller('api/v1/admin/auth')
export class AdminAuthController {
  constructor(@Inject(AdminAuthService) private readonly auth: AdminAuthService) {}

  @Post('login')
  @HttpCode(204)
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    assertSameOrigin(req);
    const { email, password } = parse(loginRequest, body);
    const { token, maxAgeMs } = await this.auth.login(requestHost(req), email, password, req.ip);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: maxAgeMs });
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    assertSameOrigin(req);
    await this.auth.logout(requestHost(req), readCookie(req, SESSION_COOKIE));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }
}

@Controller('api/v1/admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get('me')
  me(@Req() r: AdminRequest) {
    const { agencyName, primaryColor, user } = r.admin;
    return { agencyName, primaryColor, user };
  }

  @Get('quota') quota(@Req() r: AdminRequest) { return this.admin.quota(r.admin); }
  @Get('companies') companies(@Req() r: AdminRequest) { return this.admin.listCompanies(r.admin); }
  @Post('companies') createCompany(@Req() r: AdminRequest, @Body() b: unknown) { return this.admin.createCompany(r.admin, parse(companyRequest, b).name); }

  @Get('events') events(@Req() r: AdminRequest) { return this.admin.listEvents(r.admin); }
  @Post('events') createEvent(@Req() r: AdminRequest, @Body() b: unknown) { return this.admin.createEvent(r.admin, parse(createEventRequest, b)); }
  @Get('events/:id') event(@Req() r: AdminRequest, @Param('id') id: string) { return this.admin.getEvent(r.admin, id); }
  @Patch('events/:id') @HttpCode(204) updateEvent(@Req() r: AdminRequest, @Param('id') id: string, @Body() b: unknown) { return this.admin.updateEvent(r.admin, id, parse(updateEventRequest, b)); }
  @Delete('events/:id') @HttpCode(204) deleteEvent(@Req() r: AdminRequest, @Param('id') id: string) { return this.admin.deleteEvent(r.admin, id); }
  @Post('events/:id/publish') @HttpCode(204) publish(@Req() r: AdminRequest, @Param('id') id: string) { return this.admin.publish(r.admin, id); }
  @Post('events/:id/close') @HttpCode(204) close(@Req() r: AdminRequest, @Param('id') id: string) { return this.admin.closeEvent(r.admin, id); }

  @Post('events/:id/sessions') createSession(@Req() r: AdminRequest, @Param('id') id: string, @Body() b: unknown) { return this.admin.createSession(r.admin, id, parse(sessionRequest, b)); }
  @Put('events/:id/sessions/:sid') @HttpCode(204) updateSession(@Req() r: AdminRequest, @Param('id') id: string, @Param('sid') sid: string, @Body() b: unknown) { return this.admin.updateSession(r.admin, id, sid, parse(sessionRequest, b)); }
  @Delete('events/:id/sessions/:sid') @HttpCode(204) async deleteSession(@Req() r: AdminRequest, @Param('id') id: string, @Param('sid') sid: string) { await this.admin.deleteSession(r.admin, id, sid); }

  @Post('events/:id/traveler-types') createType(@Req() r: AdminRequest, @Param('id') id: string, @Body() b: unknown) { return this.admin.createTravelerType(r.admin, id, parse(travelerTypeRequest, b)); }
  @Put('events/:id/traveler-types/:tid') @HttpCode(204) updateType(@Req() r: AdminRequest, @Param('id') id: string, @Param('tid') tid: string, @Body() b: unknown) { return this.admin.updateTravelerType(r.admin, id, tid, parse(travelerTypeRequest, b)); }
  @Delete('events/:id/traveler-types/:tid') @HttpCode(204) async deleteType(@Req() r: AdminRequest, @Param('id') id: string, @Param('tid') tid: string) { await this.admin.deleteTravelerType(r.admin, id, tid); }

  @Post('events/:id/option-groups') createGroup(@Req() r: AdminRequest, @Param('id') id: string, @Body() b: unknown) { return this.admin.createGroup(r.admin, id, parse(optionGroupRequest, b)); }
  @Put('events/:id/option-groups/:gid') @HttpCode(204) updateGroup(@Req() r: AdminRequest, @Param('id') id: string, @Param('gid') gid: string, @Body() b: unknown) { return this.admin.updateGroup(r.admin, id, gid, parse(optionGroupRequest, b)); }
  @Delete('events/:id/option-groups/:gid') @HttpCode(204) async deleteGroup(@Req() r: AdminRequest, @Param('id') id: string, @Param('gid') gid: string) { await this.admin.deleteGroup(r.admin, id, gid); }
  @Post('events/:id/option-groups/:gid/options') createOption(@Req() r: AdminRequest, @Param('id') id: string, @Param('gid') gid: string, @Body() b: unknown) { return this.admin.createOption(r.admin, id, gid, parse(optionRequest, b)); }
  @Put('events/:id/options/:oid') @HttpCode(204) updateOption(@Req() r: AdminRequest, @Param('id') id: string, @Param('oid') oid: string, @Body() b: unknown) { return this.admin.updateOption(r.admin, id, oid, parse(optionRequest, b)); }
  @Delete('events/:id/options/:oid') @HttpCode(204) async deleteOption(@Req() r: AdminRequest, @Param('id') id: string, @Param('oid') oid: string) { await this.admin.deleteOption(r.admin, id, oid); }

  @Post('events/:id/fields') createField(@Req() r: AdminRequest, @Param('id') id: string, @Body() b: unknown) { return this.admin.createField(r.admin, id, parse(fieldRequest, b)); }
  @Put('events/:id/fields/:fid') @HttpCode(204) updateField(@Req() r: AdminRequest, @Param('id') id: string, @Param('fid') fid: string, @Body() b: unknown) { return this.admin.updateField(r.admin, id, fid, parse(fieldRequest, b)); }
  @Delete('events/:id/fields/:fid') @HttpCode(204) deleteField(@Req() r: AdminRequest, @Param('id') id: string, @Param('fid') fid: string) { return this.admin.deleteField(r.admin, id, fid); }

  @Get('events/:id/employees') employees(@Req() r: AdminRequest, @Param('id') id: string) { return this.admin.listEmployees(r.admin, id); }
  @Post('events/:id/employees') createEmployee(@Req() r: AdminRequest, @Param('id') id: string, @Body() b: unknown) { return this.admin.createEmployee(r.admin, id, parse(employeeRequest, b)); }
  @Get('events/:id/employees/template') async template(@Res() res: Response) { sendXlsx(res, '員工名單範本.xlsx', await this.admin.rosterTemplate()); }
  @Get('events/:id/employees/links') async links(@Req() r: AdminRequest, @Res() res: Response, @Param('id') id: string) {
    const host = requestHost(r)?.split(',')[0]?.trim();
    const proto = (r.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ?? r.protocol;
    sendXlsx(res, '員工專屬連結.xlsx', await this.admin.exportLinks(r.admin, id, `${proto}://${host}`));
  }
  @Post('events/:id/employees/import/preview') @HttpCode(200) preview(@Req() r: AdminRequest, @Param('id') id: string, @Body() b: unknown) { return this.admin.previewImport(r.admin, id, parse(importPreviewRequest, b).fileBase64); }
  @Post('events/:id/employees/import/commit') @HttpCode(200) commit(@Req() r: AdminRequest, @Param('id') id: string, @Body() b: unknown) { return this.admin.commitImport(r.admin, id, parse(importCommitRequest, b).rows); }
  @Put('events/:id/employees/:eid') @HttpCode(204) updateEmployee(@Req() r: AdminRequest, @Param('id') id: string, @Param('eid') eid: string, @Body() b: unknown) { return this.admin.updateEmployee(r.admin, id, eid, parse(employeeRequest, b)); }
  @Delete('events/:id/employees/:eid') @HttpCode(204) removeEmployee(@Req() r: AdminRequest, @Param('id') id: string, @Param('eid') eid: string) { return this.admin.removeEmployee(r.admin, id, eid); }
  @Post('events/:id/employees/:eid/regenerate-link') @HttpCode(204) regenerate(@Req() r: AdminRequest, @Param('id') id: string, @Param('eid') eid: string) { return this.admin.regenerateLink(r.admin, id, eid); }

  @Get('events/:id/registrations') registrations(@Req() r: AdminRequest, @Param('id') id: string) { return this.admin.listRegistrations(r.admin, id); }
  @Get('events/:id/registrations/:rid') registration(@Req() r: AdminRequest, @Param('id') id: string, @Param('rid') rid: string) { return this.admin.getRegistration(r.admin, id, rid); }
  @Patch('events/:id/registrations/:rid/payment') @HttpCode(204) payment(@Req() r: AdminRequest, @Param('id') id: string, @Param('rid') rid: string, @Body() b: unknown) { return this.admin.setPayment(r.admin, id, rid, parse(paymentRequest, b).paymentStatus); }
  @Post('events/:id/registrations/:rid/confirm-cancel') @HttpCode(204) confirmCancel(@Req() r: AdminRequest, @Param('id') id: string, @Param('rid') rid: string) { return this.admin.confirmCancel(r.admin, id, rid); }
  @Post('events/:id/registrations/:rid/reject-cancel') @HttpCode(204) rejectCancel(@Req() r: AdminRequest, @Param('id') id: string, @Param('rid') rid: string) { return this.admin.rejectCancel(r.admin, id, rid); }
}
