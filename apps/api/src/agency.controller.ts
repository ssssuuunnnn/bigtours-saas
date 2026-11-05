import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Put, Res } from '@nestjs/common';
import { agencyLoginRequest, fieldInput, orderRequest, pinnedNavRequest, sessionInput, type AgencyPermission } from '@bigtours/shared';
import type { Response } from 'express';
import type { ZodType } from 'zod';
import { AgencyAdminService } from './agency-admin.service.ts';
import { DomainError } from './errors.ts';
import { assertSameOrigin, cookieValue, requestHost, type RequestHeaders } from './http.ts';

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
  constructor(@Inject(AgencyAdminService) private readonly admin: AgencyAdminService) {}

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
}
