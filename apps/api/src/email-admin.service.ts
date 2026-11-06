import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EmailTemplateInput } from '@bigtours/shared';
import type { AgencyUserContext } from './agency-admin.service.ts';
import { DatabaseService, type Tx } from './database.service.ts';
import { checkTemplate, EMAIL_TEMPLATES, templateDefinition } from './email-templates.ts';
import { DomainError } from './errors.ts';
import { MailService } from './mail.service.ts';
import { composeMail, NotificationService, type MailEvent, type MailTemplate } from './notification.service.ts';
import { RosterService } from './roster.service.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEND_CONCURRENCY = 5;

/** 測試信用的範例資料，不會用到真實報名內容。 */
const SAMPLE: Record<string, MailTemplate> = {
  account: { key: 'account', token: 'sample-token' },
  link_notice: { key: 'link_notice' },
  registration_success: { key: 'registration_success', sessionName: 'A 梯', travelers: 3, total: 31400, subsidy: 8000, selfPay: 23400, paymentInstructions: '（這裡會顯示活動的付款說明）' },
  modified: { key: 'modified', byAgency: false, total: 31750, selfPay: 23750 },
  cancel_confirmed: { key: 'cancel_confirmed' },
  cancel_rejected: { key: 'cancel_rejected' },
  deadline_reminder: { key: 'deadline_reminder', closesAt: '1/29 18:00' },
  reassigned: { key: 'reassigned', reason: '成團人數不足', changes: [{ traveler: '王小明', from: '行程 A', to: '行程 B' }], total: 31400, selfPay: 23400 },
  agency_cancel_requested: { key: 'agency_cancel_requested', employeeName: '王小明', employeeNo: 'E001', sessionName: 'A 梯', eventId: 'sample', registrationId: 'sample' },
  agency_modified: { key: 'agency_modified', employeeName: '王小明', employeeNo: 'E001', from: 31400, to: 31750, eventId: 'sample', registrationId: 'sample' },
};

/** 只把收件人的原因講給旅行社聽，技術細節留在紀錄。 */
const failureReason = (error: string | null) => (error && /\b55\d\b|user unknown|no such user|does not exist/i.test(error) ? 'mailbox' : 'server');

const formatClose = (d: Date) => {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
};

@Injectable()
export class EmailAdminService {
  private readonly logger = new Logger(EmailAdminService.name);

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(RosterService) private readonly roster: RosterService,
  ) {}

  private async assertEvent(tx: Tx, eventId: string) {
    if (!UUID.test(eventId)) throw new DomainError('NOT_FOUND');
    const { rows } = await tx.query(`SELECT id, status, notify_emails, registration_opens_at, registration_closes_at FROM events WHERE id = $1`, [eventId]);
    if (!rows[0]) throw new DomainError('NOT_FOUND');
    return rows[0];
  }

  private definition(key: string) {
    const def = templateDefinition(key);
    if (!def) throw new DomainError('NOT_FOUND');
    return def;
  }

  private assertValid(key: string, input: EmailTemplateInput) {
    const { unknown, missing } = checkTemplate(this.definition(key), input.subject, input.body);
    if (unknown.length || missing.length) throw new DomainError('TEMPLATE_INVALID', { unknown, missing });
  }

  overview(ctx: AgencyUserContext, eventId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const event = await this.assertEvent(tx, eventId);
      const { rows: saved } = await tx.query(`SELECT template_key, subject, body, sender_name FROM email_templates WHERE event_id = $1`, [eventId]);
      const byKey = new Map(saved.map((r) => [r.template_key as string, r]));
      const stats = await tx.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status IN ('failed', 'bounced'))::int AS failed
           FROM email_messages WHERE event_id = $1 AND created_at > now() - interval '7 days'`,
        [eventId],
      );
      const failures = await tx.query(
        `SELECT g.id, g.template_key, g.recipient_email, g.error, g.created_at, g.event_employee_id, m.name, m.employee_no
           FROM email_messages g LEFT JOIN event_employees m ON m.id = g.event_employee_id
          WHERE g.event_id = $1 AND g.status IN ('failed', 'bounced') AND g.resolved_at IS NULL
          ORDER BY g.created_at DESC LIMIT 100`,
        [eventId],
      );
      const reminder = await tx.query(
        `SELECT count(*) FILTER (WHERE m.email IS NOT NULL)::int AS pending, count(*) FILTER (WHERE m.email IS NULL)::int AS no_email
           FROM event_employees m
          WHERE m.event_id = $1 AND m.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.event_employee_id = m.id AND r.status <> 'cancelled')`,
        [eventId],
      );
      const last = await tx.query(
        `SELECT max(created_at) AS at FROM email_messages WHERE event_id = $1 AND template_key = 'deadline_reminder'`,
        [eventId],
      );
      return {
        notifyEmails: event.notify_emails,
        templates: EMAIL_TEMPLATES.map((d) => {
          const s = byKey.get(d.key);
          return {
            key: d.key, label: d.label, audience: d.audience, placeholders: d.placeholders, required: d.required,
            defaultSubject: d.subject, defaultBody: d.body,
            subject: s?.subject ?? d.subject, body: s?.body ?? d.body, senderName: s?.sender_name ?? null, customized: !!s,
          };
        }),
        stats: { total: stats.rows[0].total, failed: stats.rows[0].failed },
        failures: failures.rows.map((f) => ({
          id: f.id, templateKey: f.template_key, label: templateDefinition(f.template_key)?.label ?? f.template_key,
          email: f.recipient_email, employeeName: f.name, employeeNo: f.employee_no, isEmployee: !!f.event_employee_id,
          reason: failureReason(f.error), at: f.created_at,
        })),
        reminder: {
          pending: reminder.rows[0].pending, noEmail: reminder.rows[0].no_email, lastSentAt: last.rows[0].at,
          sendable: event.status === 'published' && new Date(event.registration_opens_at) <= new Date() && new Date(event.registration_closes_at) > new Date(),
        },
      };
    });
  }

  async saveNotifyEmails(ctx: AgencyUserContext, eventId: string, emails: string[]) {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertEvent(tx, eventId);
      await tx.query(`UPDATE events SET notify_emails = $2 WHERE id = $1`, [eventId, [...new Set(emails.map((e) => e.toLowerCase()))]]);
    });
  }

  async saveTemplate(ctx: AgencyUserContext, eventId: string, key: string, input: EmailTemplateInput) {
    this.assertValid(key, input);
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertEvent(tx, eventId);
      await tx.query(
        `INSERT INTO email_templates (agency_id, event_id, template_key, subject, body, sender_name) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event_id, template_key) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, sender_name = EXCLUDED.sender_name, updated_at = now()`,
        [ctx.agencyId, eventId, key, input.subject, input.body, input.senderName || null],
      );
    });
  }

  async resetTemplate(ctx: AgencyUserContext, eventId: string, key: string) {
    this.definition(key);
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertEvent(tx, eventId);
      await tx.query(`DELETE FROM email_templates WHERE event_id = $1 AND template_key = $2`, [eventId, key]);
    });
  }

  /** 用畫面上還沒儲存的內容寄給自己，不留寄送紀錄，也不會寄到員工那裡。 */
  async sendTest(ctx: AgencyUserContext, eventId: string, key: string, input: EmailTemplateInput) {
    this.assertValid(key, input);
    const { event, email } = await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertEvent(tx, eventId);
      const { rows } = await tx.query(`SELECT email FROM agency_users WHERE id = $1`, [ctx.user.id]);
      return { event: await this.notifications.mailEvent(tx, eventId), email: rows[0].email as string };
    });
    await this.mail.send(composeMail(event, { id: null, name: ctx.user.name, email }, SAMPLE[key]!, { subject: `［測試］${input.subject}`, body: input.body, sender_name: input.senderName }));
    return { to: email };
  }

  /** 只寄給還沒報名、有信箱的員工。先記錄再回應，實際寄送在背景進行。 */
  async sendReminder(ctx: AgencyUserContext, eventId: string) {
    const { event, recipients, closesAt } = await this.db.withTenant(ctx.agencyId, async (tx) => {
      const found = await this.assertEvent(tx, eventId);
      if (new Date(found.registration_closes_at) <= new Date()) throw new DomainError('REGISTRATION_CLOSED');
      if (found.status !== 'published' || new Date(found.registration_opens_at) > new Date()) throw new DomainError('REGISTRATION_NOT_OPEN');
      const { rows } = await tx.query(
        `SELECT m.id, m.name, m.email FROM event_employees m
          WHERE m.event_id = $1 AND m.status = 'active' AND m.email IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.event_employee_id = m.id AND r.status <> 'cancelled')`,
        [eventId],
      );
      return { event: await this.notifications.mailEvent(tx, eventId), recipients: rows, closesAt: formatClose(new Date(found.registration_closes_at)) };
    });
    void this.sendAll(ctx.agencyId, eventId, event, recipients, { key: 'deadline_reminder', closesAt });
    return { queued: recipients.length };
  }

  private async sendAll(agencyId: string, eventId: string, event: MailEvent, recipients: { id: string; name: string; email: string }[], template: MailTemplate) {
    const queue = [...recipients];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) await this.notifications.deliver(agencyId, eventId, event, r, template);
    };
    await Promise.all(Array.from({ length: SEND_CONCURRENCY }, worker)).catch((err) => this.logger.error(`批次寄送失敗：${(err as Error).message}`));
  }

  /** 重寄後原本這筆失敗紀錄就不再列出；可順便修正員工的信箱。帳號信會重新產生連結。 */
  async resend(ctx: AgencyUserContext, eventId: string, messageId: string, email?: string) {
    if (!UUID.test(messageId)) throw new DomainError('NOT_FOUND');
    const found = await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertEvent(tx, eventId);
      const { rows } = await tx.query(
        `SELECT g.id, g.template_key, g.payload, g.recipient_email, g.event_employee_id, m.name
           FROM email_messages g LEFT JOIN event_employees m ON m.id = g.event_employee_id
          WHERE g.id = $1 AND g.event_id = $2 AND g.status IN ('failed', 'bounced') AND g.resolved_at IS NULL FOR UPDATE OF g`,
        [messageId, eventId],
      );
      const msg = rows[0];
      if (!msg) throw new DomainError('NOT_FOUND');
      if (email && !msg.event_employee_id) throw new DomainError('INVALID_INPUT');
      if (email) await tx.query(`UPDATE event_employees SET email = $2, updated_at = now() WHERE id = $1`, [msg.event_employee_id, email]);
      await tx.query(`UPDATE email_messages SET resolved_at = now() WHERE id = $1`, [messageId]);
      return { msg, event: await this.notifications.mailEvent(tx, eventId) };
    });
    const { msg, event } = found;
    if (msg.template_key === 'account') {
      await this.roster.sendAccountEmails(ctx, eventId, { employeeIds: [msg.event_employee_id] });
      return;
    }
    const template = { ...(msg.payload ?? {}), key: msg.template_key } as unknown as MailTemplate;
    void this.notifications.deliver(ctx.agencyId, eventId, event, { id: msg.event_employee_id, name: msg.name ?? event.agency_name, email: email ?? msg.recipient_email }, template);
  }
}
