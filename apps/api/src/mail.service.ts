import { Injectable } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

export interface OutgoingMail { to: string; fromName: string; subject: string; text: string; html: string }

/**
 * 寄信只透過 SMTP：本機接 Mailpit，正式環境接 SES 的 SMTP 端點。
 * 沒有設定 SMTP_URL 時（測試環境）只把信留在 sent，不會真的寄出。
 */
@Injectable()
export class MailService {
  readonly sent: OutgoingMail[] = [];
  /** 測試用：指定收件人時模擬寄送失敗。 */
  failFor = new Set<string>();
  private readonly transport: Transporter | null;
  private readonly from: string;

  constructor() {
    const url = process.env.SMTP_URL;
    if (!url && process.env.NODE_ENV === 'production') throw new Error('缺少 SMTP_URL');
    this.transport = url ? nodemailer.createTransport(url) : null;
    // 寄件者名稱由每封信決定；MAIL_FROM 寫成「名稱 <地址>」時只取地址
    const from = process.env.MAIL_FROM ?? 'no-reply@bigtours.example';
    this.from = /<([^>]+)>/.exec(from)?.[1]?.trim() ?? from.trim();
  }

  async send(mail: OutgoingMail) {
    if (this.failFor.has(mail.to)) throw new Error('simulated failure');
    if (!this.transport) {
      this.sent.push(mail);
      return;
    }
    await this.transport.sendMail({
      from: { name: mail.fromName, address: this.from },
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  }
}
