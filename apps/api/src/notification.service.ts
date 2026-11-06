import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService, type Tx } from './database.service.ts';
import { fill, templateDefinition } from './email-templates.ts';
import { MailService } from './mail.service.ts';

export type MailTemplate =
  | { key: 'account'; token: string }
  | { key: 'link_notice' }
  | { key: 'registration_success'; sessionName: string; travelers: number; total: number; subsidy: number; selfPay: number; paymentInstructions: string | null }
  | { key: 'modified'; byAgency: boolean; total: number; selfPay: number }
  | { key: 'cancel_confirmed' }
  | { key: 'cancel_rejected' }
  | { key: 'deadline_reminder'; closesAt: string }
  | { key: 'reassigned'; reason: string; changes: { traveler: string; from: string; to: string }[]; total: number; selfPay: number }
  | { key: 'agency_cancel_requested'; employeeName: string; employeeNo: string; sessionName: string; eventId: string; registrationId: string }
  | { key: 'agency_modified'; employeeName: string; employeeNo: string; from: number; to: number; eventId: string; registrationId: string };

export interface MailEvent { name: string; slug: string; agency_code: string; agency_name: string }
/** id 為 null 表示收件人不是員工，例如旅行社的通知信箱。 */
export interface MailEmployee { id: string | null; name: string; email: string }
export interface TemplateOverride { subject: string; body: string; sender_name: string | null }

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const siteBase = (event: MailEvent) => (process.env.WEB_BASE_URL ?? 'http://{agency}.lvh.me:3000').replace('{agency}', event.agency_code);
const eventUrl = (event: MailEvent) => `${siteBase(event)}/${event.slug}`;

const money = (n: number) => `$${n.toLocaleString('en-US')}`;

/** 每封信可插入的資料。 */
function values(event: MailEvent, employee: MailEmployee, t: MailTemplate): Record<string, string> {
  const base = { 活動名稱: event.name, 旅行社名稱: event.agency_name, 報名網站連結: eventUrl(event), 員工姓名: employee.name };
  const admin = (eventId: string, registrationId: string) => `${siteBase(event)}/admin/events/${eventId}/registrations?registration=${registrationId}`;
  switch (t.key) {
    case 'account': return { ...base, 設定密碼連結: `${eventUrl(event)}/set-password/${t.token}` };
    case 'registration_success':
      return { ...base, 梯次: t.sessionName, 旅客人數: String(t.travelers), 整筆費用: money(t.total), 補助金額: money(Math.min(t.subsidy, t.total)), 自付金額: money(t.selfPay), 付款說明: t.selfPay > 0 ? t.paymentInstructions ?? '' : '' };
    case 'modified':
      return { ...base, 修改說明: t.byAgency ? `旅行社修改了您「${event.name}」的報名內容。` : `您已修改「${event.name}」的報名內容。`, 整筆費用: money(t.total), 自付金額: money(t.selfPay) };
    case 'deadline_reminder': return { ...base, 截止時間: t.closesAt };
    case 'reassigned':
      return { ...base, 改派原因: t.reason, 改派內容: t.changes.map((c) => `${c.traveler}：${c.from} → ${c.to}`).join('\n'), 整筆費用: money(t.total), 自付金額: money(t.selfPay) };
    case 'agency_cancel_requested':
      return { ...base, 員工姓名: t.employeeName, 員工編號: t.employeeNo, 梯次: t.sessionName, 後台連結: admin(t.eventId, t.registrationId) };
    case 'agency_modified':
      return { ...base, 員工姓名: t.employeeName, 員工編號: t.employeeNo, 原費用: money(t.from), 整筆費用: money(t.to), 後台連結: admin(t.eventId, t.registrationId) };
    default: return base;
  }
}

const linkify = (escaped: string) => escaped.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`);

export function composeMail(event: MailEvent, employee: MailEmployee, t: MailTemplate, override: TemplateOverride | null = null) {
  const def = templateDefinition(t.key)!;
  const data = values(event, employee, t);
  const body = fill(override?.body ?? def.body, data);
  // 沒有內容的段落（例如不用付款時的付款說明）不留空行。
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return {
    to: employee.email,
    fromName: override?.sender_name || event.agency_name,
    subject: fill(override?.subject ?? def.subject, data).replace(/\s+/g, ' ').trim(),
    text: paragraphs.join('\n\n'),
    html: paragraphs.map((p) => `<p>${linkify(escapeHtml(p)).replace(/\n/g, '<br>')}</p>`).join(''),
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

  /** existingRow：呼叫前已記錄「寄送中」的信。帳號信的連結不存進資料庫。 */
  async deliver(agencyId: string, eventId: string, event: MailEvent, employee: MailEmployee, template: MailTemplate, existingRow = false) {
    const { override, messageId } = await this.db.withTenant(agencyId, async (tx) => {
      const { rows } = await tx.query(`SELECT subject, body, sender_name FROM email_templates WHERE event_id = $1 AND template_key = $2`, [eventId, template.key]);
      const { key, ...data } = template;
      const payload = key === 'account' ? null : JSON.stringify(data);
      if (existingRow) {
        const found = await tx.query(
          `UPDATE email_messages SET payload = $3 WHERE id = (SELECT id FROM email_messages WHERE event_employee_id = $1 AND template_key = $2 ORDER BY created_at DESC LIMIT 1) RETURNING id`,
          [employee.id, key, payload],
        );
        return { override: rows[0] ?? null, messageId: found.rows[0]?.id as string };
      }
      const inserted = await tx.query(
        `INSERT INTO email_messages (agency_id, event_id, event_employee_id, recipient_email, template_key, idempotency_key, payload) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [agencyId, eventId, employee.id, employee.email, key, randomUUID(), payload],
      );
      return { override: rows[0] ?? null, messageId: inserted.rows[0].id as string };
    });
    try {
      await this.mail.send(composeMail(event, employee, template, override));
      await this.mark(agencyId, messageId, 'sent', null);
    } catch (err) {
      this.logger.error(`寄信失敗：${(err as Error).message}`);
      await this.mark(agencyId, messageId, 'failed', (err as Error).message.slice(0, 500));
    }
  }

  /** 把信寄給這個活動設定的旅行社通知信箱；沒設定就不寄，待處理項目仍會顯示在後台。 */
  async notifyAgency(agencyId: string, eventId: string, template: MailTemplate) {
    try {
      const { event, emails } = await this.db.withTenant(agencyId, async (tx) => {
        const { rows } = await tx.query(`SELECT notify_emails FROM events WHERE id = $1`, [eventId]);
        return { event: await this.mailEvent(tx, eventId), emails: (rows[0]?.notify_emails ?? []) as string[] };
      });
      await Promise.all(emails.map((email) => this.deliver(agencyId, eventId, event, { id: null, name: event.agency_name, email }, template)));
    } catch (err) {
      this.logger.error(`通知旅行社失敗：${(err as Error).message}`);
    }
  }

  private mark(agencyId: string, id: string, status: 'sent' | 'failed', error: string | null) {
    return this.db.withTenant(agencyId, (tx) => tx.query(
      `UPDATE email_messages SET status = $2, error = $3, sent_at = CASE WHEN $2 = 'sent' THEN now() END WHERE id = $1`,
      [id, status, error],
    ));
  }

  markLatest(agencyId: string, employeeId: string, template: string, status: 'sent' | 'failed', error: string | null) {
    return this.db.withTenant(agencyId, (tx) => tx.query(
      `UPDATE email_messages SET status = $3, error = $4, sent_at = CASE WHEN $3 = 'sent' THEN now() END
        WHERE id = (SELECT id FROM email_messages WHERE event_employee_id = $1 AND template_key = $2 ORDER BY created_at DESC LIMIT 1)`,
      [employeeId, template, status, error],
    ));
  }
}
