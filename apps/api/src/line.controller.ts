import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { lineBindRequest, lineTokenRequest } from '@bigtours/shared';
import type { Response } from 'express';
import { AccessService, SESSION_COOKIE } from './access.service.ts';
import { employeeCookieOptions } from './account.controller.ts';
import { DomainError } from './errors.ts';
import { assertSameOrigin, requestHost, sessionTokenFrom, type RequestHeaders } from './http.ts';
import { LineService } from './line.service.ts';

const token = (body: unknown) => {
  const req = lineTokenRequest.safeParse(body);
  if (!req.success) throw new DomainError('LINE_TOKEN_INVALID');
  return req.data.idToken;
};

/** LINE 登入。旅行社由網址判定；登入後與密碼登入使用同一個登入 Cookie。 */
@Controller('api/v1/public')
export class LineController {
  constructor(
    @Inject(LineService) private readonly line: LineService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  @Get('line/config')
  config(@Headers() h: RequestHeaders) {
    return this.line.config(requestHost(h));
  }

  /** ID Token 放在 body，不進入存取紀錄。 */
  @Post('line/events')
  @HttpCode(200)
  boundEvents(@Headers() h: RequestHeaders, @Body() body: unknown) {
    assertSameOrigin(h);
    return this.line.boundEvents(requestHost(h), token(body));
  }

  @Post('events/:slug/line-session')
  @HttpCode(204)
  async login(@Headers() h: RequestHeaders, @Param('slug') slug: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    assertSameOrigin(h);
    const session = await this.line.login(requestHost(h), slug, token(body));
    res.cookie(SESSION_COOKIE, session.token, { ...employeeCookieOptions(slug), maxAge: session.maxAgeMs });
  }

  @Post('events/:slug/line-binding')
  @HttpCode(204)
  async bind(@Headers() h: RequestHeaders, @Param('slug') slug: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    assertSameOrigin(h);
    const req = lineBindRequest.safeParse(body);
    if (!req.success) throw new DomainError(req.error.issues.some((i) => i.path[0] === 'idToken') ? 'LINE_TOKEN_INVALID' : 'INVALID_CREDENTIALS');
    const session = await this.line.bind(requestHost(h), slug, req.data.idToken, req.data.employeeNo, req.data.password);
    res.cookie(SESSION_COOKIE, session.token, { ...employeeCookieOptions(slug), maxAge: session.maxAgeMs });
  }

  @Get('events/:slug/line-binding')
  async status(@Headers() h: RequestHeaders, @Param('slug') slug: string) {
    assertSameOrigin(h);
    return this.line.status(await this.access.resolve(requestHost(h), slug, sessionTokenFrom(h)));
  }

  @Delete('events/:slug/line-binding')
  @HttpCode(204)
  async unbind(@Headers() h: RequestHeaders, @Param('slug') slug: string) {
    assertSameOrigin(h);
    await this.line.unbindSelf(await this.access.resolve(requestHost(h), slug, sessionTokenFrom(h)));
  }
}
