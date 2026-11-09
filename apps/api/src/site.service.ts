import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { agencyCodeFormat, TRIAL_LIMITS, type CodeCheck, type TrialApplicationInput } from '@bigtours/shared';
import { generateToken, hashPassword } from '@bigtours/shared/crypto';
import { DatabaseService, type Tx } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { DomainError } from './errors.ts';
import { MailService } from './mail.service.ts';
import { RateLimiter } from './rate-limit.ts';
import { StaffService } from './staff.service.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PER_IP_PER_HOUR = 5;
const PER_EMAIL_PER_DAY = 3;
const BRAND = 'Bookdex 大團報名';
const TODAY = `(now() AT TIME ZONE 'Asia/Taipei')::date`;
/** 還在進行中的申請：網址與統編都被保留 */
const OPEN = `(status = 'pending' OR (status = 'unverified' AND token_expires_at > now()))`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** 平台網址，例如 https://bigtour.bookdex.cc（由旅行社網址的格式推得）。 */
const siteBase = () => (process.env.WEB_BASE_URL ?? 'http://localhost:3000/{agency}').replace(/\/?\{agency\}.*$/, '');

export type TrialApplicationStatus = 'unverified' | 'pending' | 'approved' | 'rejected' | 'expired';

export interface TrialApplicationRow {
  id: string;
  agencyName: string;
  code: string;
  taxId: string | null;
  contactName: string;
  phone: string;
  email: string;
  expectedSize: string;
  note: string | null;
  status: TrialApplicationStatus;
  createdAt: Date;
  verifiedAt: Date | null;
  handledAt: Date | null;
  handledByName: string | null;
  agencyId: string | null;
  codeTaken: boolean;
}

export type ActivationInfo =
  | { state: 'ready'; mode: 'auto' | 'manual'; agencyName: string; code: string; email: string; contactName: string }
  | { state: 'pending' }
  | { state: 'activated'; code: string };

interface ApplicationRow {
  id: string; agency_name: string; code: string; tax_id: string; contact_name: string; email: string; status: TrialApplicationStatus; token_expires_at: Date | null;
}

/**
 * 官網（平台網域本身）：試用申請與自助開通（PRD 15.3）。申請屬於平台，不屬於任何旅行社。
 * 申請 → 寄驗證信 → 點連結：自動開通時設定密碼即開通；關閉自動開通時改為等待平台核准。
 */
@Injectable()
export class SiteService {
  private readonly logger = new Logger(SiteService.name);
  private readonly checkLimiter = new RateLimiter(60, 60_000);
  private readonly activationLimiter = new RateLimiter(20, 10 * 60_000);

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
    @Inject(StaffService) private readonly staff: StaffService,
  ) {}

  async checkCode(code: string, ip: string | null): Promise<CodeCheck> {
    this.checkLimiter.hit(ip ?? 'unknown');
    const format = agencyCodeFormat(code);
    if (!format.available) return format;
    const { rows } = await this.db.pool.query(
      `SELECT EXISTS (SELECT 1 FROM agencies WHERE code = $1) OR EXISTS (SELECT 1 FROM trial_applications WHERE code = $1 AND ${OPEN}) AS taken`,
      [code],
    );
    return rows[0].taken ? { available: false, reason: 'taken' } : { available: true };
  }

  async autoApprove(): Promise<boolean> {
    const { rows } = await this.db.pool.query(`SELECT value FROM platform_settings WHERE key = 'trial_auto_approve'`);
    return rows[0]?.value !== false;
  }

  async setAutoApprove(actorId: string, on: boolean) {
    await this.db.pool.query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ('trial_auto_approve', $1::jsonb, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [JSON.stringify(on), actorId],
    );
  }

  /**
   * 送出申請：保留網址與統編 24 小時，寄出驗證信。機器人填了陷阱欄位時假裝成功，不寫入也不寄信。
   * 一個統編只能試用一次（已開通過或已有旅行社使用就不能再申請）；被退回的申請不算。
   */
  async apply(input: TrialApplicationInput, ip: string | null) {
    if (input.website) return;
    const recent = await this.db.pool.query(
      `SELECT count(*) FILTER (WHERE ip_address = $1 AND created_at > now() - interval '1 hour')::int AS by_ip,
              count(*) FILTER (WHERE email = $2 AND created_at > now() - interval '1 day')::int AS by_email
         FROM trial_applications WHERE created_at > now() - interval '1 day'`,
      [ip, input.email],
    );
    if ((ip && recent.rows[0].by_ip >= PER_IP_PER_HOUR) || recent.rows[0].by_email >= PER_EMAIL_PER_DAY) throw new DomainError('TOO_MANY_REQUESTS');

    const token = generateToken();
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      // 同一個網址或統編同時申請時依序處理
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('trial:' || $1)), pg_advisory_xact_lock(hashtext('trial-tax:' || $2))`, [input.code, input.taxId]);
      await client.query(`UPDATE trial_applications SET status = 'expired' WHERE status = 'unverified' AND token_expires_at <= now()`);
      const taken = await client.query(
        `SELECT EXISTS (SELECT 1 FROM agencies WHERE code = $1) OR EXISTS (SELECT 1 FROM trial_applications WHERE code = $1 AND ${OPEN}) AS code_taken,
                EXISTS (SELECT 1 FROM agencies WHERE tax_id = $2)
                  OR EXISTS (SELECT 1 FROM trial_applications WHERE tax_id = $2 AND (status = 'approved' OR ${OPEN})) AS tax_used`,
        [input.code, input.taxId],
      );
      if (taken.rows[0].code_taken) throw new DomainError('CODE_UNAVAILABLE');
      if (taken.rows[0].tax_used) throw new DomainError('TAX_ID_USED');
      await client.query(
        `INSERT INTO trial_applications (agency_name, code, tax_id, contact_name, phone, email, expected_size, note, ip_address, status, token_hash, token_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'unverified', $10, now() + make_interval(hours => $11))`,
        [input.agencyName, input.code, input.taxId, input.contactName, input.phone, input.email, input.expectedSize, input.note || null, ip,
          this.encryption.hashToken(token), TRIAL_LIMITS.verifyHours],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    // 申請已存下；驗證信寄失敗時可以重新申請（24 小時後網址釋出，或換一個 Email）
    await this.sendVerification(input, token).catch((e) => this.logger.error(`試用驗證信寄送失敗：${(e as Error).message}`));
  }

  private async sendVerification(input: TrialApplicationInput, token: string) {
    const link = `${siteBase()}/activate/${token}`;
    const lines = [
      `${input.contactName} 您好：`,
      `感謝您申請 ${BRAND} 免費試用。請在 ${TRIAL_LIMITS.verifyHours} 小時內點下方連結確認 Email，完成開通「${input.agencyName}」（${siteBase().replace(/^https?:\/\//, '')}/${input.code}）。`,
      link,
      `試用 ${TRIAL_LIMITS.days} 天，可建立 ${TRIAL_LIMITS.events} 場活動、最多 ${TRIAL_LIMITS.maxTravelers} 位旅客，試用期間可寄送 ${TRIAL_LIMITS.mailTotal} 封通知信（每天最多 ${TRIAL_LIMITS.mailPerDay} 封）。`,
      '如果不是您本人申請，請忽略這封信。',
    ];
    await this.mail.send({
      to: input.email,
      fromName: BRAND,
      subject: `請確認您的 ${BRAND} 試用申請`,
      text: lines.join('\n\n'),
      html: lines.map((l) => (l === link ? `<p><a href="${link}">${link}</a></p>` : `<p>${escapeHtml(l)}</p>`)).join(''),
    });
  }

  private async findByToken(tx: Tx | DatabaseService['pool'], token: string, lock: boolean): Promise<ApplicationRow | undefined> {
    if (!token || token.length > 200) return undefined;
    const { rows } = await tx.query(
      `SELECT id, agency_name, code, tax_id, contact_name, email, status, token_expires_at FROM trial_applications WHERE token_hash = $1${lock ? ' FOR UPDATE' : ''}`,
      [this.encryption.hashToken(token)],
    );
    return rows[0];
  }

  /** 開通頁要顯示的內容。連結只能用一次；開通後再點顯示已開通，方便找到登入網址。 */
  async activation(token: string, ip: string | null): Promise<ActivationInfo> {
    this.activationLimiter.hit(ip ?? 'unknown');
    const a = await this.findByToken(this.db.pool, token, false);
    if (!a) throw new DomainError('LINK_INVALID');
    if (a.status === 'approved') return { state: 'activated', code: a.code };
    if (a.status === 'pending') return { state: 'pending' };
    if (a.status !== 'unverified' || !a.token_expires_at || a.token_expires_at <= new Date()) throw new DomainError('LINK_INVALID');
    return { state: 'ready', mode: (await this.autoApprove()) ? 'auto' : 'manual', agencyName: a.agency_name, code: a.code, email: a.email, contactName: a.contact_name };
  }

  /**
   * 點驗證連結後送出。自動開通時需要密碼，建立旅行社後回傳代號，前端接著用這組密碼登入後台；
   * 關閉自動開通時只確認 Email，申請改為等待平台核准。
   */
  async activate(token: string, password: string | undefined, ip: string | null): Promise<{ state: 'activated'; code: string; email: string } | { state: 'pending' }> {
    this.activationLimiter.hit(ip ?? 'unknown');
    const auto = await this.autoApprove();
    if (auto && !password) throw new DomainError('INVALID_INPUT', { fields: ['password'] });
    const passwordHash = auto ? await hashPassword(password!) : null;
    const assertUsable = (found: ApplicationRow | undefined): ApplicationRow => {
      if (!found || found.status !== 'unverified' || !found.token_expires_at || found.token_expires_at <= new Date()) throw new DomainError('LINK_INVALID');
      return found;
    };
    let app: ApplicationRow;
    let result: { state: 'activated'; code: string; email: string } | { state: 'pending' };
    if (auto) {
      // 申請與新旅行社在同一個交易：開通失敗時申請維持原狀，可以再試一次
      const agencyId = randomUUID();
      app = await this.db.withTenant(agencyId, async (tx) => {
        const found = assertUsable(await this.findByToken(tx, token, true));
        await this.createTrialAgency(tx, agencyId, found, passwordHash);
        await tx.query(
          `UPDATE trial_applications SET status = 'approved', verified_at = now(), handled_at = now(), activated_agency_id = $2 WHERE id = $1`,
          [found.id, agencyId],
        );
        return found;
      });
      result = { state: 'activated', code: app.code, email: app.email };
    } else {
      const found = assertUsable(await this.findByToken(this.db.pool, token, false));
      const { rowCount } = await this.db.pool.query(
        `UPDATE trial_applications SET status = 'pending', verified_at = now() WHERE id = $1 AND status = 'unverified'`,
        [found.id],
      );
      if (!rowCount) throw new DomainError('LINK_INVALID');
      app = found;
      result = { state: 'pending' };
    }
    await this.notifyPlatform(app, auto).catch((e) => this.logger.error(`試用通知寄送失敗：${(e as Error).message}`));
    return result;
  }

  /**
   * 建立試用旅行社：試用 30 天（開通當天算第 1 天）、一場最多 40 人的活動額度、第一位管理員。
   * passwordHash 為 null 時（平台核准）管理員還沒有密碼，之後寄設定密碼信。
   */
  private async createTrialAgency(tx: Tx, id: string, app: ApplicationRow, passwordHash: string | null) {
    const tier = await tx.query(
      `SELECT id FROM pricing_tiers WHERE min_travelers = 1 AND max_travelers = $1 AND price_amount = 0`,
      [TRIAL_LIMITS.maxTravelers],
    );
    if (!tier.rows[0]) throw new Error('缺少試用級距，請執行資料庫遷移');
    try {
      await tx.query(
        `INSERT INTO agencies (id, code, name, tax_id, is_trial, plan_note, contract_starts_on, contract_ends_on)
         VALUES ($1, $2, $3, $4, true, '免費試用', ${TODAY}, ${TODAY} + $5::int)`,
        [id, app.code, app.agency_name, app.tax_id, TRIAL_LIMITS.days - 1],
      );
    } catch (e) {
      if ((e as { constraint?: string }).constraint === 'agencies_code_key') throw new DomainError('CODE_UNAVAILABLE');
      throw e;
    }
    const userId = await this.staff.insertUser(tx, id, { name: app.contact_name, email: app.email, role: 'admin' });
    if (passwordHash) await tx.query(`UPDATE agency_users SET password_hash = $2 WHERE id = $1`, [userId, passwordHash]);
    await tx.query(
      `INSERT INTO agency_quota_ledger (agency_id, pricing_tier_id, change, reason, note) VALUES ($1, $2, $3, 'grant', '免費試用')`,
      [id, tier.rows[0].id, TRIAL_LIMITS.events],
    );
    await tx.query(
      `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id, metadata) VALUES ($1, 'system', NULL, 'trial.activated', 'agency', $1, $2)`,
      [id, JSON.stringify({ applicationId: app.id, selfService: !!passwordHash })],
    );
  }

  private async notifyPlatform(app: ApplicationRow, activated: boolean) {
    const notifyTo = process.env.TRIAL_NOTIFY_EMAIL;
    if (!notifyTo) return;
    const lines = [
      `旅行社名稱：${app.agency_name}`,
      `網址：${siteBase()}/${app.code}`,
      `統一編號：${app.tax_id}`,
      `聯絡人：${app.contact_name}`,
      `Email：${app.email}`,
    ];
    const tail = activated ? '已自動開通免費試用。' : '已確認 Email，請到平台後台的「試用申請」核准或退回。';
    await this.mail.send({
      to: notifyTo,
      fromName: BRAND,
      subject: activated ? `試用已開通：${app.agency_name}` : `試用申請待核准：${app.agency_name}`,
      text: `${lines.join('\n')}\n\n${tail}`,
      html: `<p>${lines.map(escapeHtml).join('<br>')}</p><p>${tail}</p>`,
    });
  }

  // ===== 平台後台 =====

  async listApplications(status: string | undefined): Promise<TrialApplicationRow[]> {
    const filter = ['unverified', 'pending', 'approved', 'rejected', 'expired'].includes(status ?? '') ? status! : null;
    await this.db.pool.query(`UPDATE trial_applications SET status = 'expired' WHERE status = 'unverified' AND token_expires_at <= now()`);
    const { rows } = await this.db.pool.query(
      `SELECT a.*, u.name AS handled_by_name, EXISTS (SELECT 1 FROM agencies g WHERE g.code = a.code) AS code_taken,
              (SELECT g.id FROM agencies g WHERE g.id = a.activated_agency_id) AS agency_id
         FROM trial_applications a LEFT JOIN platform_users u ON u.id = a.handled_by
        WHERE $1::text IS NULL OR a.status = $1
        ORDER BY (a.status = 'pending') DESC, a.created_at DESC LIMIT 500`,
      [filter],
    );
    return rows.map((r) => ({
      id: r.id,
      agencyName: r.agency_name,
      code: r.code,
      taxId: r.tax_id,
      contactName: r.contact_name,
      phone: r.phone,
      email: r.email,
      expectedSize: r.expected_size,
      note: r.note,
      status: r.status,
      createdAt: r.created_at,
      verifiedAt: r.verified_at,
      handledAt: r.handled_at,
      handledByName: r.handled_by_name,
      agencyId: r.agency_id,
      codeTaken: r.code_taken,
    }));
  }

  /** 退回申請（待驗證或待核准），或把退回的申請改回待核准（已驗證過 Email 才行）。 */
  async setStatus(actorId: string, id: string, status: 'pending' | 'rejected') {
    if (!UUID.test(id)) throw new DomainError('NOT_FOUND');
    const { rows } = await this.db.pool.query(`SELECT status, verified_at FROM trial_applications WHERE id = $1`, [id]);
    const cur = rows[0];
    if (!cur) throw new DomainError('NOT_FOUND');
    const allowed = status === 'rejected' ? ['unverified', 'pending'].includes(cur.status) : cur.status === 'rejected' && cur.verified_at;
    if (!allowed) throw new DomainError('INVALID_INPUT', { fields: ['status'] });
    try {
      await this.db.pool.query(
        `UPDATE trial_applications SET status = $2,
                handled_by = CASE WHEN $2 = 'pending' THEN NULL ELSE $3::uuid END,
                handled_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END,
                token_hash = CASE WHEN $2 = 'rejected' THEN NULL ELSE token_hash END
          WHERE id = $1`,
        [id, status, actorId],
      );
    } catch (err) {
      // 改回待核准時，同一個網址或統編已有另一筆進行中的申請
      if ((err as { constraint?: string }).constraint === 'trial_applications_open_tax_id') throw new DomainError('TAX_ID_USED');
      if ((err as { code?: string }).code === '23505') throw new DomainError('CODE_UNAVAILABLE');
      throw err;
    }
  }

  /** 平台核准（關閉自動開通時）：建立試用旅行社，寄設定密碼信給申請人。 */
  async approve(actorId: string, id: string): Promise<{ agencyId: string; mailFailed: boolean }> {
    if (!UUID.test(id)) throw new DomainError('NOT_FOUND');
    const agencyId = randomUUID();
    await this.db.withTenant(agencyId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, agency_name, code, tax_id, contact_name, email, status, token_expires_at FROM trial_applications WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const app = rows[0] as ApplicationRow | undefined;
      if (!app) throw new DomainError('NOT_FOUND');
      if (app.status !== 'pending') throw new DomainError('INVALID_INPUT', { fields: ['status'] });
      const used = await tx.query(`SELECT 1 FROM agencies WHERE tax_id = $1`, [app.tax_id]);
      if (app.tax_id && used.rowCount) throw new DomainError('TAX_ID_USED');
      await this.createTrialAgency(tx, agencyId, app, null);
      await tx.query(
        `UPDATE trial_applications SET status = 'approved', handled_by = $2, handled_at = now(), activated_agency_id = $3 WHERE id = $1`,
        [id, actorId, agencyId],
      );
    });
    const userId = await this.db.withTenant(agencyId, async (tx) => (await tx.query(`SELECT id FROM agency_users LIMIT 1`)).rows[0].id as string);
    const mailFailed = await this.staff.sendLink({ agencyId, userId, actorId: null }).then(() => false, (e) => {
      if ((e as DomainError).code === 'MAIL_FAILED') return true;
      throw e;
    });
    return { agencyId, mailFailed };
  }
}
