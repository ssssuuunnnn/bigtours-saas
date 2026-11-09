import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { accountEmailRequest, employeeInput, isValidPassword, rosterCopyRequest } from '@bigtours/shared';
import type { Request, Response } from 'express';
import { ContactService, type ContactContext } from './contact.service.ts';
import { DomainError } from './errors.ts';
import { assertSameOrigin, CONTACT_COOKIE, contactCookieOptions, cookieValue, requestAgency, sendXlsx, type RequestHeaders } from './http.ts';
import { parse } from './parse.ts';
import { RosterService } from './roster.service.ts';
import { TrialLimitsService } from './trial-limits.service.ts';

/** 企業窗口後台：員工名單和旅行社相同，其他唯讀，範圍只限自家企業。 */
@Controller('api/v1/company')
export class ContactController {
  constructor(
    @Inject(ContactService) private readonly contacts: ContactService,
    @Inject(RosterService) private readonly roster: RosterService,
    @Inject(TrialLimitsService) private readonly trials: TrialLimitsService,
  ) {}

  private ctx(h: RequestHeaders): Promise<ContactContext> {
    assertSameOrigin(h);
    return this.contacts.resolve(requestAgency(h), cookieValue(h, CONTACT_COOKIE));
  }

  private async own(h: RequestHeaders, eventId: string) {
    const ctx = await this.ctx(h);
    await this.contacts.assertOwnEvent(ctx, eventId);
    return ctx;
  }

  @Delete('session')
  @HttpCode(204)
  async logout(@Headers() h: RequestHeaders, @Res({ passthrough: true }) res: Response) {
    assertSameOrigin(h);
    await this.contacts.logout(requestAgency(h), cookieValue(h, CONTACT_COOKIE));
    res.clearCookie(CONTACT_COOKIE, contactCookieOptions(requestAgency(h)!));
  }

  @Get('password-links/:token')
  lookupLink(@Headers() h: RequestHeaders, @Param('token') token: string) {
    return this.contacts.lookupLink(requestAgency(h), token);
  }

  @Post('password-links/:token')
  @HttpCode(204)
  async setPassword(@Headers() h: RequestHeaders, @Param('token') token: string, @Body() body: { password?: unknown }) {
    assertSameOrigin(h);
    if (typeof body?.password !== 'string' || !isValidPassword(body.password)) throw new DomainError('INVALID_PASSWORD');
    await this.contacts.setPassword(requestAgency(h), token, body.password);
  }

  @Get('me')
  async me(@Headers() h: RequestHeaders) {
    const c = await this.ctx(h);
    const trial = await this.trials.status(c.agencyId);
    return { agencyName: c.agencyName, companyName: c.companyName, user: { name: c.user.name, email: c.user.email }, trialExpired: !!trial?.expired };
  }

  @Get('events')
  async events(@Headers() h: RequestHeaders) {
    return this.contacts.listEvents(await this.ctx(h));
  }

  @Get('events/:eventId/overview')
  async overview(@Headers() h: RequestHeaders, @Param('eventId') eventId: string) {
    return this.contacts.overview(await this.ctx(h), eventId);
  }

  @Get('events/:eventId/registrations')
  async registrations(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Query() q: Record<string, unknown>) {
    const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return this.contacts.listRegistrations(await this.ctx(h), eventId, { search: text(q.search), session: text(q.session), payment: text(q.payment), page: Number(q.page) || 1 });
  }

  @Get('events/:eventId/registrations/:registrationId')
  async registration(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('registrationId') registrationId: string) {
    return this.contacts.registration(await this.ctx(h), eventId, registrationId);
  }

  @Get('events/:eventId/fee-report')
  async feeReport(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Res() res: Response) {
    const file = await this.contacts.feeReport(await this.ctx(h), eventId);
    sendXlsx(res, file.name, file.content);
  }

  // ===== 員工名單 =====

  @Get('events/:eventId/employees')
  async employees(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Query() q: Record<string, unknown>) {
    const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return this.roster.list(await this.own(h, eventId), eventId, { search: text(q.search), account: text(q.account), registration: text(q.registration), page: Number(q.page) || 1 });
  }

  @Post('events/:eventId/employees')
  async createEmployee(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.roster.create(await this.own(h, eventId), eventId, parse(employeeInput, body));
  }

  @Post('events/:eventId/employees/import/preview')
  @HttpCode(200)
  async previewImport(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Req() req: Request) {
    return this.roster.previewImport(await this.own(h, eventId), eventId, req.body);
  }

  @Post('events/:eventId/employees/import')
  @HttpCode(200)
  async importEmployees(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Req() req: Request) {
    return this.roster.import(await this.own(h, eventId), eventId, req.body);
  }

  @Get('events/:eventId/employees/copy-sources')
  async copySources(@Headers() h: RequestHeaders, @Param('eventId') eventId: string) {
    return this.roster.copySources(await this.own(h, eventId), eventId);
  }

  @Post('events/:eventId/employees/copy')
  @HttpCode(200)
  async copyRoster(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    const ctx = await this.own(h, eventId);
    const { fromEventId } = parse(rosterCopyRequest, body);
    await this.contacts.assertOwnEvent(ctx, fromEventId);
    return this.roster.copyFrom(ctx, eventId, fromEventId);
  }

  @Post('events/:eventId/employees/account-emails')
  @HttpCode(202)
  async accountEmails(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.roster.sendAccountEmails(await this.own(h, eventId), eventId, parse(accountEmailRequest, body));
  }

  @Patch('events/:eventId/employees/:employeeId')
  @HttpCode(204)
  async updateEmployee(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('employeeId') employeeId: string, @Body() body: unknown) {
    await this.roster.update(await this.own(h, eventId), eventId, employeeId, parse(employeeInput, body));
  }

  @Delete('events/:eventId/employees/:employeeId')
  @HttpCode(204)
  async removeEmployee(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('employeeId') employeeId: string) {
    await this.roster.remove(await this.own(h, eventId), eventId, employeeId);
  }

  @Post('events/:eventId/employees/:employeeId/password-link')
  async passwordLink(@Headers() h: RequestHeaders, @Param('eventId') eventId: string, @Param('employeeId') employeeId: string) {
    return this.roster.issueLink(await this.own(h, eventId), eventId, employeeId);
  }
}
