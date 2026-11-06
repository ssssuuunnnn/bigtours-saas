import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { assignRoomRequest, createRoomRequest, roomSessionRequest, updateRoomRequest, emailResendRequest, emailTemplateInput, notifyEmailsRequest, agencyLoginRequest, accountEmailRequest, agencyModifyRequest, companyInput, contactsRequest, createEventRequest, employeeInput, feeAdjustRequest, paymentStatusRequest, reassignRequest, rosterCopyRequest, eventBasicRequest, eventScheduleRequest, fieldInput, optionGroupInput, optionInput, orderRequest, pageSwitchRequest, paymentTermsRequest, pinnedNavRequest, pricingRequest, publishRequest, sessionInput, type AgencyPermission } from '@bigtours/shared';
import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import { AgencyAdminService } from './agency-admin.service.ts';
import { DomainError } from './errors.ts';
import { EmailAdminService } from './email-admin.service.ts';
import { RegistrationAdminService } from './registration-admin.service.ts';
import { RoomService } from './rooms.service.ts';
import { RosterService } from './roster.service.ts';
import { assertSameOrigin, cookieValue, requestHost, sendImage, sendPdf, type RequestHeaders } from './http.ts';

const COOKIE = 'bt_agency_session';
const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/api/v1/agency',
});

function parse<T>(schema: ZodType<T, any, any>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new DomainError('INVALID_INPUT', { issues: result.error.issues.map((i) => i.path.join('.')) });
  return result.data;
}

/** 旅行社後台：旅行社由網址判定，資料由 RLS 隔離，操作權限依角色檢查。 */
@Controller('api/v1/agency')
export class AgencyController {
  constructor(
    @Inject(AgencyAdminService) private readonly admin: AgencyAdminService,
    @Inject(RosterService) private readonly roster: RosterService,
    @Inject(RegistrationAdminService) private readonly regs: RegistrationAdminService,
    @Inject(EmailAdminService) private readonly emails: EmailAdminService,
    @Inject(RoomService) private readonly rooms: RoomService,
  ) {}

  private ctx(h: RequestHeaders) {
    assertSameOrigin(h);
    return this.admin.resolve(requestHost(h), cookieValue(h, COOKIE));
  }

  private async allowed(h: RequestHeaders, permission: AgencyPermission) {
    const ctx = await this.ctx(h);
    this.admin.assertCan(ctx, permission);
    return ctx;
  }

  /** 活動設定類操作。 */
  private configurer(h: RequestHeaders) {
    return this.allowed(h, 'configureEvents');
  }

  private operator(h: RequestHeaders) {
    return this.allowed(h, 'operateEvents');
  }

  @Post('session')
  @HttpCode(204)
  async login(@Headers() h: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    assertSameOrigin(h);
    const req = agencyLoginRequest.safeParse(body);
    if (!req.success) throw new DomainError('INVALID_CREDENTIALS');
    const { token, maxAgeMs } = await this.admin.login(requestHost(h), req.data.email, req.data.password);
    res.cookie(COOKIE, token, { ...cookieOptions(), maxAge: maxAgeMs });
  }

  @Delete('session')
  @HttpCode(204)
  async logout(@Headers() h: RequestHeaders, @Res({ passthrough: true }) res: Response) {
    assertSameOrigin(h);
    await this.admin.logout(requestHost(h), cookieValue(h, COOKIE));
    res.clearCookie(COOKIE, cookieOptions());
  }

  @Get('me')
  async me(@Headers() h: RequestHeaders) {
    const ctx = await this.ctx(h);
    return { agencyName: ctx.agencyName, user: { name: ctx.user.name, role: ctx.user.role }, pinnedNavItems: ctx.user.pinnedNavItems };
  }

  @Put('me/pinned-nav')
  @HttpCode(204)
  async setPinnedNav(@Headers() h: RequestHeaders, @Body() body: unknown) {
    await this.admin.setPinnedNav(await this.configurer(h), parse(pinnedNavRequest, body).items);
  }

  @Get('events')
  async events(@Headers() h: RequestHeaders) {
    return this.admin.listEvents(await this.ctx(h));
  }

  @Get('events/:eventId')
  async event(@Headers() h: RequestHeaders, @Param('eventId') eventId: string) {
    return this.admin.getEvent(await this.ctx(h), eventId);
  }

  @Get('quota')
  async quota(@Headers() h: RequestHeaders) {
    return this.admin.quota(await this.configurer(h));
  }

  @Get('companies')
  async companies(@Headers() h: RequestHeaders) {
    return this.admin.listCompanies(await this.configurer(h));
  }

  @Post('companies')
  async createCompany(@Headers() h: RequestHeaders, @Body() body: unknown) {
    return this.admin.createCompany(await this.configurer(h), parse(companyInput, body).name);
  }

  @Post('events')
  async createEvent(@Headers() h: RequestHeaders, @Body() body: unknown) {
    return this.admin.createEvent(await this.configurer(h), parse(createEventRequest, body));
  }

  @Delete('events/:eventId')
  @HttpCode(204)
  async deleteEvent(@Headers() h: RequestHeaders, @Param('eventId') eventId: string) {
    await this.admin.deleteEvent(await this.configurer(h), eventId);
  }

  @Put('events/:eventId/basic')
  @HttpCode(204)
  async updateBasic(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    await this.admin.updateBasic(await this.configurer(h), eventId, parse(eventBasicRequest, body));
  }

  @Put('events/:eventId/schedule')
  @HttpCode(204)
  async updateSchedule(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    await this.admin.updateSchedule(await this.configurer(h), eventId, parse(eventScheduleRequest, body));
  }

  @Put('events/:eventId/page')
  @HttpCode(204)
  async setPage(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    await this.admin.setPageOpen(await this.configurer(h), eventId, parse(pageSwitchRequest, body).open);
  }

  @Get('events/:eventId/sessions')
  async sessions(@Headers() h: RequestHeaders, @Param('eventId') eventId: string) {
    return this.admin.listSessions(await this.configurer(h), eventId);
  }

  @Post('events/:eventId/sessions')
  async createSession(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.admin.createSession(await this.configurer(h), eventId, parse(sessionInput, body));
  }

  // 固定路徑放在 :sessionId 之前
  @Put('events/:eventId/sessions/order')
  @HttpCode(204)
  async orderSessions(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    await this.admin.reorderSessions(await this.configurer(h), eventId, parse(orderRequest, body).ids);
  }

  @Patch('events/:eventId/sessions/:sessionId')
  async updateSession(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('sessionId') sessionId: string, @Body() body: unknown) {
    return this.admin.updateSession(await this.configurer(h), eventId, sessionId, parse(sessionInput, body));
  }

  @Delete('events/:eventId/sessions/:sessionId')
  @HttpCode(204)
  async deleteSession(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('sessionId') sessionId: string) {
    await this.admin.deleteSession(await this.configurer(h), eventId, sessionId);
  }

  @Get('events/:eventId/fields')
  async fields(@Headers() h: RequestHeaders, @Param('eventId') eventId: string) {
    return this.admin.listFields(await this.configurer(h), eventId);
  }

  @Post('events/:eventId/fields')
  async createField(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.admin.createField(await this.configurer(h), eventId, parse(fieldInput, body));
  }

  @Put('events/:eventId/fields/order')
  @HttpCode(204)
  async orderFields(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    await this.admin.reorderFields(await this.configurer(h), eventId, parse(orderRequest, body).ids);
  }

  @Patch('events/:eventId/fields/:fieldId')
  async updateField(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('fieldId') fieldId: string, @Body() body: unknown) {
    return this.admin.updateField(await this.configurer(h), eventId, fieldId, parse(fieldInput, body));
  }

  @Delete('events/:eventId/fields/:fieldId')
  @HttpCode(204)
  async deleteField(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('fieldId') fieldId: string) {
    await this.admin.deleteField(await this.configurer(h), eventId, fieldId);
  }

  @Get('events/:eventId/pricing')
  async pricing(@Headers() h: RequestHeaders, @Param('eventId') eventId: string) {
    return this.admin.getPricing(await this.configurer(h), eventId);
  }

  @Put('events/:eventId/pricing')
  async savePricing(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.admin.savePricing(await this.configurer(h), eventId, parse(pricingRequest, body));
  }

  @Get('events/:eventId/option-groups')
  async optionGroups(@Headers() h: RequestHeaders, @Param('eventId') eventId: string) {
    return this.admin.listOptionGroups(await this.configurer(h), eventId);
  }

  @Post('events/:eventId/option-groups')
  async createOptionGroup(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.admin.createOptionGroup(await this.configurer(h), eventId, parse(optionGroupInput, body));
  }

  @Patch('events/:eventId/option-groups/:groupId')
  @HttpCode(204)
  async updateOptionGroup(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('groupId') groupId: string, @Body() body: unknown) {
    await this.admin.updateOptionGroup(await this.configurer(h), eventId, groupId, parse(optionGroupInput, body));
  }

  @Delete('events/:eventId/option-groups/:groupId')
  @HttpCode(204)
  async deleteOptionGroup(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('groupId') groupId: string) {
    await this.admin.deleteOptionGroup(await this.configurer(h), eventId, groupId);
  }

  @Post('events/:eventId/option-groups/:groupId/options')
  async createOption(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('groupId') groupId: string, @Body() body: unknown) {
    return this.admin.createOption(await this.configurer(h), eventId, groupId, parse(optionInput, body));
  }

  @Patch('events/:eventId/options/:optionId')
  @HttpCode(204)
  async updateOption(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('optionId') optionId: string, @Body() body: unknown) {
    await this.admin.updateOption(await this.configurer(h), eventId, optionId, parse(optionInput, body));
  }

  @Delete('events/:eventId/options/:optionId')
  @HttpCode(204)
  async deleteOption(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('optionId') optionId: string) {
    await this.admin.deleteOption(await this.configurer(h), eventId, optionId);
  }

  @Put('events/:eventId/option-groups/order')
  @HttpCode(204)
  async orderOptionGroups(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    await this.admin.reorderOptionGroups(await this.configurer(h), eventId, parse(orderRequest, body).ids);
  }

  @Put('events/:eventId/option-groups/:groupId/options/order')
  @HttpCode(204)
  async orderOptions(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('groupId') groupId: string, @Body() body: unknown) {
    await this.admin.reorderOptions(await this.configurer(h), eventId, groupId, parse(orderRequest, body).ids);
  }

  @Put('events/:eventId/payment-terms')
  @HttpCode(204)
  async savePaymentTerms(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    await this.admin.savePaymentTerms(await this.configurer(h), eventId, parse(paymentTermsRequest, body));
  }

  @Put('events/:eventId/terms')
  async uploadTerms(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Query('name') name: unknown, @Req() req: Request) {
    return this.admin.uploadTerms(await this.configurer(h), eventId, typeof name === 'string' ? name : '', req.body);
  }

  @Get('events/:eventId/terms')
  async downloadTerms(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Res() res: Response) {
    const file = await this.admin.readTerms(await this.configurer(h), eventId);
    sendPdf(res, file.name, file.content);
  }

  @Post('events/:eventId/copy')
  async copyEvent(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.admin.copyEvent(await this.configurer(h), eventId, parse(createEventRequest, body));
  }

  @Put('events/:eventId/images/:kind')
  async uploadImage(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('kind') kind: string, @Req() req: Request) {
    return this.admin.uploadImage(await this.configurer(h), eventId, kind, req.body);
  }

  @Get('events/:eventId/images/:kind')
  async image(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('kind') kind: string, @Res() res: Response) {
    const file = await this.admin.readImage(await this.configurer(h), eventId, kind);
    sendImage(res, file.contentType, file.content, 'private, no-store');
  }

  @Delete('events/:eventId/images/:kind')
  @HttpCode(204)
  async deleteImage(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('kind') kind: string) {
    await this.admin.deleteImage(await this.configurer(h), eventId, kind);
  }

  @Put('events/:eventId/options/:optionId/pdf')
  async uploadOptionPdf(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('optionId') optionId: string, @Query('name') name: unknown, @Req() req: Request) {
    return this.admin.uploadOptionPdf(await this.configurer(h), eventId, optionId, typeof name === 'string' ? name : '', req.body);
  }

  @Get('events/:eventId/options/:optionId/pdf')
  async optionPdf(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('optionId') optionId: string, @Res() res: Response) {
    const file = await this.admin.readOptionPdf(await this.configurer(h), eventId, optionId);
    sendPdf(res, file.name, file.content);
  }

  @Delete('events/:eventId/options/:optionId/pdf')
  @HttpCode(204)
  async deleteOptionPdf(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('optionId') optionId: string) {
    await this.admin.deleteOptionPdf(await this.configurer(h), eventId, optionId);
  }

  @Get('events/:eventId/employees')
  async employees(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Query() q: Record<string, unknown>) {
    const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return this.roster.list(await this.configurer(h), eventId, { search: text(q.search), account: text(q.account), registration: text(q.registration), page: Number(q.page) || 1 });
  }

  @Post('events/:eventId/employees')
  async createEmployee(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.roster.create(await this.configurer(h), eventId, parse(employeeInput, body));
  }

  @Post('events/:eventId/employees/import/preview')
  @HttpCode(200)
  async previewImport(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Req() req: Request) {
    return this.roster.previewImport(await this.configurer(h), eventId, req.body);
  }

  @Post('events/:eventId/employees/import')
  @HttpCode(200)
  async importEmployees(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Req() req: Request) {
    return this.roster.import(await this.configurer(h), eventId, req.body);
  }

  @Get('events/:eventId/employees/copy-sources')
  async rosterSources(@Headers() h: RequestHeaders, @Param('eventId') eventId: string) {
    return this.roster.copySources(await this.configurer(h), eventId);
  }

  @Post('events/:eventId/employees/copy')
  @HttpCode(200)
  async copyRoster(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.roster.copyFrom(await this.configurer(h), eventId, parse(rosterCopyRequest, body).fromEventId);
  }

  @Post('events/:eventId/employees/account-emails')
  @HttpCode(202)
  async accountEmails(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.roster.sendAccountEmails(await this.configurer(h), eventId, parse(accountEmailRequest, body));
  }

  @Patch('events/:eventId/employees/:employeeId')
  @HttpCode(204)
  async updateEmployee(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('employeeId') employeeId: string, @Body() body: unknown) {
    await this.roster.update(await this.configurer(h), eventId, employeeId, parse(employeeInput, body));
  }

  @Delete('events/:eventId/employees/:employeeId')
  @HttpCode(204)
  async removeEmployee(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('employeeId') employeeId: string) {
    await this.roster.remove(await this.configurer(h), eventId, employeeId);
  }

  @Post('events/:eventId/employees/:employeeId/password-link')
  async passwordLink(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('employeeId') employeeId: string) {
    return this.roster.issueLink(await this.configurer(h), eventId, employeeId);
  }

  @Get('events/:eventId/overview')
  async overview(@Headers() h: RequestHeaders, @Param('eventId') eventId: string) {
    return this.regs.overview(await this.operator(h), eventId);
  }

  @Get('events/:eventId/registrations')
  async registrations(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Query() q: Record<string, unknown>) {
    const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return this.regs.list(await this.operator(h), eventId, { search: text(q.search), session: text(q.session), payment: text(q.payment), status: text(q.status), page: Number(q.page) || 1 });
  }

  @Get('events/:eventId/registrations/:registrationId')
  async registration(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('registrationId') registrationId: string) {
    return this.regs.detail(await this.operator(h), eventId, registrationId);
  }

  // ===== 分房 =====

  @Get('events/:eventId/rooms')
  async roomOverview(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Query('session') session?: string) {
    return this.rooms.overview(await this.operator(h), eventId, session);
  }

  @Post('events/:eventId/rooms')
  async createRoom(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.rooms.create(await this.operator(h), eventId, parse(createRoomRequest, body));
  }

  @Post('events/:eventId/rooms/draft')
  async draftRooms(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.rooms.draft(await this.operator(h), eventId, parse(roomSessionRequest, body).sessionId);
  }

  @Post('events/:eventId/rooms/publish')
  async publishRooms(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.rooms.publish(await this.operator(h), eventId, parse(roomSessionRequest, body).sessionId);
  }

  @Put('events/:eventId/rooms/assignments')
  @HttpCode(204)
  async assignRooms(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    const input = parse(assignRoomRequest, body);
    await this.rooms.assign(await this.operator(h), eventId, input.sessionId, input.roomId, input.travelerIds);
  }

  @Patch('events/:eventId/rooms/:roomId')
  @HttpCode(204)
  async updateRoom(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('roomId') roomId: string, @Body() body: unknown) {
    await this.rooms.update(await this.operator(h), eventId, roomId, parse(updateRoomRequest, body));
  }

  @Delete('events/:eventId/rooms/:roomId')
  @HttpCode(204)
  async removeRoom(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('roomId') roomId: string) {
    await this.rooms.remove(await this.operator(h), eventId, roomId);
  }

  // ===== Email 通知 =====

  @Get('events/:eventId/emails')
  async emailOverview(@Headers() h: RequestHeaders, @Param('eventId') eventId: string) {
    return this.emails.overview(await this.configurer(h), eventId);
  }

  @Put('events/:eventId/emails/notify-emails')
  @HttpCode(204)
  async saveNotifyEmails(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    await this.emails.saveNotifyEmails(await this.configurer(h), eventId, parse(notifyEmailsRequest, body).emails);
  }

  @Put('events/:eventId/emails/templates/:key')
  @HttpCode(204)
  async saveEmailTemplate(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('key') key: string, @Body() body: unknown) {
    await this.emails.saveTemplate(await this.configurer(h), eventId, key, parse(emailTemplateInput, body));
  }

  @Delete('events/:eventId/emails/templates/:key')
  @HttpCode(204)
  async resetEmailTemplate(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('key') key: string) {
    await this.emails.resetTemplate(await this.configurer(h), eventId, key);
  }

  @Post('events/:eventId/emails/templates/:key/test')
  async testEmailTemplate(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('key') key: string, @Body() body: unknown) {
    return this.emails.sendTest(await this.configurer(h), eventId, key, parse(emailTemplateInput, body));
  }

  @Post('events/:eventId/emails/deadline-reminder')
  async sendReminder(@Headers() h: RequestHeaders, @Param('eventId') eventId: string) {
    return this.emails.sendReminder(await this.configurer(h), eventId);
  }

  @Post('events/:eventId/emails/messages/:messageId/resend')
  @HttpCode(204)
  async resendEmail(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('messageId') messageId: string, @Body() body: unknown) {
    await this.emails.resend(await this.configurer(h), eventId, messageId, parse(emailResendRequest, body).email);
  }

  @Get('events/:eventId/registrations/:registrationId/revisions/:no')
  async revision(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('registrationId') registrationId: string, @Param('no') no: string) {
    return this.regs.revision(await this.operator(h), eventId, registrationId, Number(no));
  }

  @Get('events/:eventId/registrations/:registrationId/edit')
  async registrationEdit(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('registrationId') registrationId: string) {
    return this.regs.editData(await this.operator(h), eventId, registrationId);
  }

  @Put('events/:eventId/registrations/:registrationId')
  @HttpCode(204)
  async modifyRegistration(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('registrationId') registrationId: string, @Body() body: unknown) {
    await this.regs.modify(await this.operator(h), eventId, registrationId, parse(agencyModifyRequest, body));
  }

  @Post('events/:eventId/registrations/:registrationId/sensitive')
  @HttpCode(200)
  async sensitive(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('registrationId') registrationId: string) {
    return this.regs.revealSensitive(await this.allowed(h, 'viewSensitiveData'), eventId, registrationId);
  }

  @Put('events/:eventId/registrations/:registrationId/payment')
  @HttpCode(204)
  async payment(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('registrationId') registrationId: string, @Body() body: unknown) {
    await this.regs.setPayment(await this.operator(h), eventId, registrationId, parse(paymentStatusRequest, body).status);
  }

  @Put('events/:eventId/registrations/:registrationId/fee')
  @HttpCode(204)
  async fee(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('registrationId') registrationId: string, @Body() body: unknown) {
    await this.regs.adjustFee(await this.operator(h), eventId, registrationId, parse(feeAdjustRequest, body));
  }

  @Post('events/:eventId/registrations/:registrationId/cancel/confirm')
  @HttpCode(204)
  async confirmCancel(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('registrationId') registrationId: string) {
    await this.regs.confirmCancel(await this.operator(h), eventId, registrationId);
  }

  @Post('events/:eventId/registrations/:registrationId/cancel/reject')
  @HttpCode(204)
  async rejectCancel(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('registrationId') registrationId: string) {
    await this.regs.rejectCancel(await this.operator(h), eventId, registrationId);
  }

  @Get('events/:eventId/reassign/sources')
  async reassignSources(@Headers() h: RequestHeaders, @Param('eventId') eventId: string) {
    return this.regs.reassignSources(await this.operator(h), eventId);
  }

  @Get('events/:eventId/reassign/plan')
  async reassignPlan(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Query('sessionId') sessionId: unknown, @Query('optionId') optionId: unknown) {
    return this.regs.reassignPlan(await this.operator(h), eventId, String(sessionId), String(optionId));
  }

  @Post('events/:eventId/reassign')
  @HttpCode(200)
  async reassign(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.regs.reassign(await this.operator(h), eventId, parse(reassignRequest, body));
  }

  @Get('events/:eventId/contacts')
  async contacts(@Headers() h: RequestHeaders, @Param('eventId') eventId: string) {
    return this.admin.listContacts(await this.configurer(h), eventId);
  }

  @Put('events/:eventId/contacts')
  async saveContacts(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.admin.saveContacts(await this.configurer(h), eventId, parse(contactsRequest, body).contacts);
  }

  @Get('events/:eventId/publish-check')
  async publishCheck(@Headers() h: RequestHeaders, @Param('eventId') eventId: string) {
    return this.admin.publishCheck(await this.configurer(h), eventId);
  }

  @Post('events/:eventId/publish')
  @HttpCode(204)
  async publish(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    await this.admin.publish(await this.configurer(h), eventId, parse(publishRequest, body).confirmFreeSelfFee);
  }
}
