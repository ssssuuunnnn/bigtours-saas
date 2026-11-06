import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService, type Tx } from './database.service.ts';
import { MailService } from './mail.service.ts';

export type MailTemplate =
  | { key: 'account'; token: string }
  | { key: 'link_notice' }
  | { key: 'cancel_confirmed' }
  | { key: 'cancel_rejected' }
  | { key: 'reassigned'; reason: string; changes: { traveler: string; from: string; to: string }[]; total: number; selfPay: number };

export interface MailEvent { name: string; slug: string; agency_code: string; agency_name: string }
export interface MailEmployee { id: string; name: string; email: string }

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function eventUrl(event: MailEvent) {
  const base = process.env.WEB_BASE_URL ?? 'http://{agency}.lvh.me:3000';
  return `${base.replace('{agency}', event.agency_code)}/${event.slug}`;
}

const money = (n: number) => `$${n.toLocaleString('en-US')}`;

/** 範本先寫在程式裡，旅行社調整範本的功能完成後改由資料庫提供。信中不放身分證、護照等敏感資料。 */
export function composeMail(event: MailEvent, employee: MailEmployee, t: MailTemplate) {
  const hello = `${employee.name} 您好：`;
  const site = eventUrl(event);
  const content = (): { subject: string; paragraphs: string[] } => {
    switch (t.key) {
      case 'account':
        return {
          subject: `【${event.name}】請設定報名網站密碼`,
          paragraphs: [hello, `「${event.name}」已開放帳號設定，請點下方連結設定密碼，之後以員工編號與這組密碼登入報名網站。`, `${site}/set-password/${t.token}`, '這個連結 14 天內有效，只能使用一次。如果您不需要報名，可以忽略這封信。'],
        };
      case 'link_notice':
        return {
          subject: `【${event.name}】設定密碼連結已產生`,
          paragraphs: [hello, `有人為您產生了「${event.name}」的設定密碼連結，連結會由承辦人員另外提供給您，這封信不含連結。`, '如果您不知道這件事，請聯繫公司的活動窗口。'],
        };
      case 'cancel_confirmed':
        return {
          subject: `【${event.name}】您的報名已取消`,
          paragraphs: [hello, `您申請取消「${event.name}」的報名已生效，名額已釋出。退費請依合約由旅行社處理。`, `如果還想參加，可以登入重新報名，但名額以當下剩餘為準：`, site],
        };
      case 'cancel_rejected':
        return {
          subject: `【${event.name}】您的取消申請未通過`,
          paragraphs: [hello, `旅行社退回了您取消「${event.name}」報名的申請，您的報名仍然有效。如有疑問，請聯繫活動的服務人員。`, site],
        };
      case 'reassigned':
        return {
          subject: `【${event.name}】您的自選行程已改派`,
          paragraphs: [
            hello,
            `因為「${t.reason}」，旅行社調整了以下旅客的自選行程：`,
            ...t.changes.map((c) => `${c.traveler}：${c.from} → ${c.to}`),
            `調整後整筆費用 ${money(t.total)}，您需自付 ${money(t.selfPay)}。已付款的差額由旅行社處理。`,
            '如果不滿意改派結果，報名截止前可以登入修改，截止後請聯繫旅行社：',
            site,
          ],
        };
    }
  };
  const { subject, paragraphs } = content();
  return {
    to: employee.email,
    fromName: event.agency_name,
    subject,
    text: paragraphs.join('\n\n'),
    html: paragraphs.map((p) => (p.startsWith('http') ? `<p><a href="${escapeHtml(p)}">${escapeHtml(p)}</a></p>` : `<p>${escapeHtml(p)}</p>`)).join(''),
  };
}

/** 寄信與寄送狀態都在這裡。失敗不影響原本的操作，狀態留在 email_messages。 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  async mailEvent(tx: Tx, eventId: string): Promise<MailEvent> {
    const { rows } = await tx.query(
      `SELECT e.name, e.slug, a.code AS agency_code, a.name AS agency_name FROM events e JOIN agencies a ON a.id = e.agency_id WHERE e.id = $1`,
      [eventId],
    );
    return rows[0];
  }

  /** existingRow：呼叫前已記錄「寄送中」的信。 */
  async deliver(agencyId: string, eventId: string, event: MailEvent, employee: MailEmployee, template: MailTemplate, existingRow = false) {
    if (!existingRow) {
      await this.db.withTenant(agencyId, (tx) => tx.query(
        `INSERT INTO email_messages (agency_id, event_id, event_employee_id, recipient_email, template_key, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6)`,
        [agencyId, eventId, employee.id, employee.email, template.key, randomUUID()],
      ));
    }
    try {
      await this.mail.send(composeMail(event, employee, template));
      await this.markLatest(agencyId, employee.id, template.key, 'sent', null);
    } catch (err) {
      this.logger.error(`寄信失敗：${(err as Error).message}`);
      await this.markLatest(agencyId, employee.id, template.key, 'failed', (err as Error).message.slice(0, 500));
    }
  }

  markLatest(agencyId: string, employeeId: string, template: string, status: 'sent' | 'failed', error: string | null) {
    return this.db.withTenant(agencyId, (tx) => tx.query(
      `UPDATE email_messages SET status = $3, error = $4, sent_at = CASE WHEN $3 = 'sent' THEN now() END
        WHERE id = (SELECT id FROM email_messages WHERE event_employee_id = $1 AND template_key = $2 ORDER BY created_at DESC LIMIT 1)`,
      [employeeId, template, status, error],
    ));
  }
}
