import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Put, Res } from '@nestjs/common';
import { draftRequest, holdRequest, submitRequest, updateHoldRequest } from '@bigtours/shared';
import type { Response } from 'express';
import type { ZodType } from 'zod';
import { AccessService } from './access.service.ts';
import { DomainError } from './errors.ts';
import { assertSameOrigin, requestHost, sendPdf, sessionTokenFrom } from './http.ts';
import { RegistrationService } from './registration.service.ts';

function parse<T>(schema: ZodType<T, any, any>, body: unknown, code: 'INVALID_SELECTION' | 'INVALID_DETAILS'): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new DomainError(code, { reason: 'schema', issues: result.error.issues.map((i) => i.path.join('.')) });
  return result.data;
}

/** 員工前台：以登入 Cookie 識別。旅行社由網址判定，反向代理會帶入 x-forwarded-host。 */
@Controller('api/v1/public/events/:slug')
export class PublicController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(RegistrationService) private readonly registrations: RegistrationService,
  ) {}

  private ctx(headers: Record<string, string | undefined>, slug: string) {
    assertSameOrigin(headers);
    return this.access.resolve(requestHost(headers), slug, sessionTokenFrom(headers));
  }

  @Get()
  async state(@Headers() h: Record<string, string>, @Param('slug') slug: string) {
    return this.registrations.getState(await this.ctx(h, slug));
  }

  @Get('terms')
  async terms(@Headers() h: Record<string, string>, @Param('slug') slug: string, @Res() res: Response) {
    const file = await this.registrations.readTerms(await this.ctx(h, slug));
    sendPdf(res, file.name, file.content);
  }

  @Get('options/:optionId/pdf')
  async optionPdf(@Headers() h: Record<string, string>, @Param('slug') slug: string, @Param('optionId') optionId: string, @Res() res: Response) {
    const file = await this.registrations.readOptionPdf(await this.ctx(h, slug), optionId);
    sendPdf(res, file.name, file.content);
  }

  @Get('availability')
  async availability(@Headers() h: Record<string, string>, @Param('slug') slug: string) {
    return this.registrations.getAvailability(await this.ctx(h, slug));
  }

  @Post('holds')
  async createHold(@Headers() h: Record<string, string>, @Param('slug') slug: string, @Body() body: unknown) {
    return this.registrations.createHold(await this.ctx(h, slug), parse(holdRequest, body, 'INVALID_SELECTION'));
  }

  @Patch('holds/current')
  async updateHold(@Headers() h: Record<string, string>, @Param('slug') slug: string, @Body() body: unknown) {
    const req = parse(updateHoldRequest, body, 'INVALID_SELECTION');
    return this.registrations.updateHold(await this.ctx(h, slug), req.travelers);
  }

  @Delete('holds/current')
  @HttpCode(204)
  async releaseHold(@Headers() h: Record<string, string>, @Param('slug') slug: string) {
    await this.registrations.releaseHold(await this.ctx(h, slug));
  }

  @Put('draft')
  @HttpCode(204)
  async saveDraft(@Headers() h: Record<string, string>, @Param('slug') slug: string, @Body() body: unknown) {
    await this.registrations.saveDraft(await this.ctx(h, slug), parse(draftRequest, body, 'INVALID_DETAILS'));
  }

  @Post('registrations')
  async submit(@Headers() h: Record<string, string>, @Param('slug') slug: string, @Body() body: unknown) {
    return this.registrations.submit(await this.ctx(h, slug), parse(submitRequest, body, 'INVALID_DETAILS'));
  }

  @Post('registrations/current/cancel-request')
  @HttpCode(200)
  async cancel(@Headers() h: Record<string, string>, @Param('slug') slug: string) {
    return this.registrations.requestCancel(await this.ctx(h, slug));
  }
}
