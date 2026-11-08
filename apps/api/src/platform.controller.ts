import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { agencyCreateInput, agencyStatusRequest, contractInput, platformLoginRequest, quotaAdjustInput, trialStatusInput } from '@bigtours/shared';
import type { Response } from 'express';
import { DomainError } from './errors.ts';
import { assertSameOrigin, cookieValue, requestHost, type RequestHeaders } from './http.ts';
import { parse } from './parse.ts';
import { PlatformService } from './platform.service.ts';
import { SiteService } from './site.service.ts';

const COOKIE = 'bt_platform_session';
const cookieOptions = () => ({ httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/api/v1/platform' });

/** 平台後台：只接受 platform.平台網域，帳號與 Cookie 都和旅行社分開。 */
@Controller('api/v1/platform')
export class PlatformController {
  constructor(
    @Inject(PlatformService) private readonly platform: PlatformService,
    @Inject(SiteService) private readonly site: SiteService,
  ) {}

  private guard(h: RequestHeaders) {
    assertSameOrigin(h);
    this.platform.assertHost(requestHost(h));
  }

  private ctx(h: RequestHeaders) {
    this.guard(h);
    return this.platform.resolve(cookieValue(h, COOKIE));
  }

  @Post('session')
  @HttpCode(204)
  async login(@Headers() h: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    this.guard(h);
    const req = platformLoginRequest.safeParse(body);
    if (!req.success) throw new DomainError('INVALID_CREDENTIALS');
    const { token, maxAgeMs } = await this.platform.login(req.data.email, req.data.password);
    res.cookie(COOKIE, token, { ...cookieOptions(), maxAge: maxAgeMs });
  }

  @Delete('session')
  @HttpCode(204)
  async logout(@Headers() h: RequestHeaders, @Res({ passthrough: true }) res: Response) {
    this.guard(h);
    await this.platform.logout(cookieValue(h, COOKIE));
    res.clearCookie(COOKIE, cookieOptions());
  }

  @Get('me')
  async me(@Headers() h: RequestHeaders) {
    return { user: (await this.ctx(h)).user, domain: process.env.PLATFORM_DOMAIN };
  }

  @Get('tiers')
  async tiers(@Headers() h: RequestHeaders) {
    await this.ctx(h);
    return this.platform.tiers();
  }

  @Get('agencies')
  async agencies(@Headers() h: RequestHeaders, @Query('search') search?: string) {
    await this.ctx(h);
    return this.platform.list(search);
  }

  @Post('agencies')
  async create(@Headers() h: RequestHeaders, @Body() body: unknown) {
    return this.platform.create(await this.ctx(h), parse(agencyCreateInput, body));
  }

  @Get('agencies/:id')
  async detail(@Headers() h: RequestHeaders, @Param('id') id: string) {
    await this.ctx(h);
    return this.platform.detail(id);
  }

  @Patch('agencies/:id/contract')
  @HttpCode(204)
  async contract(@Headers() h: RequestHeaders, @Param('id') id: string, @Body() body: unknown) {
    await this.platform.updateContract(await this.ctx(h), id, parse(contractInput, body));
  }

  @Post('agencies/:id/quota')
  @HttpCode(204)
  async quota(@Headers() h: RequestHeaders, @Param('id') id: string, @Body() body: unknown) {
    await this.platform.adjustQuota(await this.ctx(h), id, parse(quotaAdjustInput, body));
  }

  @Patch('agencies/:id/status')
  @HttpCode(204)
  async status(@Headers() h: RequestHeaders, @Param('id') id: string, @Body() body: unknown) {
    await this.platform.setStatus(await this.ctx(h), id, parse(agencyStatusRequest, body).status);
  }

  @Post('agencies/:id/admin-link')
  @HttpCode(204)
  async adminLink(@Headers() h: RequestHeaders, @Param('id') id: string) {
    await this.ctx(h);
    await this.platform.sendAdminLink(id);
  }

  @Get('trial-applications')
  async trialApplications(@Headers() h: RequestHeaders, @Query('status') status?: string) {
    await this.ctx(h);
    return this.site.listApplications(status);
  }

  @Patch('trial-applications/:id')
  @HttpCode(204)
  async trialStatus(@Headers() h: RequestHeaders, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.ctx(h);
    await this.site.setStatus(ctx.user.id, id, parse(trialStatusInput, body).status);
  }

  @Get('usage')
  async usage(@Headers() h: RequestHeaders) {
    await this.ctx(h);
    return this.platform.usage();
  }
}
