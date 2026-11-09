import { Inject, Injectable, Logger } from '@nestjs/common';
import { generateToken, hashPassword, verifyPassword } from '@bigtours/shared/crypto';
import { AccessService } from './access.service.ts';
import type { AgencyUserContext } from './agency-admin.service.ts';
import { DatabaseService, type Tx } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { DomainError } from './errors.ts';
import { ExportService } from './export.service.ts';
import { MailService } from './mail.service.ts';
import { TrialLimitsService } from './trial-limits.service.ts';
import { RegistrationAdminService } from './registration-admin.service.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINK_DAYS = 14;
const SESSION_HOURS = 12;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const DUMMY_HASH = hashPassword('not-a-real-password-0');

export interface ContactContext {
  agencyId: string;
  agencyCode: string;
  agencyName: string;
  companyId: string;
  companyName: string;
  actorType: 'company_contact';
  user: { id: string; name: string; email: string };
}

const siteBase = (agencyCode: string) => (process.env.WEB_BASE_URL ?? 'http://localhost:3000/{agency}').replace('{agency}', agencyCode);

@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(TrialLimitsService) private readonly trials: TrialLimitsService,
    @Inject(RegistrationAdminService) private readonly regs: RegistrationAdminService,
    @Inject(ExportService) private readonly exports: ExportService,
  ) {}

  // ===== 登入 =====

  /** 共用登入頁用這個判斷該走哪種帳號。 */
  async isContactEmail(agencyCode: string | undefined, email: string) {
    const agency = await this.access.findAgency(agencyCode);
    return this.db.withTenant(agency.id, async (tx) => (await tx.query(`SELECT 1 FROM company_contacts WHERE email = $1`, [email])).rowCount === 1);
  }

  async login(agencyCode: string | undefined, email: string, password: string) {
    const agency = await this.access.findAgency(agencyCode);
    const contact = await this.db.withTenant(agency.id, async (tx) => {
      const { rows } = await tx.query(`SELECT id, password_hash, locked_until > now() AS locked FROM company_contacts WHERE email = $1 AND status = 'active'`, [email]);
      return rows[0] as { id: string; password_hash: string | null; locked: boolean | null } | undefined;
    });
    const matched = await verifyPassword(password, contact?.password_hash ?? (await DUMMY_HASH));
    if (!contact?.password_hash || contact.locked) throw new DomainError('INVALID_CREDENTIALS');
    if (!matched) {
      await this.db.withTenant(agency.id, (tx) => tx.query(
        `UPDATE company_contacts
            SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
                locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE id = $1`,
        [contact.id, MAX_FAILED_LOGINS, LOCK_MINUTES],
      ));
      throw new DomainError('INVALID_CREDENTIALS');
    }
    const token = generateToken();
    await this.db.withTenant(agency.id, async (tx) => {
      await tx.query(`UPDATE company_contacts SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [contact.id]);
      await tx.query(`DELETE FROM company_contact_sessions WHERE contact_id = $1 AND expires_at <= now()`, [contact.id]);
      await tx.query(
        `INSERT INTO company_contact_sessions (agency_id, contact_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
        [agency.id, contact.id, this.encryption.hashToken(token), SESSION_HOURS],
      );
    });
    return { token, maxAgeMs: SESSION_HOURS * 3_600_000 };
  }

  async logout(agencyCode: string | undefined, token: string | undefined) {
    if (!token) return;
    const agency = await this.access.findAgency(agencyCode);
    await this.db.withTenant(agency.id, (tx) => tx.query(`UPDATE company_contact_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [this.encryption.hashToken(token)]));
  }

  async resolve(agencyCode: string | undefined, token: string | undefined): Promise<ContactContext> {
    const agency = await this.access.findAgency(agencyCode);
    if (!token) throw new DomainError('UNAUTHENTICATED');
    const c = await this.db.withTenant(agency.id, async (tx) => {
      const { rows } = await tx.query(
        `SELECT k.id, k.name, k.email, k.company_id, co.name AS company_name
           FROM company_contact_sessions s JOIN company_contacts k ON k.id = s.contact_id JOIN companies co ON co.id = k.company_id
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND k.status = 'active'`,
        [this.encryption.hashToken(token)],
      );
      return rows[0];
    });
    if (!c) throw new DomainError('UNAUTHENTICATED');
    return { agencyId: agency.id, agencyCode: agency.code, agencyName: agency.name, companyId: c.company_id, companyName: c.company_name, actorType: 'company_contact', user: { id: c.id, name: c.name, email: c.email } };
  }

  // ===== 旅行社管理窗口帳號 =====

  private async assertCompany(tx: Tx, companyId: string) {
    if (!UUID.test(companyId)) throw new DomainError('NOT_FOUND');
    const { rowCount } = await tx.query(`SELECT 1 FROM companies WHERE id = $1`, [companyId]);
    if (!rowCount) throw new DomainError('NOT_FOUND');
  }

  listContacts(ctx: AgencyUserContext, companyId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertCompany(tx, companyId);
      const { rows } = await tx.query(`SELECT id, name, email, status, password_hash IS NOT NULL AS activated FROM company_contacts WHERE company_id = $1 ORDER BY created_at`, [companyId]);
      return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, status: r.status, activated: r.activated }));
    });
  }

  /** 同一個 Email 不能同時是旅行社人員和窗口，登入時才判斷得出身分。 */
  async createContact(ctx: AgencyUserContext, companyId: string, input: { name: string; email: string }) {
    const id = await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertCompany(tx, companyId);
      const staff = await tx.query(`SELECT 1 FROM agency_users WHERE email = $1`, [input.email]);
      if (staff.rowCount) throw new DomainError('EMAIL_TAKEN');
      const { rows } = await tx.query(
        `INSERT INTO company_contacts (agency_id, company_id, email, name, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [ctx.agencyId, companyId, input.email, input.name, ctx.user.id],
      );
      return rows[0].id as string;
    }).catch((e) => {
      if ((e as { code?: string }).code === '23505') throw new DomainError('EMAIL_TAKEN');
      throw e;
    });
    await this.sendLink(ctx, companyId, id);
    return { id };
  }

  /** 寄邀請或重設連結；舊連結立即失效。寄信失敗要讓操作者知道，所以等寄完才回應。 */
  async sendLink(ctx: AgencyUserContext, companyId: string, contactId: string) {
    await this.trials.consumeMail(ctx.agencyId);
    const token = generateToken();
    const c = await this.db.withTenant(ctx.agencyId, async (tx) => {
      if (!UUID.test(contactId)) throw new DomainError('NOT_FOUND');
      const { rows } = await tx.query(
        `SELECT k.id, k.name, k.email, k.password_hash IS NOT NULL AS activated, co.name AS company_name, a.code AS agency_code, a.name AS agency_name
           FROM company_contacts k JOIN companies co ON co.id = k.company_id JOIN agencies a ON a.id = k.agency_id
          WHERE k.id = $1 AND k.company_id = $2 AND k.status = 'active' FOR UPDATE OF k`,
        [contactId, companyId],
      );
      if (!rows[0]) throw new DomainError('NOT_FOUND');
      await tx.query(`UPDATE company_contact_links SET revoked_at = now() WHERE contact_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [contactId]);
      await tx.query(
        `INSERT INTO company_contact_links (agency_id, contact_id, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
        [ctx.agencyId, contactId, this.encryption.hashToken(token), ctx.user.id, LINK_DAYS],
      );
      await tx.query(
        `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id) VALUES ($1, 'agency_user', $2, 'contact.link_sent', 'company_contact', $3)`,
        [ctx.agencyId, ctx.user.id, contactId],
      );
      return rows[0];
    });
    const url = `${siteBase(c.agency_code)}/company/set-password/${token}`;
    const lines = [
      `${c.name} 您好：`,
      c.activated ? `${c.agency_name} 為您發送了重設密碼連結，請點下方連結設定新密碼。` : `${c.agency_name} 邀請您管理「${c.company_name}」的活動名單與員工帳號，請點下方連結設定密碼。`,
      url,
      `連結 ${LINK_DAYS} 天內有效，只能使用一次。`,
    ];
    try {
      await this.mail.send({
        to: c.email, fromName: c.agency_name,
        subject: c.activated ? `【${c.company_name}】重設企業窗口密碼` : `【${c.company_name}】企業窗口帳號邀請`,
        text: lines.join('\n\n'),
        html: lines.map((l) => (l === url ? `<p><a href="${url}">${url}</a></p>` : `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`)).join(''),
      });
    } catch (err) {
      this.logger.error(`窗口邀請信失敗：${(err as Error).message}`);
      throw new DomainError('MAIL_FAILED');
    }
  }

  /** 停用時登入狀態和未使用的連結一併失效。 */
  async setStatus(ctx: AgencyUserContext, companyId: string, contactId: string, status: 'active' | 'disabled') {
    if (!UUID.test(contactId)) throw new DomainError('NOT_FOUND');
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      const { rowCount } = await tx.query(`UPDATE company_contacts SET status = $3 WHERE id = $1 AND company_id = $2`, [contactId, companyId, status]);
      if (!rowCount) throw new DomainError('NOT_FOUND');
      if (status === 'disabled') {
        await tx.query(`UPDATE company_contact_sessions SET revoked_at = now() WHERE contact_id = $1 AND revoked_at IS NULL`, [contactId]);
        await tx.query(`UPDATE company_contact_links SET revoked_at = now() WHERE contact_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [contactId]);
      }
      await tx.query(
        `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id, metadata) VALUES ($1, 'agency_user', $2, 'contact.status_changed', 'company_contact', $3, $4)`,
        [ctx.agencyId, ctx.user.id, contactId, JSON.stringify({ status })],
      );
    });
  }

  // ===== 設定密碼 =====

  async lookupLink(agencyCode: string | undefined, token: string) {
    const agency = await this.access.findAgency(agencyCode);
    const row = await this.db.withTenant(agency.id, async (tx) => (await tx.query(
      `SELECT k.name, co.name AS company_name FROM company_contact_links l JOIN company_contacts k ON k.id = l.contact_id JOIN companies co ON co.id = k.company_id
        WHERE l.token_hash = $1 AND l.used_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > now() AND k.status = 'active'`,
      [this.encryption.hashToken(token)],
    )).rows[0]);
    if (!row) throw new DomainError('LINK_INVALID');
    return { name: row.name as string, companyName: row.company_name as string, agencyName: agency.name };
  }

  async setPassword(agencyCode: string | undefined, token: string, password: string) {
    const agency = await this.access.findAgency(agencyCode);
    const passwordHash = await hashPassword(password);
    await this.db.withTenant(agency.id, async (tx) => {
      const used = await tx.query(
        `UPDATE company_contact_links l SET used_at = now() FROM company_contacts k
          WHERE l.token_hash = $1 AND l.used_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > now() AND k.id = l.contact_id AND k.status = 'active'
        RETURNING k.id`,
        [this.encryption.hashToken(token)],
      );
      const id = used.rows[0]?.id;
      if (!id) throw new DomainError('LINK_INVALID');
      await tx.query(`UPDATE company_contacts SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1`, [id, passwordHash]);
      await tx.query(`UPDATE company_contact_sessions SET revoked_at = now() WHERE contact_id = $1 AND revoked_at IS NULL`, [id]);
      await tx.query(`INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id) VALUES ($1, 'company_contact', $2, 'contact.password_set', 'company_contact', $2)`, [agency.id, id]);
    });
  }

  // ===== 窗口看到的資料：只限自家企業 =====

  /** 別家企業的活動一律視為不存在。 */
  async assertOwnEvent(ctx: ContactContext, eventId: string) {
    if (!UUID.test(eventId)) throw new DomainError('NOT_FOUND');
    const { rowCount } = await this.db.withTenant(ctx.agencyId, (tx) => tx.query(`SELECT 1 FROM events WHERE id = $1 AND company_id = $2`, [eventId, ctx.companyId]));
    if (!rowCount) throw new DomainError('NOT_FOUND');
  }

  private eventSummary = `
    SELECT e.id, e.name, e.status, e.registration_opens_at, e.registration_closes_at,
           (SELECT count(*)::int FROM event_employees m WHERE m.event_id = e.id AND m.status = 'active') AS roster,
           (SELECT count(*)::int FROM registrations r WHERE r.event_id = e.id AND r.status <> 'cancelled') AS registered,
           (SELECT count(*)::int FROM event_sessions s WHERE s.event_id = e.id) AS session_count,
           (SELECT min(s.departs_on) FROM event_sessions s WHERE s.event_id = e.id) AS first_day,
           (SELECT max(s.returns_on) FROM event_sessions s WHERE s.event_id = e.id) AS last_day
      FROM events e`;

  private summaryRow(e: any) {
    const now = Date.now();
    const closes = e.registration_closes_at ? new Date(e.registration_closes_at).getTime() : null;
    const opens = e.registration_opens_at ? new Date(e.registration_opens_at).getTime() : null;
    const state = e.status !== 'published' ? 'draft' : closes !== null && closes <= now ? 'closed' : opens !== null && opens > now ? 'not_open' : 'open';
    return {
      id: e.id, name: e.name, state, registrationOpensAt: e.registration_opens_at, registrationClosesAt: e.registration_closes_at,
      roster: e.roster, registered: e.registered, sessionCount: e.session_count, firstDay: e.first_day, lastDay: e.last_day,
    };
  }

  listEvents(ctx: ContactContext) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const { rows } = await tx.query(`${this.eventSummary} WHERE e.company_id = $1 ORDER BY e.created_at DESC`, [ctx.companyId]);
      return rows.map((e) => this.summaryRow(e));
    });
  }

  async overview(ctx: ContactContext, eventId: string) {
    await this.assertOwnEvent(ctx, eventId);
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const { rows } = await tx.query(`${this.eventSummary} WHERE e.id = $1`, [eventId]);
      const accounts = await tx.query(`SELECT count(*)::int AS n FROM event_employees WHERE event_id = $1 AND status = 'active' AND password_hash IS NULL`, [eventId]);
      const money = await tx.query(`SELECT COALESCE(sum(LEAST(subsidy_amount, total_amount)), 0)::int AS subsidy FROM registrations WHERE event_id = $1 AND status <> 'cancelled'`, [eventId]);
      const sessions = await tx.query(
        `SELECT s.id, s.name, s.departs_on, s.returns_on, s.sold_count FROM event_sessions s WHERE s.event_id = $1 ORDER BY s.sort_order, s.name`,
        [eventId],
      );
      return {
        ...this.summaryRow(rows[0]),
        accountsPending: accounts.rows[0].n,
        subsidyTotal: money.rows[0].subsidy,
        sessions: sessions.rows.map((s) => ({ id: s.id, name: s.name, departsOn: s.departs_on, returnsOn: s.returns_on, travelers: s.sold_count })),
      };
    });
  }

  private agencyLike(ctx: ContactContext) {
    return { agencyId: ctx.agencyId, agencyCode: ctx.agencyCode, agencyName: ctx.agencyName, user: { id: ctx.user.id, name: ctx.user.name, role: 'company_contact', pinnedNavItems: [] } } as unknown as AgencyUserContext;
  }

  /** 已取消的報名也列出，和設計一致；補助合計不計入。 */
  async listRegistrations(ctx: ContactContext, eventId: string, q: { search?: string; session?: string; payment?: string; page?: number }) {
    await this.assertOwnEvent(ctx, eventId);
    const page = await this.regs.list(this.agencyLike(ctx), eventId, { ...q, status: 'all' });
    return {
      rows: page.rows.map(({ id, employeeName, employeeNo, sessionName, travelerCount, totalAmount, subsidyAmount, selfPayAmount, paymentStatus, status }) => ({ id, employeeName, employeeNo, sessionName, travelerCount, totalAmount, subsidyAmount, selfPayAmount, paymentStatus, status })),
      total: page.total, page: page.page, pageSize: page.pageSize, registrations: page.registrations, travelers: page.travelers, sessions: page.sessions,
    };
  }

  /** 只挑窗口可以看的欄位：旅客填的資料（含遮罩）與修改紀錄都不給。 */
  async registration(ctx: ContactContext, eventId: string, registrationId: string) {
    await this.assertOwnEvent(ctx, eventId);
    const r = await this.regs.detail(this.agencyLike(ctx), eventId, registrationId);
    return {
      id: r.id, employeeName: r.employeeName, employeeNo: r.employeeNo, sessionName: r.sessionName, status: r.status,
      totalAmount: r.totalAmount, subsidyApplied: r.subsidyApplied, selfPayAmount: r.selfPayAmount, paymentStatus: r.paymentStatus,
      cancelRequestedAt: r.cancelRequestedAt, cancelledAt: r.cancelledAt,
      travelers: r.travelers.map((t) => ({
        id: t.id, name: t.name, typeName: t.typeName, roomTypeName: t.roomType?.name ?? null,
        options: (t.options as { name: string }[]).map((o) => o.name), fee: t.fee,
      })),
    };
  }

  async feeReport(ctx: ContactContext, eventId: string) {
    await this.assertOwnEvent(ctx, eventId);
    return this.exports.feeReport(ctx.agencyId, eventId);
  }
}
