import { Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SES_WEBHOOK_PATH } from './agency-path.ts';
import { SesFeedbackService } from './ses-feedback.service.ts';

/** SNS 推送 SES 退信與客訴通知的端點；內文是未解析的文字，簽章要用原始欄位驗證。 */
@Controller(SES_WEBHOOK_PATH.slice(1))
export class SesFeedbackController {
  constructor(@Inject(SesFeedbackService) private readonly feedback: SesFeedbackService) {}

  @Post()
  @HttpCode(204)
  receive(@Req() req: Request) {
    return this.feedback.handle(req.body);
  }
}
