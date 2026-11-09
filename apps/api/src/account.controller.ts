import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { loginRequest, passwordLinkRequest, setPasswordRequest } from '@bigtours/shared';
import type { Response } from 'express';
import { SESSION_COOKIE } from './access.service.ts';
import { AccountService } from './account.service.ts';
import { DomainError } from './errors.ts';
import { assertSameOrigin, employeeCookieOptions, requestAgency, sendImage, sessionTokenFrom, type RequestHeaders } from './http.ts';

@Controller('api/v1/public/events/:slug')
export class AccountController {
  constructor(@Inject(AccountService) private readonly accounts: AccountService) {}

  /** 登入頁背景要在登入前顯示，所以不需登入。 */
  @Get('images/:kind')
  async image(@Headers() h: RequestHeaders, @Param('slug') slug: string, @Param('kind') kind: string, @Res() res: Response) {
    const file = await this.accounts.readImage(requestAgency(h), slug, kind);
    sendImage(res, file.contentType, file.content);
  }

  @Get('company-logo')
  async companyLogo(@Headers() h: RequestHeaders, @Param('slug') slug: string, @Res() res: Response) {
    const file = await this.accounts.readCompanyLogo(requestAgency(h), slug);
    sendImage(res, file.contentType, file.content);
  }

  @Get('landing')
  landing(@Headers() h: RequestHeaders, @Param('slug') slug: string) {
    return this.accounts.landing(requestAgency(h), slug);
  }

  @Post('session')
  @HttpCode(204)
  async login(
    @Headers() h: RequestHeaders,
    @Param('slug') slug: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    assertSameOrigin(h);
    const req = loginRequest.safeParse(body);
    if (!req.success) throw new DomainError('INVALID_CREDENTIALS');
    const { token, maxAgeMs } = await this.accounts.login(requestAgency(h), slug, req.data.employeeNo, req.data.password);
    res.cookie(SESSION_COOKIE, token, { ...employeeCookieOptions(requestAgency(h)!, slug), maxAge: maxAgeMs });
  }

  @Delete('session')
  @HttpCode(204)
  async logout(@Headers() h: RequestHeaders, @Param('slug') slug: string, @Res({ passthrough: true }) res: Response) {
    assertSameOrigin(h);
    await this.accounts.logout(requestAgency(h), sessionTokenFrom(h));
    res.clearCookie(SESSION_COOKIE, employeeCookieOptions(requestAgency(h)!, slug));
  }

  /** 連結放在 body，不進入 API 的存取紀錄。 */
  @Post('password-links/lookup')
  @HttpCode(200)
  lookup(@Headers() h: RequestHeaders, @Param('slug') slug: string, @Body() body: unknown) {
    assertSameOrigin(h);
    const req = passwordLinkRequest.safeParse(body);
    if (!req.success) throw new DomainError('LINK_INVALID');
    return this.accounts.lookupPasswordLink(requestAgency(h), slug, req.data.token);
  }

  @Post('password-links/set')
  @HttpCode(200)
  setPassword(@Headers() h: RequestHeaders, @Param('slug') slug: string, @Body() body: unknown) {
    assertSameOrigin(h);
    const req = setPasswordRequest.safeParse(body);
    if (!req.success) throw new DomainError('INVALID_PASSWORD');
    return this.accounts.setPassword(requestAgency(h), slug, req.data.token, req.data.password);
  }
}
