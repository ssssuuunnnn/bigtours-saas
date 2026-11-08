import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Query, Res } from '@nestjs/common';
import { DEMO_AGENCY_CODE, trialApplicationInput } from '@bigtours/shared';
import type { Response } from 'express';
import { SESSION_COOKIE } from './access.service.ts';
import { DemoService } from './demo.service.ts';
import { DomainError } from './errors.ts';
import { assertSameOrigin, employeeCookieOptions, type RequestHeaders } from './http.ts';
import { clientIp } from './rate-limit.ts';
import { SiteService } from './site.service.ts';

/** 官網：網址可用性查詢與免費試用申請。 */
@Controller('api/v1/site')
export class SiteController {
  constructor(@Inject(SiteService) private readonly site: SiteService) {}

  @Get('code-check')
  async checkCode(@Headers() h: RequestHeaders, @Query('code') code?: string) {
    return this.site.checkCode(String(code ?? '').trim().toLowerCase(), clientIp(h));
  }

  @Post('trial-applications')
  @HttpCode(204)
  async apply(@Headers() h: RequestHeaders, @Body() body: unknown) {
    assertSameOrigin(h);
    const parsed = trialApplicationInput.safeParse(body);
    if (!parsed.success) throw new DomainError('INVALID_INPUT', { fields: [...new Set(parsed.error.issues.map((i) => String(i.path[0])))] });
    await this.site.apply(parsed.data, clientIp(h));
  }
}

/** 公開試玩：試玩旅行社（demo）的活動。登入 Cookie 與一般員工相同，限定在活動的路徑。 */
@Controller('api/v1/public/demo')
export class DemoController {
  constructor(@Inject(DemoService) private readonly demo: DemoService) {}

  @Post('start')
  async start(@Headers() h: RequestHeaders, @Res({ passthrough: true }) res: Response) {
    assertSameOrigin(h);
    const { slug, token, maxAgeMs } = await this.demo.start(clientIp(h));
    res.cookie(SESSION_COOKIE, token, { ...employeeCookieOptions(DEMO_AGENCY_CODE, slug), maxAge: maxAgeMs });
    return { agency: DEMO_AGENCY_CODE, slug };
  }
}
