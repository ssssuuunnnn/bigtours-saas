import { Inject, Injectable } from '@nestjs/common';
import { ROSTER_COLUMNS, employeeRequest, type EmployeeRow } from '@bigtours/shared/admin';
import { decrypt, encrypt, generateToken, hashToken, loadKey } from '@bigtours/shared/crypto';
import ExcelJS from 'exceljs';
import { AdminAuthService, type AdminContext } from './admin-auth.service.ts';
import { DatabaseService, type Tx } from './database.service.ts';
import { DomainError } from './errors.ts';
import { RegistrationService } from './registration.service.ts';

type Dict = Record<string, any>;

@Injectable()
export class AdminService {
  private readonly key = loadKey(process.env.DATA_ENCRYPTION_KEY);
  private readonly hashKey = process.env.TOKEN_HASH_KEY ?? '';

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(RegistrationService) private readonly registrations: RegistrationService,
  ) {}

  private tx<T>(ctx: AdminContext, fn: (tx: Tx) => Promise<T>) {
    return this.db.withTenant(ctx.agencyId, fn);
  }

  private async one(tx: Tx, sql: string, params: unknown[]) {
    const { rows } = await tx.query(sql, params);
    if (!rows[0]) throw new DomainError('NOT_FOUND');
    return rows[0];
  }

  // ===== 額度與企業 =====

  async quota(ctx: AdminContext) {
    return this.tx(ctx, async (tx) => {
      const { rows } = await tx.query(
        `SELECT t.id, t.min_travelers, t.max_travelers, t.price_amount,
                COALESCE((SELECT sum(l.change) FROM agency_quota_ledger l WHERE l.pricing_tier_id = t.id), 0)::int AS balance
           FROM pricing_tiers t WHERE t.is_active ORDER BY t.min_travelers`,
      );
      return rows.map((r) => ({ id: r.id, minTravelers: r.min_travelers, maxTravelers: r.max_travelers, price: r.price_amount, balance: r.balance }));
    });
  }

  async listCompanies(ctx: AdminContext) {
    return this.tx(ctx, async (tx) => (await tx.query(`SELECT id, name, status FROM companies ORDER BY created_at`)).rows);
  }

  async createCompany(ctx: AdminContext, name: string) {
    return this.tx(ctx, async (tx) =>
      this.one(tx, `INSERT INTO companies (agency_id, name) VALUES ($1, $2) RETURNING id, name, status`, [ctx.agencyId, name]),
    );
  }

  // ===== 活動 =====

  async listEvents(ctx: AdminContext) {
    return this.tx(ctx, async (tx) => {
      const { rows } = await tx.query(
        `SELECT e.id, e.slug, e.name, e.status, e.registration_opens_at, e.registration_closes_at, c.name AS company_name,
                COALESCE((SELECT sum(s.capacity) FROM event_sessions s WHERE s.event_id = e.id), 0)::int AS capacity,
                COALESCE((SELECT sum(s.sold_count) FROM event_sessions s WHERE s.event_id = e.id), 0)::int AS sold,
                (SELECT count(*) FROM event_employees m WHERE m.event_id = e.id AND m.status = 'active')::int AS employees
           FROM events e JOIN companies c ON c.id = e.company_id ORDER BY e.created_at DESC`,
      );
      return rows.map((r) => ({
        id: r.id, slug: r.slug, name: r.name, status: r.status, companyName: r.company_name,
        registrationOpensAt: r.registration_opens_at, registrationClosesAt: r.registration_closes_at,
        capacity: r.capacity, sold: r.sold, employees: r.employees,
      }));
    });
  }

  /** 建立活動扣一場額度；用 advisory lock 避免同時建立時扣成負數。 */
  async createEvent(ctx: AdminContext, req: { companyId: string; name: string; slug: string; pricingTierId: string }) {
    return this.tx(ctx, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`quota:${ctx.agencyId}`]);
      const { rows } = await tx.query(
        `SELECT COALESCE(sum(change), 0)::int AS balance FROM agency_quota_ledger WHERE pricing_tier_id = $1`,
        [req.pricingTierId],
      );
      if (rows[0].balance <= 0) throw new DomainError('QUOTA_EXHAUSTED');
      const event = await this.one(
        tx,
        `INSERT INTO events (agency_id, company_id, slug, name, pricing_tier_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [ctx.agencyId, req.companyId, req.slug, req.name, req.pricingTierId, ctx.user.id],
      );
      await tx.query(
        `INSERT INTO agency_quota_ledger (agency_id, pricing_tier_id, change, reason, event_id, created_by) VALUES ($1, $2, -1, 'event_created', $3, $4)`,
        [ctx.agencyId, req.pricingTierId, event.id, ctx.user.id],
      );
      return { id: event.id as string };
    });
  }

  async getEvent(ctx: AdminContext, id: string) {
    return this.tx(ctx, async (tx) => {
      const e = await this.one(
        tx,
        `SELECT e.*, c.name AS company_name, t.min_travelers, t.max_travelers
           FROM events e JOIN companies c ON c.id = e.company_id JOIN pricing_tiers t ON t.id = e.pricing_tier_id WHERE e.id = $1`,
        [id],
      );
      const sessions = (await tx.query(`SELECT * FROM event_sessions WHERE event_id = $1 ORDER BY sort_order, departs_on, name`, [id])).rows;
      const types = (await tx.query(`SELECT * FROM traveler_types WHERE event_id = $1 ORDER BY sort_order, name`, [id])).rows;
      const groups = (await tx.query(`SELECT * FROM option_groups WHERE event_id = $1 ORDER BY sort_order, name`, [id])).rows;
      const options = (await tx.query(
        `SELECT o.* FROM options o JOIN option_groups g ON g.id = o.group_id WHERE g.event_id = $1 ORDER BY o.sort_order, o.name`,
        [id],
      )).rows;
      const quotas = (await tx.query(
        `SELECT q.* FROM option_session_quotas q JOIN event_sessions s ON s.id = q.session_id WHERE s.event_id = $1`,
        [id],
      )).rows;
      const fields = (await tx.query(`SELECT * FROM event_fields WHERE event_id = $1 ORDER BY sort_order, label`, [id])).rows;
      return {
        id: e.id,
        slug: e.slug,
        name: e.name,
        status: e.status,
        companyName: e.company_name,
        agencyCode: ctx.agencyCode,
        tier: { minTravelers: e.min_travelers, maxTravelers: e.max_travelers },
        registrationOpensAt: e.registration_opens_at,
        registrationClosesAt: e.registration_closes_at,
        endsOn: e.ends_on,
        defaultSubsidyAmount: e.default_subsidy_amount,
        defaultDependentLimit: e.default_dependent_limit,
        allowDependentsOnly: e.allow_dependents_only,
        retentionDays: e.retention_days,
        itinerary: e.itinerary,
        sessions: sessions.map((s) => ({ id: s.id, name: s.name, departsOn: s.departs_on, returnsOn: s.returns_on, capacity: s.capacity, soldCount: s.sold_count, sortOrder: s.sort_order })),
        travelerTypes: types.map((t) => ({ id: t.id, name: t.name, basePrice: t.base_price, isEmployeeSelf: t.is_employee_self, sortOrder: t.sort_order })),
        optionGroups: groups.map((g) => ({
          id: g.id, name: g.name, isRequired: g.is_required, minSelect: g.min_select, maxSelect: g.max_select, sortOrder: g.sort_order,
          options: options.filter((o) => o.group_id === g.id).map((o) => ({
            id: o.id, name: o.name, description: o.description, price: o.price, sortOrder: o.sort_order,
            quotas: quotas.filter((q) => q.option_id === o.id).map((q) => ({ sessionId: q.session_id, capacity: q.capacity, soldCount: q.sold_count })),
          })),
        })),
        fields: fields.map((f) => ({ id: f.id, fieldKey: f.field_key, label: f.label, fieldType: f.field_type, choices: f.choices, isRequired: f.is_required, isSensitive: f.is_sensitive, sortOrder: f.sort_order })),
      };
    });
  }

  async updateEvent(ctx: AdminContext, id: string, req: Dict) {
    const columns: Record<string, string> = {
      name: 'name', registrationOpensAt: 'registration_opens_at', registrationClosesAt: 'registration_closes_at', endsOn: 'ends_on',
      defaultSubsidyAmount: 'default_subsidy_amount', defaultDependentLimit: 'default_dependent_limit',
      allowDependentsOnly: 'allow_dependents_only', retentionDays: 'retention_days', itinerary: 'itinerary',
    };
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [key, column] of Object.entries(columns)) {
      if (req[key] === undefined) continue;
      values.push(key === 'itinerary' ? JSON.stringify(req[key]) : req[key]);
      sets.push(`${column} = $${values.length}`);
    }
    if (!sets.length) return;
    await this.tx(ctx, async (tx) => {
      await this.one(tx, `UPDATE events SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id`, values);
    });
  }

  /** 發布前檢查必要設定；回傳缺少的項目，由前端顯示。 */
  async publish(ctx: AdminContext, id: string) {
    await this.tx(ctx, async (tx) => {
      const e = await this.one(
        tx,
        `SELECT e.status, e.registration_opens_at, e.registration_closes_at, e.allow_dependents_only, t.max_travelers
           FROM events e JOIN pricing_tiers t ON t.id = e.pricing_tier_id WHERE e.id = $1 FOR UPDATE OF e`,
        [id],
      );
      const problems: string[] = [];
      const sessions = (await tx.query(`SELECT capacity FROM event_sessions WHERE event_id = $1`, [id])).rows;
      const types = (await tx.query(`SELECT is_employee_self FROM traveler_types WHERE event_id = $1`, [id])).rows;
      if (!sessions.length) problems.push('sessions');
      if (!types.length) problems.push('traveler_types');
      if (!e.allow_dependents_only && !types.some((t) => t.is_employee_self)) problems.push('self_type');
      if (!e.registration_opens_at || !e.registration_closes_at) problems.push('registration_period');
      if (sessions.reduce((sum, s) => sum + s.capacity, 0) > e.max_travelers) problems.push('capacity');
      if (problems.length) throw new DomainError('NOT_PUBLISHABLE', { problems });
      await tx.query(`UPDATE events SET status = 'published', updated_at = now() WHERE id = $1`, [id]);
    });
  }

  async closeEvent(ctx: AdminContext, id: string) {
    await this.tx(ctx, (tx) => this.one(tx, `UPDATE events SET status = 'closed', updated_at = now() WHERE id = $1 RETURNING id`, [id]));
  }

  /** 尚未開放報名且沒有報名資料才能刪除，額度退回。 */
  async deleteEvent(ctx: AdminContext, id: string) {
    await this.tx(ctx, async (tx) => {
      const e = await this.one(tx, `SELECT status, registration_opens_at, pricing_tier_id FROM events WHERE id = $1 FOR UPDATE`, [id]);
      const opened = e.status !== 'draft' && (!e.registration_opens_at || e.registration_opens_at.getTime() <= Date.now());
      const used = await tx.query(`SELECT 1 FROM registrations WHERE event_id = $1 UNION ALL SELECT 1 FROM seat_holds WHERE event_id = $1 LIMIT 1`, [id]);
      if (opened || used.rowCount) throw new DomainError('CANNOT_DELETE');
      await tx.query(`DELETE FROM events WHERE id = $1`, [id]);
      await tx.query(
        `INSERT INTO agency_quota_ledger (agency_id, pricing_tier_id, change, reason, event_id, created_by) VALUES ($1, $2, 1, 'event_deleted', $3, $4)`,
        [ctx.agencyId, e.pricing_tier_id, id, ctx.user.id],
      );
    });
  }

  // ===== 梯次 =====

  /** 鎖定活動後檢查，避免同時修改時超過購買級距。 */
  private async assertCapacity(tx: Tx, eventId: string) {
    const { rows } = await tx.query(
      `SELECT t.max_travelers, COALESCE((SELECT sum(capacity) FROM event_sessions WHERE event_id = e.id), 0)::int AS total
         FROM events e JOIN pricing_tiers t ON t.id = e.pricing_tier_id WHERE e.id = $1`,
      [eventId],
    );
    if (rows[0].total > rows[0].max_travelers) {
      throw new DomainError('CAPACITY_EXCEEDS_TIER', { maxTravelers: rows[0].max_travelers, total: rows[0].total });
    }
  }

  private lockEvent(tx: Tx, eventId: string) {
    return this.one(tx, `SELECT id FROM events WHERE id = $1 FOR UPDATE`, [eventId]);
  }

  async createSession(ctx: AdminContext, eventId: string, r: Dict) {
    return this.tx(ctx, async (tx) => {
      await this.lockEvent(tx, eventId);
      const row = await this.one(
        tx,
        `INSERT INTO event_sessions (agency_id, event_id, name, departs_on, returns_on, capacity, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [ctx.agencyId, eventId, r.name, r.departsOn, r.returnsOn, r.capacity, r.sortOrder],
      );
      await this.assertCapacity(tx, eventId);
      return { id: row.id as string };
    });
  }

  async updateSession(ctx: AdminContext, eventId: string, id: string, r: Dict) {
    await this.tx(ctx, async (tx) => {
      await this.lockEvent(tx, eventId);
      // 名額不得低於已售數量，由資料表限制把關
      await this.one(
        tx,
        `UPDATE event_sessions SET name = $3, departs_on = $4, returns_on = $5, capacity = $6, sort_order = $7 WHERE id = $1 AND event_id = $2 RETURNING id`,
        [id, eventId, r.name, r.departsOn, r.returnsOn, r.capacity, r.sortOrder],
      );
      await this.assertCapacity(tx, eventId);
    });
  }

  async deleteSession(ctx: AdminContext, eventId: string, id: string) {
    await this.tx(ctx, (tx) => this.one(tx, `DELETE FROM event_sessions WHERE id = $1 AND event_id = $2 RETURNING id`, [id, eventId]));
  }

  // ===== 旅客類型 =====

  async createTravelerType(ctx: AdminContext, eventId: string, r: Dict) {
    return this.tx(ctx, async (tx) =>
      this.one(
        tx,
        `INSERT INTO traveler_types (agency_id, event_id, name, base_price, is_employee_self, sort_order) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [ctx.agencyId, eventId, r.name, r.basePrice, r.isEmployeeSelf, r.sortOrder],
      ),
    );
  }

  async updateTravelerType(ctx: AdminContext, eventId: string, id: string, r: Dict) {
    await this.tx(ctx, (tx) =>
      this.one(
        tx,
        `UPDATE traveler_types SET name = $3, base_price = $4, is_employee_self = $5, sort_order = $6 WHERE id = $1 AND event_id = $2 RETURNING id`,
        [id, eventId, r.name, r.basePrice, r.isEmployeeSelf, r.sortOrder],
      ),
    );
  }

  async deleteTravelerType(ctx: AdminContext, eventId: string, id: string) {
    await this.tx(ctx, (tx) => this.one(tx, `DELETE FROM traveler_types WHERE id = $1 AND event_id = $2 RETURNING id`, [id, eventId]));
  }

  // ===== 自選行程 =====

  async createGroup(ctx: AdminContext, eventId: string, r: Dict) {
    return this.tx(ctx, async (tx) =>
      this.one(
        tx,
        `INSERT INTO option_groups (agency_id, event_id, name, is_required, min_select, max_select, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [ctx.agencyId, eventId, r.name, r.isRequired, r.minSelect, r.maxSelect, r.sortOrder],
      ),
    );
  }

  async updateGroup(ctx: AdminContext, eventId: string, id: string, r: Dict) {
    await this.tx(ctx, (tx) =>
      this.one(
        tx,
        `UPDATE option_groups SET name = $3, is_required = $4, min_select = $5, max_select = $6, sort_order = $7 WHERE id = $1 AND event_id = $2 RETURNING id`,
        [id, eventId, r.name, r.isRequired, r.minSelect, r.maxSelect, r.sortOrder],
      ),
    );
  }

  async deleteGroup(ctx: AdminContext, eventId: string, id: string) {
    await this.tx(ctx, (tx) => this.one(tx, `DELETE FROM option_groups WHERE id = $1 AND event_id = $2 RETURNING id`, [id, eventId]));
  }

  private async writeQuotas(tx: Tx, ctx: AdminContext, eventId: string, optionId: string, quotas: { sessionId: string; capacity: number }[]) {
    for (const q of quotas) {
      await this.one(tx, `SELECT id FROM event_sessions WHERE id = $1 AND event_id = $2`, [q.sessionId, eventId]);
      await tx.query(
        `INSERT INTO option_session_quotas (agency_id, option_id, session_id, capacity) VALUES ($1, $2, $3, $4)
         ON CONFLICT (option_id, session_id) DO UPDATE SET capacity = EXCLUDED.capacity`,
        [ctx.agencyId, optionId, q.sessionId, q.capacity],
      );
    }
    // 移除名額設定等於改回不限量；已有人選的名額不可移除，以免數字對不起來
    const removed = await tx.query(
      `DELETE FROM option_session_quotas WHERE option_id = $1 AND sold_count = 0 AND NOT (session_id = ANY($2::uuid[]))
         AND NOT EXISTS (SELECT 1 FROM seat_hold_items i WHERE i.quota_id = option_session_quotas.id) RETURNING id`,
      [optionId, quotas.map((q) => q.sessionId)],
    );
    const left = await tx.query(`SELECT 1 FROM option_session_quotas WHERE option_id = $1 AND NOT (session_id = ANY($2::uuid[]))`, [optionId, quotas.map((q) => q.sessionId)]);
    if (left.rowCount) throw new DomainError('IN_USE', { removed: removed.rowCount });
  }

  async createOption(ctx: AdminContext, eventId: string, groupId: string, r: Dict) {
    return this.tx(ctx, async (tx) => {
      await this.one(tx, `SELECT id FROM option_groups WHERE id = $1 AND event_id = $2`, [groupId, eventId]);
      const row = await this.one(
        tx,
        `INSERT INTO options (agency_id, group_id, name, description, price, sort_order) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [ctx.agencyId, groupId, r.name, r.description, r.price, r.sortOrder],
      );
      await this.writeQuotas(tx, ctx, eventId, row.id, r.quotas);
      return { id: row.id as string };
    });
  }

  async updateOption(ctx: AdminContext, eventId: string, id: string, r: Dict) {
    await this.tx(ctx, async (tx) => {
      await this.one(
        tx,
        `UPDATE options o SET name = $3, description = $4, price = $5, sort_order = $6
           FROM option_groups g WHERE o.id = $1 AND g.id = o.group_id AND g.event_id = $2 RETURNING o.id`,
        [id, eventId, r.name, r.description, r.price, r.sortOrder],
      );
      await this.writeQuotas(tx, ctx, eventId, id, r.quotas);
    });
  }

  async deleteOption(ctx: AdminContext, eventId: string, id: string) {
    await this.tx(ctx, (tx) =>
      this.one(tx, `DELETE FROM options o USING option_groups g WHERE o.id = $1 AND g.id = o.group_id AND g.event_id = $2 RETURNING o.id`, [id, eventId]),
    );
  }

  // ===== 自訂欄位 =====

  async createField(ctx: AdminContext, eventId: string, r: Dict) {
    return this.tx(ctx, async (tx) =>
      this.one(
        tx,
        `INSERT INTO event_fields (agency_id, event_id, field_key, label, field_type, choices, is_required, is_sensitive, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [ctx.agencyId, eventId, r.fieldKey, r.label, r.fieldType, r.choices ? JSON.stringify(r.choices) : null, r.isRequired, r.isSensitive, r.sortOrder],
      ),
    );
  }

  async updateField(ctx: AdminContext, eventId: string, id: string, r: Dict) {
    await this.tx(ctx, async (tx) => {
      // 已有報名資料時不可改變敏感屬性，否則舊資料的儲存方式會不一致
      const cur = await this.one(tx, `SELECT field_key, is_sensitive FROM event_fields WHERE id = $1 AND event_id = $2`, [id, eventId]);
      if ((cur.is_sensitive !== r.isSensitive || cur.field_key !== r.fieldKey)) {
        const used = await tx.query(`SELECT 1 FROM registrations WHERE event_id = $1 LIMIT 1`, [eventId]);
        if (used.rowCount) throw new DomainError('IN_USE');
      }
      await this.one(
        tx,
        `UPDATE event_fields SET field_key = $3, label = $4, field_type = $5, choices = $6, is_required = $7, is_sensitive = $8, sort_order = $9
          WHERE id = $1 AND event_id = $2 RETURNING id`,
        [id, eventId, r.fieldKey, r.label, r.fieldType, r.choices ? JSON.stringify(r.choices) : null, r.isRequired, r.isSensitive, r.sortOrder],
      );
    });
  }

  async deleteField(ctx: AdminContext, eventId: string, id: string) {
    await this.tx(ctx, async (tx) => {
      const used = await tx.query(`SELECT 1 FROM registrations WHERE event_id = $1 LIMIT 1`, [eventId]);
      if (used.rowCount) throw new DomainError('IN_USE');
      await this.one(tx, `DELETE FROM event_fields WHERE id = $1 AND event_id = $2 RETURNING id`, [id, eventId]);
    });
  }

  // ===== 員工名單 =====

  async listEmployees(ctx: AdminContext, eventId: string) {
    return this.tx(ctx, async (tx) => {
      const { rows } = await tx.query(
        `SELECT m.id, m.employee_no, m.name, m.email, m.department, m.subsidy_amount, m.dependent_limit, m.link_issued_at,
                (SELECT r.status FROM registrations r WHERE r.event_employee_id = m.id AND r.status <> 'cancelled') AS registration_status
           FROM event_employees m WHERE m.event_id = $1 AND m.status = 'active' ORDER BY m.employee_no`,
        [eventId],
      );
      return rows.map((r) => ({
        id: r.id, employeeNo: r.employee_no, name: r.name, email: r.email, department: r.department,
        subsidyAmount: r.subsidy_amount, dependentLimit: r.dependent_limit, linkIssuedAt: r.link_issued_at, registrationStatus: r.registration_status,
      }));
    });
  }

  private newLink() {
    const token = generateToken();
    return { hash: hashToken(this.hashKey, token), encrypted: encrypt(this.key, token) };
  }

  /** 新增或更新；已有員工編號但已移除時恢復。補助變更留下紀錄，已送出的報名不自動重算。 */
  private async upsertEmployee(tx: Tx, ctx: AdminContext, eventId: string, r: EmployeeRow) {
    const link = this.newLink();
    const before = await tx.query(`SELECT id, subsidy_amount FROM event_employees WHERE event_id = $1 AND employee_no = $2`, [eventId, r.employeeNo]);
    const { rows } = await tx.query(
      `INSERT INTO event_employees (agency_id, event_id, employee_no, name, email, department, subsidy_amount, dependent_limit, link_token_hash, link_token_encrypted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (event_id, employee_no) DO UPDATE
         SET name = EXCLUDED.name, email = EXCLUDED.email, department = EXCLUDED.department, subsidy_amount = EXCLUDED.subsidy_amount,
             dependent_limit = EXCLUDED.dependent_limit, status = 'active', updated_at = now()
       RETURNING id`,
      [ctx.agencyId, eventId, r.employeeNo, r.name, r.email, r.department, r.subsidyAmount, r.dependentLimit, link.hash, link.encrypted],
    );
    const old = before.rows[0];
    if (old && old.subsidy_amount !== r.subsidyAmount) {
      await this.auth.audit(tx, ctx.agencyId, ctx.user.id, 'employee.subsidy_changed', 'event_employee', rows[0].id, { from: old.subsidy_amount, to: r.subsidyAmount });
    }
    return { id: rows[0].id as string, created: !old };
  }

  async createEmployee(ctx: AdminContext, eventId: string, r: EmployeeRow) {
    return this.tx(ctx, async (tx) => {
      await this.one(tx, `SELECT id FROM events WHERE id = $1`, [eventId]);
      const dup = await tx.query(`SELECT 1 FROM event_employees WHERE event_id = $1 AND employee_no = $2 AND status = 'active'`, [eventId, r.employeeNo]);
      if (dup.rowCount) throw new DomainError('DUPLICATE');
      return { id: (await this.upsertEmployee(tx, ctx, eventId, r)).id };
    });
  }

  async updateEmployee(ctx: AdminContext, eventId: string, id: string, r: EmployeeRow) {
    await this.tx(ctx, async (tx) => {
      const old = await this.one(tx, `SELECT subsidy_amount FROM event_employees WHERE id = $1 AND event_id = $2`, [id, eventId]);
      await tx.query(
        `UPDATE event_employees SET employee_no = $2, name = $3, email = $4, department = $5, subsidy_amount = $6, dependent_limit = $7, updated_at = now() WHERE id = $1`,
        [id, r.employeeNo, r.name, r.email, r.department, r.subsidyAmount, r.dependentLimit],
      );
      if (old.subsidy_amount !== r.subsidyAmount) {
        await this.auth.audit(tx, ctx.agencyId, ctx.user.id, 'employee.subsidy_changed', 'event_employee', id, { from: old.subsidy_amount, to: r.subsidyAmount });
      }
    });
  }

  /** 有有效報名時不可移除；移除後連結立即失效。 */
  async removeEmployee(ctx: AdminContext, eventId: string, id: string) {
    await this.tx(ctx, async (tx) => {
      const active = await tx.query(`SELECT 1 FROM registrations WHERE event_employee_id = $1 AND status <> 'cancelled'`, [id]);
      if (active.rowCount) throw new DomainError('IN_USE');
      await this.one(tx, `UPDATE event_employees SET status = 'removed', updated_at = now() WHERE id = $1 AND event_id = $2 RETURNING id`, [id, eventId]);
      await tx.query(`UPDATE seat_holds SET status = 'released', closed_at = now() WHERE event_employee_id = $1 AND status = 'active'`, [id]);
    });
  }

  async regenerateLink(ctx: AdminContext, eventId: string, id: string) {
    await this.tx(ctx, async (tx) => {
      const link = this.newLink();
      await this.one(
        tx,
        `UPDATE event_employees SET link_token_hash = $3, link_token_encrypted = $4, link_issued_at = now(), updated_at = now() WHERE id = $1 AND event_id = $2 RETURNING id`,
        [id, eventId, link.hash, link.encrypted],
      );
      await this.auth.audit(tx, ctx.agencyId, ctx.user.id, 'employee.link_regenerated', 'event_employee', id, {});
    });
  }

  async rosterTemplate() {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('員工名單');
    ws.addRow([...ROSTER_COLUMNS]);
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c) => { c.width = 18; });
    ws.addRow(['E001', '王小明', 'ming@example.com', '業務部', 10000, 2]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  private cellText(value: ExcelJS.CellValue): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object' && !(value instanceof Date)) {
      const v = value as { text?: unknown; result?: unknown; richText?: { text: string }[] };
      if (v.richText) return v.richText.map((t) => t.text).join('').trim();
      if (v.text !== undefined) return String(v.text).trim(); // Email 常被 Excel 轉成超連結
      if (v.result !== undefined) return String(v.result).trim();
      return '';
    }
    return String(value).trim();
  }

  /** 只解析與驗證，不寫入；確認後才由 commit 寫入。 */
  async previewImport(ctx: AdminContext, eventId: string, fileBase64: string) {
    const buffer = Buffer.from(fileBase64, 'base64');
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as never);
    } catch {
      throw new DomainError('INVALID_INPUT', { reason: 'not_xlsx' });
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new DomainError('INVALID_INPUT', { reason: 'empty' });

    const header = (ws.getRow(1).values as ExcelJS.CellValue[]).slice(1).map((v) => this.cellText(v));
    const col = new Map(header.map((h, i) => [h, i + 1]));
    const missing = ['員工編號', '姓名'].filter((c) => !col.has(c));
    if (missing.length) throw new DomainError('INVALID_INPUT', { reason: 'missing_columns', columns: missing });
    if (ws.rowCount > 5001) throw new DomainError('INVALID_INPUT', { reason: 'too_many_rows' });

    const existing = await this.tx(ctx, async (tx) => {
      await this.one(tx, `SELECT id FROM events WHERE id = $1`, [eventId]);
      return (await tx.query(`SELECT employee_no FROM event_employees WHERE event_id = $1 AND status = 'active'`, [eventId])).rows.map((r) => r.employee_no as string);
    });
    const known = new Set(existing);

    const rows: EmployeeRow[] = [];
    const errors: { row: number; message: string }[] = [];
    const seen = new Map<string, number>();
    const number = (s: string) => (s === '' ? null : Number(s));

    for (let n = 2; n <= ws.rowCount; n += 1) {
      const row = ws.getRow(n);
      const get = (name: string) => {
        const c = col.get(name);
        return c ? this.cellText(row.getCell(c).value) : '';
      };
      const raw = {
        employeeNo: get('員工編號'), name: get('姓名'), email: get('Email') || null, department: get('部門') || null,
        subsidyAmount: number(get('補助金額')), dependentLimit: number(get('眷屬人數上限')),
      };
      if (!raw.employeeNo && !raw.name && !raw.email) continue; // 略過空白列

      const parsed = employeeRequest.safeParse(raw);
      if (!parsed.success) {
        const paths = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
        const labels: Record<string, string> = { employeeNo: '員工編號', name: '姓名', email: 'Email', department: '部門', subsidyAmount: '補助金額', dependentLimit: '眷屬人數上限' };
        errors.push({ row: n, message: `${paths.map((p) => labels[p] ?? p).join('、')}格式不正確` });
        continue;
      }
      const first = seen.get(parsed.data.employeeNo);
      if (first) {
        errors.push({ row: n, message: `員工編號與第 ${first} 列重複` });
        continue;
      }
      seen.set(parsed.data.employeeNo, n);
      rows.push(parsed.data);
    }
    const updates = rows.filter((r) => known.has(r.employeeNo)).length;
    return { rows, errors, summary: { total: rows.length, created: rows.length - updates, updated: updates } };
  }

  async commitImport(ctx: AdminContext, eventId: string, rows: EmployeeRow[]) {
    return this.tx(ctx, async (tx) => {
      await this.one(tx, `SELECT id FROM events WHERE id = $1`, [eventId]);
      if (new Set(rows.map((r) => r.employeeNo)).size !== rows.length) throw new DomainError('INVALID_INPUT', { reason: 'duplicate_employee_no' });
      let created = 0;
      for (const r of rows) if ((await this.upsertEmployee(tx, ctx, eventId, r)).created) created += 1;
      await this.auth.audit(tx, ctx.agencyId, ctx.user.id, 'employee.imported', 'event', eventId, { total: rows.length, created });
      return { created, updated: rows.length - created };
    });
  }

  /** 匯出專屬連結；連結等同登入憑證，留下紀錄。 */
  async exportLinks(ctx: AdminContext, eventId: string, origin: string) {
    const { slug, rows } = await this.tx(ctx, async (tx) => {
      const e = await this.one(tx, `SELECT slug FROM events WHERE id = $1`, [eventId]);
      const list = (await tx.query(
        `SELECT employee_no, name, email, department, link_token_encrypted FROM event_employees WHERE event_id = $1 AND status = 'active' ORDER BY employee_no`,
        [eventId],
      )).rows;
      await this.auth.audit(tx, ctx.agencyId, ctx.user.id, 'employee.links_exported', 'event', eventId, { count: list.length });
      return { slug: e.slug as string, rows: list };
    });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('專屬連結');
    ws.addRow(['員工編號', '姓名', 'Email', '部門', '專屬連結']);
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      const token = decrypt(this.key, r.link_token_encrypted);
      ws.addRow([r.employee_no, r.name, r.email, r.department, `${origin}/${slug}/e/${token}`]);
    }
    ws.columns.forEach((c, i) => { c.width = i === 4 ? 90 : 18; });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // ===== 報名管理 =====

  async listRegistrations(ctx: AdminContext, eventId: string) {
    return this.tx(ctx, async (tx) => {
      const { rows } = await tx.query(
        `SELECT r.id, r.status, r.total_amount, r.subsidy_amount, r.self_pay_amount, r.payment_status, r.submitted_at,
                m.employee_no, m.name AS employee_name, m.department, s.name AS session_name,
                (SELECT count(*) FROM travelers t WHERE t.registration_id = r.id)::int AS traveler_count
           FROM registrations r
           JOIN event_employees m ON m.id = r.event_employee_id
           JOIN event_sessions s ON s.id = r.session_id
          WHERE r.event_id = $1 ORDER BY (r.status = 'cancel_requested') DESC, r.submitted_at DESC`,
        [eventId],
      );
      return rows.map((r) => ({
        id: r.id, status: r.status, totalAmount: r.total_amount, subsidyAmount: r.subsidy_amount, selfPayAmount: r.self_pay_amount,
        paymentStatus: r.payment_status, submittedAt: r.submitted_at, employeeNo: r.employee_no, employeeName: r.employee_name,
        department: r.department, sessionName: r.session_name, travelerCount: r.traveler_count,
      }));
    });
  }

  /** 明細的敏感欄位只回傳遮罩內容；查看完整個資之後另外開放給管理員並留紀錄。 */
  async getRegistration(ctx: AdminContext, eventId: string, id: string) {
    return this.tx(ctx, async (tx) => {
      await this.one(tx, `SELECT id FROM registrations WHERE id = $1 AND event_id = $2`, [id, eventId]);
      const travelers = (await tx.query(
        `SELECT t.name, tt.name AS type_name, t.base_price_snapshot, t.field_values, t.sensitive_masks, t.requested_room_no,
                COALESCE((SELECT json_agg(json_build_object('name', o.name, 'price', x.price_snapshot))
                            FROM traveler_options x JOIN options o ON o.id = x.option_id WHERE x.traveler_id = t.id), '[]') AS options
           FROM travelers t JOIN traveler_types tt ON tt.id = t.traveler_type_id WHERE t.registration_id = $1 ORDER BY t.sort_order`,
        [id],
      )).rows;
      const prefs = (await tx.query(`SELECT requested_room_no, preferred_coworker_name FROM room_preferences WHERE registration_id = $1`, [id])).rows;
      return {
        travelers: travelers.map((t) => ({
          name: t.name, typeName: t.type_name, basePrice: t.base_price_snapshot, fieldValues: { ...t.field_values, ...t.sensitive_masks },
          requestedRoomNo: t.requested_room_no, options: t.options,
        })),
        roomPreferences: prefs.map((p) => ({ requestedRoomNo: p.requested_room_no, preferredCoworkerName: p.preferred_coworker_name })),
      };
    });
  }

  async setPayment(ctx: AdminContext, eventId: string, id: string, status: string) {
    await this.tx(ctx, async (tx) => {
      const cur = await this.one(tx, `SELECT payment_status FROM registrations WHERE id = $1 AND event_id = $2 FOR UPDATE`, [id, eventId]);
      if (cur.payment_status === 'not_required') throw new DomainError('INVALID_INPUT', { reason: 'payment_not_required' });
      await tx.query(`UPDATE registrations SET payment_status = $2, updated_at = now() WHERE id = $1`, [id, status]);
      await this.auth.audit(tx, ctx.agencyId, ctx.user.id, 'registration.payment_changed', 'registration', id, { from: cur.payment_status, to: status });
    });
  }

  async confirmCancel(ctx: AdminContext, eventId: string, id: string) {
    await this.tx(ctx, (tx) => this.one(tx, `SELECT id FROM registrations WHERE id = $1 AND event_id = $2`, [id, eventId]));
    await this.registrations.confirmCancel(ctx.agencyId, id, ctx.user.id);
  }

  async rejectCancel(ctx: AdminContext, eventId: string, id: string) {
    await this.tx(ctx, async (tx) => {
      const r = await tx.query(
        `UPDATE registrations SET status = 'confirmed', cancel_requested_at = NULL, updated_at = now() WHERE id = $1 AND event_id = $2 AND status = 'cancel_requested'`,
        [id, eventId],
      );
      if (!r.rowCount) throw new DomainError('NOT_CANCELLABLE');
    });
  }
}
