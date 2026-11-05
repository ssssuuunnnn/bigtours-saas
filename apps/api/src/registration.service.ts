import { Inject, Injectable } from '@nestjs/common';
import {
  calculateFees,
  maskValue,
  seatStatus,
  type DraftRequest,
  type ErrorCode,
  type HoldRequest,
  type SubmitRequest,
} from '@bigtours/shared';
import type { EmployeeContext } from './access.service.ts';
import { DatabaseService, type Tx } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { DomainError } from './errors.ts';

const HOLD_MINUTES = 15;

type Selection = HoldRequest['travelers'];

interface EventConfig {
  types: Map<string, { id: string; name: string; basePrice: number; isEmployeeSelf: boolean }>;
  groups: Map<string, { id: string; name: string; isRequired: boolean; minSelect: number; maxSelect: number; options: string[] }>;
  options: Map<string, { id: string; groupId: string; name: string; price: number }>;
  fields: {
    id: string;
    key: string;
    label: string;
    type: string;
    choices: unknown;
    isRequired: boolean;
    isSensitive: boolean;
  }[];
}

interface DraftPayload extends DraftRequest {}

/** 不同梯次的併發請求不會互相排隊，由唯一索引作為最後防線，並轉成一般錯誤。 */
function rethrowUniqueViolation(constraint: string, code: ErrorCode) {
  return (err: { code?: string; constraint?: string }): never => {
    if (err.code === '23505' && err.constraint === constraint) throw new DomainError(code);
    throw err;
  };
}

@Injectable()
export class RegistrationService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
  ) {}

  // ===== 查詢 =====

  async getState(ctx: EmployeeContext) {
    return this.db.withTenant(ctx.agency.id, async (tx) => {
      const config = await this.loadConfig(tx, ctx.event.id);
      const availability = await this.loadAvailability(tx, ctx.event.id);
      const hold = await this.loadActiveHold(tx, ctx.employee.id);
      const registration = await this.loadRegistration(tx, ctx.employee.id, config);
      const draft = await this.loadDraft(tx, ctx.employee.id, config);
      return {
        agency: { name: ctx.agency.name },
        event: {
          slug: ctx.event.slug,
          name: ctx.event.name,
          themeColor: ctx.event.themeColor,
          itinerary: ctx.event.itinerary,
          registrationOpensAt: ctx.event.registrationOpensAt,
          registrationClosesAt: ctx.event.registrationClosesAt,
          allowDependentsOnly: ctx.event.allowDependentsOnly,
          termsVersion: ctx.event.termsVersion,
          isOpen: this.openState(ctx) === 'open',
          openState: this.openState(ctx),
        },
        employee: {
          employeeNo: ctx.employee.employeeNo,
          name: ctx.employee.name,
          subsidyAmount: ctx.employee.subsidyAmount,
          dependentLimit: ctx.employee.dependentLimit,
        },
        travelerTypes: [...config.types.values()],
        optionGroups: [...config.groups.values()].map((g) => ({
          ...g,
          options: g.options.map((id) => config.options.get(id)!),
        })),
        fields: config.fields.map(({ id: _id, ...f }) => f),
        availability,
        hold,
        registration,
        draft,
        serverTime: new Date().toISOString(),
      };
    });
  }

  async getAvailability(ctx: EmployeeContext) {
    return this.db.withTenant(ctx.agency.id, (tx) => this.loadAvailability(tx, ctx.event.id));
  }

  // ===== 保留名額 =====

  async createHold(ctx: EmployeeContext, req: HoldRequest) {
    this.assertOpen(ctx);
    return this.db.withTenant(ctx.agency.id, async (tx) => {
      const config = await this.loadConfig(tx, ctx.event.id);
      this.validateSelection(ctx, config, req.travelers);
      await this.assertNotRegistered(tx, ctx.employee.id);

      const needs = await this.quotaNeeds(tx, req.sessionId, req.travelers);
      await this.lockSeats(tx, ctx.event.id, req.sessionId, [...needs.keys()]);

      await tx.query(
        `UPDATE seat_holds SET status = 'expired', closed_at = now()
          WHERE event_employee_id = $1 AND status = 'active' AND expires_at <= now()`,
        [ctx.employee.id],
      );
      const existing = await tx.query(`SELECT 1 FROM seat_holds WHERE event_employee_id = $1 AND status = 'active'`, [
        ctx.employee.id,
      ]);
      if (existing.rowCount) throw new DomainError('HOLD_EXISTS');

      await this.assertSeats(tx, req.sessionId, req.travelers.length, needs);

      const { rows } = await tx.query(
        `INSERT INTO seat_holds (agency_id, event_id, event_employee_id, session_id, quantity, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6)) RETURNING id`,
        [ctx.agency.id, ctx.event.id, ctx.employee.id, req.sessionId, req.travelers.length, HOLD_MINUTES],
      );
      await this.writeHoldItems(tx, ctx.agency.id, rows[0].id, needs);
      return this.loadActiveHold(tx, ctx.employee.id);
    }).catch(rethrowUniqueViolation('seat_holds_one_active', 'HOLD_EXISTS'));
  }

  /** 修改人數或選項：增加時先確認名額、減少時立即釋出，兩者都不重新計時。 */
  async updateHold(ctx: EmployeeContext, travelers: Selection) {
    this.assertOpen(ctx);
    return this.db.withTenant(ctx.agency.id, async (tx) => {
      const config = await this.loadConfig(tx, ctx.event.id);
      this.validateSelection(ctx, config, travelers);
      const current = await tx.query(
        `SELECT id, session_id FROM seat_holds
          WHERE event_employee_id = $1 AND status = 'active' AND expires_at > now()`,
        [ctx.employee.id],
      );
      const hold = current.rows[0];
      if (!hold) throw new DomainError('HOLD_EXPIRED');

      const needs = await this.quotaNeeds(tx, hold.session_id, travelers);
      const existingItems = await tx.query(`SELECT quota_id FROM seat_hold_items WHERE hold_id = $1`, [hold.id]);
      const quotaIds = new Set<string>([...needs.keys(), ...existingItems.rows.map((r) => r.quota_id as string)]);
      await this.lockSeats(tx, ctx.event.id, hold.session_id, [...quotaIds]);

      // 取得鎖之後再確認一次，避免等待期間已逾時或已送出
      const locked = await tx.query(
        `SELECT id FROM seat_holds WHERE id = $1 AND status = 'active' AND expires_at > now() FOR UPDATE`,
        [hold.id],
      );
      if (!locked.rowCount) throw new DomainError('HOLD_EXPIRED');

      await this.assertSeats(tx, hold.session_id, travelers.length, needs, hold.id);
      await tx.query(`UPDATE seat_holds SET quantity = $1 WHERE id = $2`, [travelers.length, hold.id]);
      await tx.query(`DELETE FROM seat_hold_items WHERE hold_id = $1`, [hold.id]);
      await this.writeHoldItems(tx, ctx.agency.id, hold.id, needs);
      return this.loadActiveHold(tx, ctx.employee.id);
    });
  }

  async releaseHold(ctx: EmployeeContext) {
    await this.db.withTenant(ctx.agency.id, (tx) =>
      tx.query(
        `UPDATE seat_holds SET status = 'released', closed_at = now() WHERE event_employee_id = $1 AND status = 'active'`,
        [ctx.employee.id],
      ),
    );
  }

  // ===== 草稿 =====

  /** 敏感欄位留空時保留原值，因為回傳給前端的草稿只有遮罩內容。 */
  async saveDraft(ctx: EmployeeContext, req: DraftRequest) {
    await this.db.withTenant(ctx.agency.id, async (tx) => {
      const config = await this.loadConfig(tx, ctx.event.id);
      const previous = await this.readDraftPayload(tx, ctx.employee.id);
      const merged = this.mergeSensitive(req, previous, config);
      await tx.query(
        `INSERT INTO registration_drafts (event_employee_id, agency_id, payload_encrypted)
         VALUES ($1, $2, $3)
         ON CONFLICT (event_employee_id) DO UPDATE SET payload_encrypted = EXCLUDED.payload_encrypted, updated_at = now()`,
        [ctx.employee.id, ctx.agency.id, this.encryption.encryptJson(merged)],
      );
    });
  }

  // ===== 送出報名 =====

  async submit(ctx: EmployeeContext, req: SubmitRequest) {
    this.assertOpen(ctx);
    return this.db.withTenant(ctx.agency.id, async (tx) => {
      const config = await this.loadConfig(tx, ctx.event.id);
      this.validateSelection(ctx, config, req.travelers);
      await this.assertNotRegistered(tx, ctx.employee.id);

      const current = await tx.query(
        `SELECT id, session_id FROM seat_holds
          WHERE event_employee_id = $1 AND status = 'active' AND expires_at > now()`,
        [ctx.employee.id],
      );
      const found = current.rows[0];
      if (!found) throw new DomainError('HOLD_EXPIRED');

      const needs = await this.quotaNeeds(tx, found.session_id, req.travelers);
      await this.lockSeats(tx, ctx.event.id, found.session_id, [...needs.keys()]);

      const locked = await tx.query(
        `SELECT id, quantity, session_id FROM seat_holds WHERE id = $1 AND status = 'active' AND expires_at > now() FOR UPDATE`,
        [found.id],
      );
      const hold = locked.rows[0];
      if (!hold) throw new DomainError('HOLD_EXPIRED');

      const heldItems = await tx.query(`SELECT quota_id, quantity FROM seat_hold_items WHERE hold_id = $1`, [hold.id]);
      const sameItems =
        heldItems.rowCount === needs.size && heldItems.rows.every((r) => needs.get(r.quota_id) === r.quantity);
      if (hold.quantity !== req.travelers.length || !sameItems) throw new DomainError('HOLD_MISMATCH');

      const previous = await this.readDraftPayload(tx, ctx.employee.id);
      const details = this.mergeSensitive(req, previous, config).travelers;
      this.validateDetails(config, details);

      const fees = calculateFees(
        details.map((t) => ({
          basePrice: config.types.get(t.travelerTypeId)!.basePrice,
          optionPrices: t.optionIds.map((id) => config.options.get(id)!.price),
        })),
        ctx.employee.subsidyAmount,
      );

      const { rows } = await tx.query(
        `INSERT INTO registrations (agency_id, event_id, event_employee_id, session_id, total_amount, subsidy_amount,
                                    payment_status, terms_version_accepted, terms_accepted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING id`,
        [
          ctx.agency.id,
          ctx.event.id,
          ctx.employee.id,
          hold.session_id,
          fees.total,
          ctx.employee.subsidyAmount,
          fees.selfPay === 0 ? 'not_required' : 'unpaid',
          ctx.event.termsVersion,
        ],
      );
      const registrationId: string = rows[0].id;

      for (const [index, t] of details.entries()) {
        const type = config.types.get(t.travelerTypeId)!;
        const { plain, sensitive, masks } = this.splitFields(config, t.fieldValues);
        const inserted = await tx.query(
          `INSERT INTO travelers (agency_id, registration_id, traveler_type_id, is_employee_self, name, base_price_snapshot,
                                  field_values, sensitive_values_encrypted, sensitive_masks, requested_room_no, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [
            ctx.agency.id,
            registrationId,
            type.id,
            type.isEmployeeSelf,
            t.name,
            type.basePrice,
            JSON.stringify(plain),
            Object.keys(sensitive).length ? this.encryption.encryptJson(sensitive) : null,
            JSON.stringify(masks),
            t.requestedRoomNo,
            index,
          ],
        );
        for (const optionId of t.optionIds) {
          await tx.query(
            `INSERT INTO traveler_options (agency_id, traveler_id, option_id, price_snapshot) VALUES ($1, $2, $3, $4)`,
            [ctx.agency.id, inserted.rows[0].id, optionId, config.options.get(optionId)!.price],
          );
        }
      }

      for (const p of req.roomPreferences) {
        await tx.query(
          `INSERT INTO room_preferences (agency_id, registration_id, requested_room_no, preferred_coworker_name, note)
           VALUES ($1, $2, $3, $4, $5)`,
          [ctx.agency.id, registrationId, p.requestedRoomNo, p.preferredCoworkerName, p.note],
        );
      }

      await tx.query(`UPDATE event_sessions SET sold_count = sold_count + $1 WHERE id = $2`, [
        hold.quantity,
        hold.session_id,
      ]);
      for (const [quotaId, quantity] of needs) {
        await tx.query(`UPDATE option_session_quotas SET sold_count = sold_count + $1 WHERE id = $2`, [quantity, quotaId]);
      }
      await tx.query(
        `UPDATE seat_holds SET status = 'converted', registration_id = $1, closed_at = now() WHERE id = $2`,
        [registrationId, hold.id],
      );
      await tx.query(`DELETE FROM registration_drafts WHERE event_employee_id = $1`, [ctx.employee.id]);
      await tx.query(
        `INSERT INTO registration_revisions (agency_id, registration_id, revision_no, actor_type, actor_id, changed_fields, after_encrypted)
         VALUES ($1, $2, 1, 'employee', $3, '{created}', $4)`,
        [ctx.agency.id, registrationId, ctx.employee.id, this.encryption.encryptJson(details)],
      );
      return this.loadRegistration(tx, ctx.employee.id, config);
    }).catch(rethrowUniqueViolation('registrations_one_active', 'ALREADY_REGISTERED'));
  }

  // ===== 取消 =====

  async requestCancel(ctx: EmployeeContext) {
    return this.db.withTenant(ctx.agency.id, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE registrations SET status = 'cancel_requested', cancel_requested_at = now(), updated_at = now()
          WHERE event_employee_id = $1 AND status = 'confirmed'`,
        [ctx.employee.id],
      );
      if (!rowCount) throw new DomainError('NOT_CANCELLABLE');
      const config = await this.loadConfig(tx, ctx.event.id);
      return this.loadRegistration(tx, ctx.employee.id, config);
    });
  }

  /** 旅行社確認取消後才生效並釋出名額。後台權限完成後再開放 HTTP 介面。 */
  async confirmCancel(agencyId: string, registrationId: string, actorId: string | null) {
    await this.db.withTenant(agencyId, async (tx) => {
      const found = await tx.query(`SELECT id, event_id, session_id FROM registrations WHERE id = $1`, [registrationId]);
      const reg = found.rows[0];
      if (!reg) throw new DomainError('NOT_FOUND');

      const { rows: quotaRows } = await tx.query(
        `SELECT q.id, count(*)::int AS quantity
           FROM travelers t
           JOIN traveler_options o ON o.traveler_id = t.id
           JOIN option_session_quotas q ON q.option_id = o.option_id AND q.session_id = $2
          WHERE t.registration_id = $1
          GROUP BY q.id`,
        [registrationId, reg.session_id],
      );
      await this.lockSeats(tx, reg.event_id, reg.session_id, quotaRows.map((r) => r.id));

      const updated = await tx.query(
        `UPDATE registrations SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, updated_at = now()
          WHERE id = $1 AND status = 'cancel_requested'`,
        [registrationId, actorId],
      );
      if (!updated.rowCount) throw new DomainError('NOT_CANCELLABLE');

      const count = await tx.query(`SELECT count(*)::int AS n FROM travelers WHERE registration_id = $1`, [registrationId]);
      await tx.query(`UPDATE event_sessions SET sold_count = sold_count - $1 WHERE id = $2`, [
        count.rows[0].n,
        reg.session_id,
      ]);
      for (const q of quotaRows) {
        await tx.query(`UPDATE option_session_quotas SET sold_count = sold_count - $1 WHERE id = $2`, [q.quantity, q.id]);
      }
    });
  }

  // ===== 內部 =====

  private openState(ctx: EmployeeContext): 'not_open' | 'open' | 'closed' {
    const now = Date.now();
    const { status, registrationOpensAt: opens, registrationClosesAt: closes } = ctx.event;
    if (status === 'closed' || (closes && closes.getTime() <= now)) return 'closed';
    if (opens && opens.getTime() > now) return 'not_open';
    return 'open';
  }

  private assertOpen(ctx: EmployeeContext) {
    const state = this.openState(ctx);
    if (state === 'not_open') throw new DomainError('REGISTRATION_NOT_OPEN');
    if (state === 'closed') throw new DomainError('REGISTRATION_CLOSED');
  }

  private async assertNotRegistered(tx: Tx, employeeId: string) {
    const r = await tx.query(`SELECT 1 FROM registrations WHERE event_employee_id = $1 AND status <> 'cancelled'`, [
      employeeId,
    ]);
    if (r.rowCount) throw new DomainError('ALREADY_REGISTERED');
  }

  private validateSelection(ctx: EmployeeContext, config: EventConfig, travelers: Selection) {
    const keys = new Set(travelers.map((t) => t.key));
    if (keys.size !== travelers.length) throw new DomainError('INVALID_SELECTION', { reason: 'duplicate_key' });

    let selfCount = 0;
    for (const t of travelers) {
      const type = config.types.get(t.travelerTypeId);
      if (!type) throw new DomainError('INVALID_SELECTION', { reason: 'unknown_traveler_type' });
      if (type.isEmployeeSelf) selfCount += 1;

      if (new Set(t.optionIds).size !== t.optionIds.length) {
        throw new DomainError('INVALID_SELECTION', { reason: 'duplicate_option' });
      }
      const perGroup = new Map<string, number>();
      for (const id of t.optionIds) {
        const option = config.options.get(id);
        if (!option) throw new DomainError('INVALID_SELECTION', { reason: 'unknown_option' });
        perGroup.set(option.groupId, (perGroup.get(option.groupId) ?? 0) + 1);
      }
      for (const g of config.groups.values()) {
        const n = perGroup.get(g.id) ?? 0;
        if (n < g.minSelect || n > g.maxSelect) {
          throw new DomainError('INVALID_SELECTION', { reason: 'option_group_rule', groupId: g.id });
        }
      }
    }

    if (selfCount > 1) throw new DomainError('INVALID_SELECTION', { reason: 'multiple_self' });
    if (selfCount === 0 && !ctx.event.allowDependentsOnly) {
      throw new DomainError('INVALID_SELECTION', { reason: 'self_required' });
    }
    if (travelers.length - selfCount > ctx.employee.dependentLimit) {
      throw new DomainError('INVALID_SELECTION', { reason: 'dependent_limit' });
    }
  }

  private validateDetails(config: EventConfig, travelers: DraftRequest['travelers']) {
    const errors: { key: string; field: string }[] = [];
    for (const t of travelers) {
      if (!t.name) errors.push({ key: t.key, field: 'name' });
      for (const f of config.fields) {
        const v = t.fieldValues[f.key];
        const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
        if (f.isRequired && empty) errors.push({ key: t.key, field: f.key });
        if (!empty && !this.isValidFieldValue(f, v)) errors.push({ key: t.key, field: f.key });
      }
    }
    if (errors.length) throw new DomainError('INVALID_DETAILS', { errors });
  }

  private isValidFieldValue(field: EventConfig['fields'][number], value: unknown): boolean {
    const choices = Array.isArray(field.choices) ? field.choices : [];
    switch (field.type) {
      case 'select':
        return choices.includes(value);
      case 'multiselect':
        return Array.isArray(value) && new Set(value).size === value.length && value.every((v) => choices.includes(v));
      case 'number':
        return (typeof value === 'number' || typeof value === 'string') && value !== '' && Number.isFinite(Number(value));
      case 'date':
        return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
      default:
        return typeof value === 'string';
    }
  }

  /** 每個受名額限制的選項在此梯次需要幾個名額；沒有名額設定的選項不限量。 */
  private async quotaNeeds(tx: Tx, sessionId: string, travelers: Selection): Promise<Map<string, number>> {
    const session = await tx.query(`SELECT 1 FROM event_sessions WHERE id = $1`, [sessionId]);
    if (!session.rowCount) throw new DomainError('INVALID_SELECTION', { reason: 'unknown_session' });
    const optionIds = travelers.flatMap((t) => t.optionIds);
    const needs = new Map<string, number>();
    if (!optionIds.length) return needs;
    const { rows } = await tx.query(
      `SELECT id, option_id FROM option_session_quotas WHERE session_id = $1 AND option_id = ANY($2::uuid[])`,
      [sessionId, optionIds],
    );
    const quotaByOption = new Map<string, string>(rows.map((r) => [r.option_id, r.id]));
    for (const optionId of optionIds) {
      const quotaId = quotaByOption.get(optionId);
      if (quotaId) needs.set(quotaId, (needs.get(quotaId) ?? 0) + 1);
    }
    return needs;
  }

  /** 固定鎖定順序：先梯次，再依 ID 排序的選項名額，避免死結。 */
  private async lockSeats(tx: Tx, eventId: string, sessionId: string, quotaIds: string[]) {
    const session = await tx.query(`SELECT id FROM event_sessions WHERE id = $1 AND event_id = $2 FOR UPDATE`, [
      sessionId,
      eventId,
    ]);
    if (!session.rowCount) throw new DomainError('INVALID_SELECTION', { reason: 'unknown_session' });
    for (const id of [...quotaIds].sort()) {
      await tx.query(`SELECT id FROM option_session_quotas WHERE id = $1 FOR UPDATE`, [id]);
    }
  }

  /** 呼叫前必須已取得 lockSeats 的鎖。excludeHoldId 用於修改自己的保留。 */
  private async assertSeats(tx: Tx, sessionId: string, quantity: number, needs: Map<string, number>, excludeHoldId?: string) {
    const exclude = excludeHoldId ?? '00000000-0000-0000-0000-000000000000';
    const s = await tx.query(
      `SELECT s.capacity, s.sold_count,
              COALESCE((SELECT sum(h.quantity) FROM seat_holds h
                         WHERE h.session_id = s.id AND h.status = 'active' AND h.expires_at > now() AND h.id <> $2), 0)::int AS held
         FROM event_sessions s WHERE s.id = $1`,
      [sessionId, exclude],
    );
    const seat = s.rows[0];
    if (seat.sold_count + seat.held + quantity > seat.capacity) {
      throw new DomainError('SESSION_FULL', {
        status: seatStatus(seat.capacity, seat.sold_count, seat.held),
        remaining: Math.max(seat.capacity - seat.sold_count - seat.held, 0),
      });
    }
    for (const [quotaId, need] of needs) {
      const q = await tx.query(
        `SELECT q.option_id, q.capacity, q.sold_count,
                COALESCE((SELECT sum(i.quantity) FROM seat_hold_items i JOIN seat_holds h ON h.id = i.hold_id
                           WHERE i.quota_id = q.id AND h.status = 'active' AND h.expires_at > now() AND h.id <> $2), 0)::int AS held
           FROM option_session_quotas q WHERE q.id = $1`,
        [quotaId, exclude],
      );
      const quota = q.rows[0];
      if (quota.sold_count + quota.held + need > quota.capacity) {
        throw new DomainError('OPTION_FULL', {
          optionId: quota.option_id,
          status: seatStatus(quota.capacity, quota.sold_count, quota.held),
          remaining: Math.max(quota.capacity - quota.sold_count - quota.held, 0),
        });
      }
    }
  }

  private async writeHoldItems(tx: Tx, agencyId: string, holdId: string, needs: Map<string, number>) {
    for (const [quotaId, quantity] of needs) {
      await tx.query(`INSERT INTO seat_hold_items (agency_id, hold_id, quota_id, quantity) VALUES ($1, $2, $3, $4)`, [
        agencyId,
        holdId,
        quotaId,
        quantity,
      ]);
    }
  }

  private async loadConfig(tx: Tx, eventId: string): Promise<EventConfig> {
    const types = await tx.query(
      `SELECT id, name, base_price, is_employee_self FROM traveler_types WHERE event_id = $1 ORDER BY sort_order, name`,
      [eventId],
    );
    const groups = await tx.query(
      `SELECT id, name, is_required, min_select, max_select FROM option_groups WHERE event_id = $1 ORDER BY sort_order, name`,
      [eventId],
    );
    const options = await tx.query(
      `SELECT o.id, o.group_id, o.name, o.price FROM options o JOIN option_groups g ON g.id = o.group_id
        WHERE g.event_id = $1 ORDER BY o.sort_order, o.name`,
      [eventId],
    );
    const fields = await tx.query(
      `SELECT id, field_key, label, field_type, choices, is_required, is_sensitive FROM event_fields WHERE event_id = $1 ORDER BY sort_order, label`,
      [eventId],
    );
    const config: EventConfig = {
      types: new Map(
        types.rows.map((r) => [r.id, { id: r.id, name: r.name, basePrice: r.base_price, isEmployeeSelf: r.is_employee_self }]),
      ),
      groups: new Map(
        groups.rows.map((r) => [
          r.id,
          { id: r.id, name: r.name, isRequired: r.is_required, minSelect: r.min_select, maxSelect: r.max_select, options: [] as string[] },
        ]),
      ),
      options: new Map(options.rows.map((r) => [r.id, { id: r.id, groupId: r.group_id, name: r.name, price: r.price }])),
      fields: fields.rows.map((r) => ({
        id: r.id,
        key: r.field_key,
        label: r.label,
        type: r.field_type,
        choices: r.choices,
        isRequired: r.is_required,
        isSensitive: r.is_sensitive,
      })),
    };
    for (const o of config.options.values()) config.groups.get(o.groupId)?.options.push(o.id);
    return config;
  }

  private async loadAvailability(tx: Tx, eventId: string) {
    const sessions = await tx.query(
      `SELECT s.id, s.name, s.departs_on, s.returns_on, s.capacity, s.sold_count,
              s.outbound_flight_no, s.return_flight_no,
              to_char(s.departure_time, 'HH24:MI') AS departure_time,
              to_char(s.return_arrival_time, 'HH24:MI') AS return_arrival_time,
              COALESCE((SELECT sum(h.quantity) FROM seat_holds h
                         WHERE h.session_id = s.id AND h.status = 'active' AND h.expires_at > now()), 0)::int AS held
         FROM event_sessions s WHERE s.event_id = $1 ORDER BY s.sort_order, s.departs_on, s.name`,
      [eventId],
    );
    const quotas = await tx.query(
      `SELECT q.session_id, q.option_id, q.capacity, q.sold_count,
              COALESCE((SELECT sum(i.quantity) FROM seat_hold_items i JOIN seat_holds h ON h.id = i.hold_id
                         WHERE i.quota_id = q.id AND h.status = 'active' AND h.expires_at > now()), 0)::int AS held
         FROM option_session_quotas q JOIN event_sessions s ON s.id = q.session_id WHERE s.event_id = $1`,
      [eventId],
    );
    return sessions.rows.map((s) => ({
      id: s.id,
      name: s.name,
      departsOn: s.departs_on,
      returnsOn: s.returns_on,
      outboundFlightNo: s.outbound_flight_no,
      returnFlightNo: s.return_flight_no,
      departureTime: s.departure_time,
      returnArrivalTime: s.return_arrival_time,
      remaining: Math.max(s.capacity - s.sold_count - s.held, 0),
      status: seatStatus(s.capacity, s.sold_count, s.held),
      options: quotas.rows
        .filter((q) => q.session_id === s.id)
        .map((q) => ({
          optionId: q.option_id,
          remaining: Math.max(q.capacity - q.sold_count - q.held, 0),
          status: seatStatus(q.capacity, q.sold_count, q.held),
        })),
    }));
  }

  private async loadActiveHold(tx: Tx, employeeId: string) {
    const { rows } = await tx.query(
      `SELECT id, session_id, quantity, expires_at FROM seat_holds
        WHERE event_employee_id = $1 AND status = 'active' AND expires_at > now()`,
      [employeeId],
    );
    const h = rows[0];
    return h ? { id: h.id, sessionId: h.session_id, quantity: h.quantity, expiresAt: h.expires_at } : null;
  }

  /** 已送出的報名：敏感欄位只回傳遮罩內容。 */
  private async loadRegistration(tx: Tx, employeeId: string, config: EventConfig) {
    const { rows } = await tx.query(
      `SELECT r.id, r.session_id, r.status, r.total_amount, r.subsidy_amount, r.self_pay_amount, r.payment_status, r.submitted_at
         FROM registrations r WHERE r.event_employee_id = $1 AND r.status <> 'cancelled'`,
      [employeeId],
    );
    const r = rows[0];
    if (!r) return null;
    const travelers = await tx.query(
      `SELECT t.id, t.name, t.traveler_type_id, t.base_price_snapshot, t.field_values, t.sensitive_masks, t.requested_room_no,
              COALESCE((SELECT json_agg(json_build_object('optionId', o.option_id, 'price', o.price_snapshot))
                          FROM traveler_options o WHERE o.traveler_id = t.id), '[]') AS options
         FROM travelers t WHERE t.registration_id = $1 ORDER BY t.sort_order`,
      [r.id],
    );
    return {
      id: r.id,
      sessionId: r.session_id,
      status: r.status,
      totalAmount: r.total_amount,
      subsidyAmount: r.subsidy_amount,
      subsidyApplied: Math.min(r.total_amount, r.subsidy_amount),
      selfPayAmount: r.self_pay_amount,
      paymentStatus: r.payment_status,
      submittedAt: r.submitted_at,
      travelers: travelers.rows.map((t) => ({
        name: t.name,
        travelerTypeName: config.types.get(t.traveler_type_id)?.name ?? '',
        basePrice: t.base_price_snapshot,
        fieldValues: { ...t.field_values, ...t.sensitive_masks },
        requestedRoomNo: t.requested_room_no,
        options: t.options.map((o: { optionId: string; price: number }) => ({
          name: config.options.get(o.optionId)?.name ?? '',
          price: o.price,
        })),
      })),
    };
  }

  private async readDraftPayload(tx: Tx, employeeId: string): Promise<DraftPayload | null> {
    const { rows } = await tx.query(`SELECT payload_encrypted FROM registration_drafts WHERE event_employee_id = $1`, [
      employeeId,
    ]);
    return rows[0] ? this.encryption.decryptJson<DraftPayload>(rows[0].payload_encrypted) : null;
  }

  /** 回傳給前端的草稿不含敏感欄位原值，帳號外流也不會洩漏完整個資。 */
  private async loadDraft(tx: Tx, employeeId: string, config: EventConfig) {
    const draft = await this.readDraftPayload(tx, employeeId);
    if (!draft) return null;
    const sensitive = config.fields.filter((f) => f.isSensitive);
    return {
      roomPreferences: draft.roomPreferences,
      travelers: draft.travelers.map((t) => {
        const fieldValues = { ...t.fieldValues };
        const masks: Record<string, string> = {};
        for (const f of sensitive) {
          const v = fieldValues[f.key];
          if (typeof v === 'string' && v) masks[f.key] = maskValue(v);
          delete fieldValues[f.key];
        }
        return { ...t, fieldValues, masks };
      }),
    };
  }

  /** 依旅客 key 把草稿中的敏感欄位補回；前端有送新值時以新值為準。 */
  private mergeSensitive<T extends DraftRequest>(req: T, previous: DraftPayload | null, config: EventConfig): T {
    const sensitive = config.fields.filter((f) => f.isSensitive);
    const prev = new Map((previous?.travelers ?? []).map((t) => [t.key, t]));
    return {
      ...req,
      travelers: req.travelers.map((t) => {
        const fieldValues = { ...t.fieldValues };
        for (const f of sensitive) {
          const incoming = fieldValues[f.key];
          if (incoming === undefined || incoming === null || incoming === '') {
            const saved = prev.get(t.key)?.fieldValues[f.key];
            if (saved !== undefined) fieldValues[f.key] = saved;
            else delete fieldValues[f.key];
          }
        }
        return { ...t, fieldValues };
      }),
    };
  }

  private splitFields(config: EventConfig, values: Record<string, unknown>) {
    const plain: Record<string, unknown> = {};
    const sensitive: Record<string, unknown> = {};
    const masks: Record<string, string> = {};
    for (const f of config.fields) {
      const v = values[f.key];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
      if (f.isSensitive) {
        sensitive[f.key] = v;
        masks[f.key] = maskValue(String(v));
      } else {
        plain[f.key] = v;
      }
    }
    return { plain, sensitive, masks };
  }
}
