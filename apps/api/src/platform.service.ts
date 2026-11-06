import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AgencyCreateInput, ContractInput, QuotaAdjustInput } from '@bigtours/shared';
import { generateToken, hashPassword, verifyPassword } from '@bigtours/shared/crypto';
import { DatabaseService, type Tx } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { DomainError } from './errors.ts';
import { StaffService } from './staff.service.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_HOURS = 12;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const EXPIRING_DAYS = 60;
const WARN_RATIO = 0.8;
const DUMMY_HASH = hashPassword('not-a-real-password-0');

export interface PlatformContext { user: { id: string; name: string } }

const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const dayValue = (d: unknown) => (d == null ? null : d instanceof Date ? new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10) : String(d).slice(0, 10));
const addDays = (date: string, days: number) => new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);

/**
 * 平台後台。平台人員只看得到旅行社、合約、額度、活動名稱與人數，
 * 這裡的查詢都不碰員工與旅客的資料表內容（人數只取梯次的計數）。
 */
@Injectable()
export class PlatformService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
    @Inject(StaffService) private readonly staff: StaffService,
  ) {}

  /** 只有 platform.平台網域 能使用，其他網址一律視為不存在。 */
  assertHost(host: string | undefined) {
    const hostname = (host ?? '').split(',')[0]!.trim().split(':')[0]!.toLowerCase();
    if (hostname !== `platform.${process.env.PLATFORM_DOMAIN}`) throw new DomainError('NOT_FOUND');
  }

  async login(email: string, password: string) {
    const { rows } = await this.db.pool.query(`SELECT id, password_hash, locked_until > now() AS locked FROM platform_users WHERE email = $1 AND status = 'active'`, [email]);
    const user = rows[0] as { id: string; password_hash: string; locked: boolean | null } | undefined;
    const matched = await verifyPassword(password, user?.password_hash ?? (await DUMMY_HASH));
    if (!user || user.locked) throw new DomainError('INVALID_CREDENTIALS');
    if (!matched) {
      await this.db.pool.query(
        `UPDATE platform_users
            SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
                locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE id = $1`,
        [user.id, MAX_FAILED_LOGINS, LOCK_MINUTES],
      );
      throw new DomainError('INVALID_CREDENTIALS');
    }
    const token = generateToken();
    await this.db.pool.query(`UPDATE platform_users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [user.id]);
    await this.db.pool.query(`DELETE FROM platform_user_sessions WHERE platform_user_id = $1 AND expires_at <= now()`, [user.id]);
    await this.db.pool.query(
      `INSERT INTO platform_user_sessions (platform_user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
      [user.id, this.encryption.hashToken(token), SESSION_HOURS],
    );
    return { token, maxAgeMs: SESSION_HOURS * 3_600_000 };
  }

  async logout(token: string | undefined) {
    if (!token) return;
    await this.db.pool.query(`UPDATE platform_user_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [this.encryption.hashToken(token)]);
  }

  async resolve(token: string | undefined): Promise<PlatformContext> {
    if (!token) throw new DomainError('UNAUTHENTICATED');
    const { rows } = await this.db.pool.query(
      `SELECT u.id, u.name FROM platform_user_sessions s JOIN platform_users u ON u.id = s.platform_user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
      [this.encryption.hashToken(token)],
    );
    if (!rows[0]) throw new DomainError('UNAUTHENTICATED');
    return { user: { id: rows[0].id, name: rows[0].name } };
  }

  // ===== 旅行社 =====

  private async quotaRows(tx: Tx) {
    const { rows } = await tx.query(
      `SELECT t.id, t.min_travelers, t.max_travelers, t.price_amount,
              COALESCE(sum(l.change) FILTER (WHERE l.reason IN ('grant', 'adjustment')), 0)::int AS opened,
              COALESCE(sum(l.change), 0)::int AS remaining
         FROM pricing_tiers t LEFT JOIN agency_quota_ledger l ON l.pricing_tier_id = t.id
        WHERE t.is_active GROUP BY t.id ORDER BY t.min_travelers`,
    );
    return rows.map((r) => ({ id: r.id as string, minTravelers: r.min_travelers, maxTravelers: r.max_travelers, price: r.price_amount, opened: r.opened as number, remaining: r.remaining as number, used: (r.opened - r.remaining) as number }));
  }

  private contractState(a: { status: string; contract_starts_on: unknown; contract_ends_on: unknown }, adminPending: boolean) {
    const ends = dayValue(a.contract_ends_on);
    if (a.status === 'suspended') return 'suspended';
    if (ends && ends < today()) return 'expired';
    if (adminPending) return 'admin_pending';
    if (ends && ends <= addDays(today(), EXPIRING_DAYS)) return 'expiring';
    return 'active';
  }

  /** 已開通帳號的管理員一個都沒有，就算管理員未設定密碼。 */
  private async adminRow(tx: Tx) {
    const { rows } = await tx.query(`SELECT id, name, email, password_hash IS NOT NULL AS activated, created_at FROM agency_users WHERE role = 'admin' AND status = 'active' ORDER BY password_hash IS NOT NULL DESC, created_at LIMIT 1`);
    return rows[0] as { id: string; name: string; email: string; activated: boolean; created_at: Date } | undefined;
  }

  private async allAgencies() {
    return (await this.db.pool.query(`SELECT * FROM agencies ORDER BY created_at DESC`)).rows;
  }

  async list(search?: string) {
    const agencies = await this.allAgencies();
    const term = search?.trim().toLowerCase();
    const matched = term ? agencies.filter((a) => a.name.toLowerCase().includes(term) || a.code.includes(term)) : agencies;
    return Promise.all(matched.map((a) => this.db.withTenant(a.id, async (tx) => {
      const quota = await this.quotaRows(tx);
      const owner = await this.adminRow(tx);
      return {
        id: a.id, name: a.name, code: a.code,
        contractStartsOn: dayValue(a.contract_starts_on), contractEndsOn: dayValue(a.contract_ends_on),
        state: this.contractState(a, !owner?.activated),
        opened: quota.reduce((n, q) => n + q.opened, 0),
        used: quota.reduce((n, q) => n + q.used, 0),
        remaining: quota.reduce((n, q) => n + q.remaining, 0),
      };
    })));
  }

  async detail(agencyId: string) {
    if (!UUID.test(agencyId)) throw new DomainError('NOT_FOUND');
    const { rows } = await this.db.pool.query(`SELECT * FROM agencies WHERE id = $1`, [agencyId]);
    const a = rows[0];
    if (!a) throw new DomainError('NOT_FOUND');
    const inner = await this.db.withTenant(agencyId, async (tx) => {
      const ledger = await tx.query(
        `SELECT l.id, l.change, l.note, l.created_at, l.created_by, t.min_travelers, t.max_travelers FROM agency_quota_ledger l JOIN pricing_tiers t ON t.id = l.pricing_tier_id
          WHERE l.reason IN ('grant', 'adjustment') ORDER BY l.created_at DESC, l.id LIMIT 100`,
      );
      return { quota: await this.quotaRows(tx), owner: await this.adminRow(tx), ledger: ledger.rows };
    });
    const names = await this.db.pool.query(`SELECT id, name FROM platform_users WHERE id = ANY($1::uuid[])`, [inner.ledger.map((l) => l.created_by).filter(Boolean)]);
    const nameOf = new Map(names.rows.map((u) => [u.id, u.name]));
    return {
      id: a.id, name: a.name, code: a.code, state: this.contractState(a, !inner.owner?.activated), suspended: a.status === 'suspended',
      planNote: a.plan_note, contractStartsOn: dayValue(a.contract_starts_on), contractEndsOn: dayValue(a.contract_ends_on),
      admin: inner.owner ? { id: inner.owner.id, name: inner.owner.name, email: inner.owner.email, activated: inner.owner.activated } : null,
      quota: inner.quota,
      ledger: inner.ledger.map((l) => ({ id: l.id, at: l.created_at, by: nameOf.get(l.created_by) ?? null, change: l.change, note: l.note, minTravelers: l.min_travelers, maxTravelers: l.max_travelers })),
    };
  }

  /** 開通旅行社：一起建立第一位管理員並寄邀請。信寄失敗時旅行社已建立，到明細頁可以重寄。 */
  async create(ctx: PlatformContext, input: AgencyCreateInput) {
    const id = randomUUID();
    const adminId = await this.db.withTenant(id, async (tx) => {
      await tx.query(
        `INSERT INTO agencies (id, code, name, plan_note, contract_starts_on, contract_ends_on) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, input.code, input.name, input.planNote, input.contractStartsOn, input.contractEndsOn],
      );
      const userId = await this.staff.insertUser(tx, id, { name: input.adminName, email: input.adminEmail, role: 'admin' });
      await this.audit(tx, id, ctx, 'platform.agency_created', { code: input.code });
      return userId;
    }).catch((e) => {
      if ((e as { constraint?: string }).constraint === 'agencies_code_key') throw new DomainError('AGENCY_CODE_TAKEN');
      throw e;
    });
    const mailFailed = await this.staff.sendLink({ agencyId: id, userId: adminId, actorId: null }).then(() => false, (e) => {
      if ((e as DomainError).code === 'MAIL_FAILED') return true;
      throw e;
    });
    return { id, mailFailed };
  }

  private audit(tx: Tx, agencyId: string, ctx: PlatformContext, action: string, metadata: object) {
    return tx.query(
      `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id, metadata) VALUES ($1, 'platform_user', $2, $3, 'agency', $1, $4)`,
      [agencyId, ctx.user.id, action, JSON.stringify(metadata)],
    );
  }

  private async assertAgency(agencyId: string) {
    if (!UUID.test(agencyId)) throw new DomainError('NOT_FOUND');
    const { rowCount } = await this.db.pool.query(`SELECT 1 FROM agencies WHERE id = $1`, [agencyId]);
    if (!rowCount) throw new DomainError('NOT_FOUND');
  }

  async updateContract(ctx: PlatformContext, agencyId: string, input: ContractInput) {
    await this.assertAgency(agencyId);
    await this.db.withTenant(agencyId, async (tx) => {
      await tx.query(`UPDATE agencies SET plan_note = $2, contract_starts_on = $3, contract_ends_on = $4, updated_at = now() WHERE id = $1`, [agencyId, input.planNote, input.contractStartsOn, input.contractEndsOn]);
      await this.audit(tx, agencyId, ctx, 'platform.contract_updated', input);
    });
  }

  /** 剩餘場數不能變成負數，也就是不能低於已使用的場數。同一級距的調整一次一個。 */
  async adjustQuota(ctx: PlatformContext, agencyId: string, input: QuotaAdjustInput) {
    await this.assertAgency(agencyId);
    await this.db.withTenant(agencyId, async (tx) => {
      const tier = await tx.query(`SELECT 1 FROM pricing_tiers WHERE id = $1 AND is_active`, [input.tierId]);
      if (!tier.rowCount) throw new DomainError('NOT_FOUND');
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`quota:${agencyId}:${input.tierId}`]);
      const { rows } = await tx.query(`SELECT COALESCE(sum(change), 0)::int AS remaining FROM agency_quota_ledger WHERE pricing_tier_id = $1`, [input.tierId]);
      if (rows[0].remaining + input.change < 0) throw new DomainError('QUOTA_BELOW_USED');
      await tx.query(
        `INSERT INTO agency_quota_ledger (agency_id, pricing_tier_id, change, reason, note, created_by) VALUES ($1, $2, $3, 'adjustment', $4, $5)`,
        [agencyId, input.tierId, input.change, input.note, ctx.user.id],
      );
    });
  }

  /** 停用後，旅行社的後台與活動頁立即無法使用。 */
  async setStatus(ctx: PlatformContext, agencyId: string, status: 'active' | 'suspended') {
    await this.assertAgency(agencyId);
    await this.db.withTenant(agencyId, async (tx) => {
      await tx.query(`UPDATE agencies SET status = $2, updated_at = now() WHERE id = $1`, [agencyId, status]);
      await this.audit(tx, agencyId, ctx, 'platform.agency_status', { status });
    });
  }

  /** 尚未開通時是邀請信，已開通時是重設密碼信。 */
  async sendAdminLink(agencyId: string) {
    await this.assertAgency(agencyId);
    const owner = await this.db.withTenant(agencyId, (tx) => this.adminRow(tx));
    if (!owner) throw new DomainError('NOT_FOUND');
    await this.staff.sendLink({ agencyId, userId: owner.id, actorId: null });
  }

  // ===== 用量與提醒 =====

  async usage() {
    const agencies = (await this.allAgencies()).filter((a) => a.status === 'active');
    const results = await Promise.all(agencies.map((a) => this.db.withTenant(a.id, async (tx) => {
      // 人數含眷屬與保留中的旅客；已取消的不算。
      const { rows } = await tx.query(
        `SELECT e.id, e.name, e.slug, t.max_travelers,
                COALESCE((SELECT sum(s.sold_count) FROM event_sessions s WHERE s.event_id = e.id), 0)::int
                + COALESCE((SELECT sum(h.quantity) FROM seat_holds h WHERE h.event_id = e.id AND h.status = 'active' AND h.expires_at > now()), 0)::int AS people
           FROM events e JOIN pricing_tiers t ON t.id = e.pricing_tier_id WHERE e.status = 'published'`,
      );
      const quota = await this.quotaRows(tx);
      const owner = await this.adminRow(tx);
      return { a, events: rows, remaining: quota.reduce((n, q) => n + q.remaining, 0), opened: quota.reduce((n, q) => n + q.opened, 0), owner };
    })));

    const events = results.flatMap(({ a, events: rows }) => rows
      .filter((e) => e.people >= e.max_travelers * WARN_RATIO)
      .map((e) => ({ id: e.id, name: e.name, slug: e.slug, agencyId: a.id, agencyName: a.name, people: e.people, limit: e.max_travelers, full: e.people >= e.max_travelers, percent: Math.floor((e.people / e.max_travelers) * 100) })))
      .sort((x, y) => y.people / y.limit - x.people / x.limit);

    const followUps = results.flatMap(({ a, remaining, opened, owner }) => {
      const out: { agencyId: string; agencyName: string; kind: 'contract_expired' | 'contract_expiring' | 'quota_empty' | 'admin_pending'; date?: string | null; days?: number }[] = [];
      const base = { agencyId: a.id as string, agencyName: a.name as string };
      const ends = dayValue(a.contract_ends_on);
      if (ends && ends < today()) out.push({ ...base, kind: 'contract_expired', date: ends });
      else if (ends && ends <= addDays(today(), EXPIRING_DAYS)) out.push({ ...base, kind: 'contract_expiring', date: ends });
      if (opened > 0 && remaining <= 0) out.push({ ...base, kind: 'quota_empty' });
      if (owner && !owner.activated) out.push({ ...base, kind: 'admin_pending', days: Math.floor((Date.now() - new Date(owner.created_at).getTime()) / 86400000) });
      return out;
    });
    return { events, followUps };
  }

  tiers() {
    return this.db.pool.query(`SELECT id, min_travelers, max_travelers, price_amount FROM pricing_tiers WHERE is_active ORDER BY min_travelers`)
      .then(({ rows }) => rows.map((r) => ({ id: r.id, minTravelers: r.min_travelers, maxTravelers: r.max_travelers, price: r.price_amount })));
  }
}
