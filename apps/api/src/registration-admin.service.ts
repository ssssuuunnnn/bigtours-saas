import { Inject, Injectable } from '@nestjs/common';
import type { AgencyModifyRequest, FeeAdjustInput, ReassignInput } from '@bigtours/shared';
import type { AgencyUserContext } from './agency-admin.service.ts';
import { DatabaseService, type Tx } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { DomainError } from './errors.ts';
import { NotificationService, type MailEvent, type MailTemplate } from './notification.service.ts';
import { addRevision, paymentAfter } from './registration-log.ts';
import { RegistrationService } from './registration.service.ts';

const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PendingMail { employee: { id: string; name: string; email: string | null }; template: MailTemplate }

@Injectable()
export class RegistrationAdminService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(RegistrationService) private readonly registrations: RegistrationService,
  ) {}

  private async assertEvent(tx: Tx, eventId: string) {
    if (!UUID.test(eventId)) throw new DomainError('NOT_FOUND');
    const { rowCount } = await tx.query(`SELECT 1 FROM events WHERE id = $1`, [eventId]);
    if (!rowCount) throw new DomainError('NOT_FOUND');
  }

  private async lockRegistration(tx: Tx, eventId: string, registrationId: string) {
    if (!UUID.test(registrationId)) throw new DomainError('NOT_FOUND');
    const { rows } = await tx.query(
      `SELECT r.id, r.status, r.total_amount, r.subsidy_amount, r.self_pay_amount, r.payment_status, r.event_employee_id, m.name AS employee_name, m.email
         FROM registrations r JOIN event_employees m ON m.id = r.event_employee_id
        WHERE r.id = $1 AND r.event_id = $2 FOR UPDATE OF r`,
      [registrationId, eventId],
    );
    if (!rows[0]) throw new DomainError('NOT_FOUND');
    return rows[0];
  }

  /** 交易成功後才寄信；寄信失敗不影響已生效的操作。 */
  private notify(agencyId: string, eventId: string, event: MailEvent, mails: PendingMail[]) {
    for (const m of mails) {
      if (!m.employee.email) continue;
      void this.notifications.deliver(agencyId, eventId, event, { id: m.employee.id, name: m.employee.name, email: m.employee.email }, m.template);
    }
  }

  // ===== 總覽 =====

  overview(ctx: AgencyUserContext, eventId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertEvent(tx, eventId);
      const { rows } = await tx.query(
        `SELECT e.status, e.registration_opens_at, e.registration_closes_at, t.max_travelers,
                (SELECT count(*)::int FROM event_employees m WHERE m.event_id = e.id AND m.status = 'active') AS roster,
                (SELECT count(*)::int FROM registrations r WHERE r.event_id = e.id AND r.status <> 'cancelled') AS registered,
                (SELECT count(*)::int FROM registrations r WHERE r.event_id = e.id AND r.status = 'cancel_requested') AS pending_cancels,
                (SELECT count(*)::int FROM registrations r WHERE r.event_id = e.id AND r.status <> 'cancelled' AND r.payment_status = 'unpaid') AS unpaid,
                (SELECT count(*)::int FROM travelers x JOIN registrations r ON r.id = x.registration_id WHERE r.event_id = e.id AND r.status <> 'cancelled') AS travelers
           FROM events e JOIN pricing_tiers t ON t.id = e.pricing_tier_id WHERE e.id = $1`,
        [eventId],
      );
      const { rows: sessions } = await tx.query(
        `SELECT s.id, s.name, s.capacity, s.sold_count,
                COALESCE((SELECT sum(h.quantity) FROM seat_holds h WHERE h.session_id = s.id AND h.status = 'active' AND h.expires_at > now()), 0)::int AS held
           FROM event_sessions s WHERE s.event_id = $1 ORDER BY s.sort_order, s.departs_on, s.name`,
        [eventId],
      );
      const r = rows[0];
      return {
        status: r.status,
        registrationOpensAt: r.registration_opens_at,
        registrationClosesAt: r.registration_closes_at,
        tierMax: r.max_travelers,
        roster: r.roster,
        registered: r.registered,
        pendingCancels: r.pending_cancels,
        unpaid: r.unpaid,
        travelers: r.travelers,
        sessions: sessions.map((s) => ({ id: s.id, name: s.name, capacity: s.capacity, sold: s.sold_count, held: s.held, remaining: Math.max(s.capacity - s.sold_count - s.held, 0) })),
      };
    });
  }

  // ===== 列表 =====

  list(ctx: AgencyUserContext, eventId: string, q: { search?: string; session?: string; payment?: string; status?: string; page?: number }) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertEvent(tx, eventId);
      const page = Math.max(1, Math.floor(q.page ?? 1) || 1);
      const params: unknown[] = [eventId];
      const where = ['r.event_id = $1'];
      const add = (sql: (n: number) => string, value: unknown) => { params.push(value); where.push(sql(params.length)); };
      if (q.search?.trim()) {
        add((n) => `(m.employee_no ILIKE $${n} OR m.name ILIKE $${n} OR EXISTS (SELECT 1 FROM travelers x WHERE x.registration_id = r.id AND x.name ILIKE $${n}))`, `%${q.search.trim().replace(/[\\%_]/g, '\\$&')}%`);
      }
      if (q.session && UUID.test(q.session)) add((n) => `r.session_id = $${n}`, q.session);
      if (q.payment && ['unpaid', 'paid', 'refunded', 'not_required'].includes(q.payment)) add((n) => `r.payment_status = $${n}`, q.payment);
      // 預設不列已取消，要看已取消的要明確選。
      if (q.status && ['confirmed', 'cancel_requested', 'cancelled'].includes(q.status)) add((n) => `r.status = $${n}`, q.status);
      else where.push(`r.status <> 'cancelled'`);
      const { rows } = await tx.query(
        `SELECT r.id, r.status, r.total_amount, r.subsidy_amount, r.self_pay_amount, r.payment_status, r.paid_amount, r.submitted_at,
                m.name AS employee_name, m.employee_no, s.name AS session_name,
                (SELECT count(*)::int FROM travelers x WHERE x.registration_id = r.id) AS traveler_count,
                count(*) OVER()::int AS total_count
           FROM registrations r
           JOIN event_employees m ON m.id = r.event_employee_id
           JOIN event_sessions s ON s.id = r.session_id
          WHERE ${where.join(' AND ')}
          ORDER BY r.status = 'cancel_requested' DESC, r.submitted_at DESC
          LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
        params,
      );
      const { rows: totals } = await tx.query(
        `SELECT count(DISTINCT r.id)::int AS registrations, count(x.id)::int AS travelers
           FROM registrations r LEFT JOIN travelers x ON x.registration_id = r.id WHERE r.event_id = $1 AND r.status <> 'cancelled'`,
        [eventId],
      );
      const { rows: sessions } = await tx.query(`SELECT id, name FROM event_sessions WHERE event_id = $1 ORDER BY sort_order, departs_on, name`, [eventId]);
      return {
        rows: rows.map((r) => ({
          id: r.id,
          employeeName: r.employee_name,
          employeeNo: r.employee_no,
          sessionName: r.session_name,
          travelerCount: r.traveler_count,
          totalAmount: r.total_amount,
          subsidyAmount: r.subsidy_amount,
          selfPayAmount: r.self_pay_amount,
          paymentStatus: r.payment_status,
          paymentDiff: r.payment_status === 'paid' && r.paid_amount !== null ? r.self_pay_amount - r.paid_amount : 0,
          status: r.status,
          submittedAt: r.submitted_at,
        })),
        total: rows[0]?.total_count ?? 0,
        page,
        pageSize: PAGE_SIZE,
        registrations: totals[0].registrations,
        travelers: totals[0].travelers,
        sessions,
      };
    });
  }

  // ===== 明細 =====

  detail(ctx: AgencyUserContext, eventId: string, registrationId: string) {
    if (!UUID.test(registrationId)) throw new DomainError('NOT_FOUND');
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT r.*, m.name AS employee_name, m.employee_no, s.name AS session_name
           FROM registrations r JOIN event_employees m ON m.id = r.event_employee_id JOIN event_sessions s ON s.id = r.session_id
          WHERE r.id = $1 AND r.event_id = $2`,
        [registrationId, eventId],
      );
      const r = rows[0];
      if (!r) throw new DomainError('NOT_FOUND');
      const { rows: fields } = await tx.query(`SELECT field_key, label FROM event_fields WHERE event_id = $1 ORDER BY sort_order`, [eventId]);
      const { rows: travelers } = await tx.query(
        `SELECT t.id, t.name, t.is_employee_self, t.base_price_snapshot, t.room_surcharge_snapshot, t.field_values, t.sensitive_masks, t.requested_room_no,
                y.name AS type_name, rt.name AS room_type_name,
                COALESCE((SELECT json_agg(json_build_object('name', o.name, 'price', x.price_snapshot) ORDER BY o.sort_order)
                            FROM traveler_options x JOIN options o ON o.id = x.option_id WHERE x.traveler_id = t.id), '[]') AS options,
                COALESCE((SELECT json_agg(json_build_object('rank', p.rank, 'optionName', o.name) ORDER BY p.rank)
                            FROM traveler_option_preferences p JOIN options o ON o.id = p.option_id WHERE p.traveler_id = t.id), '[]') AS preferences
           FROM travelers t JOIN traveler_types y ON y.id = t.traveler_type_id LEFT JOIN session_room_types rt ON rt.id = t.session_room_type_id
          WHERE t.registration_id = $1 ORDER BY t.sort_order`,
        [registrationId],
      );
      const { rows: coworkers } = await tx.query(
        `SELECT requested_room_no, preferred_coworker_name FROM room_preferences WHERE registration_id = $1 AND preferred_coworker_name IS NOT NULL ORDER BY requested_room_no`,
        [registrationId],
      );
      const { rows: revisions } = await tx.query(
        `SELECT v.revision_no, v.after_encrypted IS NOT NULL AND v.before_encrypted IS NOT NULL AS has_content, v.created_at, v.actor_type, v.changed_fields, v.summary,
                CASE v.actor_type
                  WHEN 'employee' THEN (SELECT name FROM event_employees e WHERE e.id = v.actor_id)
                  WHEN 'agency_user' THEN (SELECT name FROM agency_users u WHERE u.id = v.actor_id)
                END AS actor_name
           FROM registration_revisions v WHERE v.registration_id = $1 ORDER BY v.revision_no DESC`,
        [registrationId],
      );
      return {
        id: r.id,
        employeeName: r.employee_name,
        employeeNo: r.employee_no,
        sessionName: r.session_name,
        status: r.status,
        totalAmount: r.total_amount,
        subsidyAmount: r.subsidy_amount,
        subsidyApplied: Math.min(r.total_amount, r.subsidy_amount),
        selfPayAmount: r.self_pay_amount,
        paymentStatus: r.payment_status,
        paidAmount: r.paid_amount,
        paymentDiff: r.payment_status === 'paid' && r.paid_amount !== null ? r.self_pay_amount - r.paid_amount : 0,
        submittedAt: r.submitted_at,
        cancelRequestedAt: r.cancel_requested_at,
        cancelledAt: r.cancelled_at,
        canViewSensitive: ctx.user.role === 'admin',
        travelers: travelers.map((t) => ({
          id: t.id,
          name: t.name,
          typeName: t.type_name,
          isEmployeeSelf: t.is_employee_self,
          basePrice: t.base_price_snapshot,
          roomType: t.room_type_name ? { name: t.room_type_name, surcharge: t.room_surcharge_snapshot } : null,
          requestedRoomNo: t.requested_room_no,
          fields: fields.flatMap((f) => {
            const v = t.sensitive_masks[f.field_key] ?? t.field_values[f.field_key];
            return v === undefined ? [] : [{ key: f.field_key, label: f.label, value: Array.isArray(v) ? v.join('、') : String(v), sensitive: t.sensitive_masks[f.field_key] !== undefined }];
          }),
          options: t.options,
          preferences: t.preferences,
          fee: t.options.reduce((sum: number, o: { price: number }) => sum + o.price, t.base_price_snapshot + t.room_surcharge_snapshot),
        })),
        coworkers: coworkers.map((c) => ({ requestedRoomNo: c.requested_room_no, name: c.preferred_coworker_name })),
        revisions: revisions.map((v) => ({
          no: v.revision_no,
          hasContent: v.has_content,
          at: v.created_at,
          actorName: v.actor_name,
          actorType: v.actor_type,
          summary: v.summary.action ? v.summary : { action: v.changed_fields[0] ?? 'created' },
        })),
      };
    });
  }

  /** 修改前後的內容：敏感欄位在快照裡就只有遮罩。 */
  revision(ctx: AgencyUserContext, eventId: string, registrationId: string, no: number) {
    if (!UUID.test(registrationId) || !Number.isInteger(no)) throw new DomainError('NOT_FOUND');
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT v.before_encrypted, v.after_encrypted FROM registration_revisions v JOIN registrations r ON r.id = v.registration_id
          WHERE v.registration_id = $1 AND r.event_id = $2 AND v.revision_no = $3 AND v.before_encrypted IS NOT NULL`,
        [registrationId, eventId, no],
      );
      if (!rows[0]) throw new DomainError('NOT_FOUND');
      return { before: this.encryption.decryptJson(rows[0].before_encrypted), after: this.encryption.decryptJson(rows[0].after_encrypted) };
    });
  }

  editData(ctx: AgencyUserContext, eventId: string, registrationId: string) {
    if (!UUID.test(registrationId)) throw new DomainError('NOT_FOUND');
    return this.registrations.editData(ctx.agencyId, eventId, registrationId);
  }

  modify(ctx: AgencyUserContext, eventId: string, registrationId: string, input: AgencyModifyRequest) {
    if (!UUID.test(registrationId)) throw new DomainError('NOT_FOUND');
    return this.registrations.modifyByAgency(ctx.agencyId, eventId, registrationId, ctx.user.id, input);
  }

  /** 完整個資：只有管理員看得到，每次都留下紀錄。 */
  revealSensitive(ctx: AgencyUserContext, eventId: string, registrationId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockRegistration(tx, eventId, registrationId);
      const { rows } = await tx.query(`SELECT id, sensitive_values_encrypted FROM travelers WHERE registration_id = $1`, [registrationId]);
      const values: Record<string, Record<string, unknown>> = Object.fromEntries(rows.map((r) => [r.id, r.sensitive_values_encrypted ? this.encryption.decryptJson<Record<string, unknown>>(r.sensitive_values_encrypted) : {}]));
      // 紀錄只寫看了哪些欄位，不寫內容。
      const keys = [...new Set(Object.values(values).flatMap((v) => Object.keys(v)))];
      const fields = await tx.query(`SELECT label FROM event_fields WHERE event_id = $1 AND field_key = ANY($2::text[]) ORDER BY sort_order`, [eventId, keys]);
      await tx.query(
        `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id, metadata) VALUES ($1, 'agency_user', $2, 'registration.sensitive_viewed', 'registration', $3, $4)`,
        [ctx.agencyId, ctx.user.id, registrationId, JSON.stringify({ fields: fields.rows.map((f) => f.label) })],
      );
      return values;
    });
  }

  // ===== 付款與費用 =====

  async setPayment(ctx: AgencyUserContext, eventId: string, registrationId: string, to: 'unpaid' | 'paid' | 'refunded') {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      const r = await this.lockRegistration(tx, eventId, registrationId);
      if (r.self_pay_amount === 0) throw new DomainError('PAYMENT_NOT_REQUIRED');
      if (r.payment_status === to) return;
      // 記下已付金額，之後費用變動才知道差額。
      await tx.query(`UPDATE registrations SET payment_status = $2, paid_amount = $3, updated_at = now() WHERE id = $1`, [registrationId, to, to === 'paid' ? r.self_pay_amount : null]);
      await addRevision(tx, ctx.agencyId, registrationId, { type: 'agency_user', id: ctx.user.id }, { action: 'payment', from: r.payment_status, to });
    });
  }

  /** 手動調整整筆費用，例如最終分房與選的房型不同；原因留在修改紀錄。 */
  async adjustFee(ctx: AgencyUserContext, eventId: string, registrationId: string, input: FeeAdjustInput) {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      const r = await this.lockRegistration(tx, eventId, registrationId);
      if (r.status === 'cancelled') throw new DomainError('REGISTRATION_CANCELLED');
      if (r.total_amount === input.totalAmount) return;
      const payment = paymentAfter(r.payment_status, Math.max(input.totalAmount - r.subsidy_amount, 0));
      await tx.query(`UPDATE registrations SET total_amount = $2, payment_status = $3, updated_at = now() WHERE id = $1`, [registrationId, input.totalAmount, payment]);
      await addRevision(tx, ctx.agencyId, registrationId, { type: 'agency_user', id: ctx.user.id }, { action: 'fee_adjusted', from: r.total_amount, to: input.totalAmount, reason: input.reason });
    });
  }

  // ===== 取消 =====

  async confirmCancel(ctx: AgencyUserContext, eventId: string, registrationId: string) {
    const r = await this.db.withTenant(ctx.agencyId, async (tx) => {
      const found = await this.lockRegistration(tx, eventId, registrationId);
      return { found, event: await this.notifications.mailEvent(tx, eventId) };
    });
    await this.registrations.confirmCancel(ctx.agencyId, registrationId, ctx.user.id);
    this.notify(ctx.agencyId, eventId, r.event, [{ employee: { id: r.found.event_employee_id, name: r.found.employee_name, email: r.found.email }, template: { key: 'cancel_confirmed' } }]);
  }

  async rejectCancel(ctx: AgencyUserContext, eventId: string, registrationId: string) {
    const r = await this.db.withTenant(ctx.agencyId, async (tx) => {
      const found = await this.lockRegistration(tx, eventId, registrationId);
      if (found.status !== 'cancel_requested') throw new DomainError('NOT_CANCELLABLE');
      await tx.query(`UPDATE registrations SET status = 'confirmed', cancel_requested_at = NULL, updated_at = now() WHERE id = $1`, [registrationId]);
      await addRevision(tx, ctx.agencyId, registrationId, { type: 'agency_user', id: ctx.user.id }, { action: 'cancel_rejected' });
      return { found, event: await this.notifications.mailEvent(tx, eventId) };
    });
    this.notify(ctx.agencyId, eventId, r.event, [{ employee: { id: r.found.event_employee_id, name: r.found.employee_name, email: r.found.email }, template: { key: 'cancel_rejected' } }]);
  }

  // ===== 改派 =====

  /** 有旅客選的選項，依梯次列出，供選擇要改派哪一個行程。 */
  reassignSources(ctx: AgencyUserContext, eventId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertEvent(tx, eventId);
      const { rows } = await tx.query(
        `SELECT r.session_id, s.name AS session_name, o.id AS option_id, o.name AS option_name, g.name AS group_name, count(*)::int AS travelers
           FROM traveler_options x
           JOIN options o ON o.id = x.option_id JOIN option_groups g ON g.id = o.group_id
           JOIN travelers t ON t.id = x.traveler_id JOIN registrations r ON r.id = t.registration_id JOIN event_sessions s ON s.id = r.session_id
          WHERE r.event_id = $1 AND r.status <> 'cancelled'
          GROUP BY r.session_id, s.name, s.sort_order, o.id, o.name, o.sort_order, g.name, g.sort_order
          ORDER BY s.sort_order, g.sort_order, o.sort_order`,
        [eventId],
      );
      return rows.map((r) => ({ sessionId: r.session_id, sessionName: r.session_name, optionId: r.option_id, optionName: r.option_name, groupName: r.group_name, travelers: r.travelers }));
    });
  }

  private async targetsOf(tx: Tx, eventId: string, sessionId: string, optionId: string) {
    if (!UUID.test(sessionId) || !UUID.test(optionId)) throw new DomainError('NOT_FOUND');
    const { rows: source } = await tx.query(
      `SELECT o.id, o.name, o.price, o.group_id FROM options o JOIN option_groups g ON g.id = o.group_id WHERE o.id = $1 AND g.event_id = $2`,
      [optionId, eventId],
    );
    if (!source[0]) throw new DomainError('NOT_FOUND');
    const { rows: session } = await tx.query(`SELECT 1 FROM event_sessions WHERE id = $1 AND event_id = $2`, [sessionId, eventId]);
    if (!session[0]) throw new DomainError('NOT_FOUND');
    const { rows: targets } = await tx.query(
      `SELECT o.id, o.name, o.price, q.id AS quota_id, q.capacity, q.sold_count,
              COALESCE((SELECT sum(i.quantity) FROM seat_hold_items i JOIN seat_holds h ON h.id = i.hold_id
                         WHERE i.quota_id = q.id AND h.status = 'active' AND h.expires_at > now()), 0)::int AS held
         FROM options o LEFT JOIN option_session_quotas q ON q.option_id = o.id AND q.session_id = $2
        WHERE o.group_id = $1 AND o.id <> $3 ORDER BY o.sort_order, o.name`,
      [source[0].group_id, sessionId, optionId],
    );
    return { source: source[0], targets };
  }

  /** 依報名先後、志願與剩餘名額預填；旅行社可以改，確認後才生效。 */
  reassignPlan(ctx: AgencyUserContext, eventId: string, sessionId: string, optionId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const { source, targets } = await this.targetsOf(tx, eventId, sessionId, optionId);
      const { rows } = await tx.query(
        `SELECT t.id, t.name, t.is_employee_self, m.name AS employee_name, m.employee_no, x.price_snapshot,
                (SELECT array_agg(o2.option_id) FROM traveler_options o2 WHERE o2.traveler_id = t.id AND o2.option_id <> $3) AS other_options,
                COALESCE((SELECT json_agg(p.option_id ORDER BY p.rank) FROM traveler_option_preferences p WHERE p.traveler_id = t.id AND p.group_id = $4), '[]') AS preferences
           FROM traveler_options x
           JOIN travelers t ON t.id = x.traveler_id JOIN registrations r ON r.id = t.registration_id JOIN event_employees m ON m.id = r.event_employee_id
          WHERE r.event_id = $1 AND r.session_id = $2 AND x.option_id = $3 AND r.status <> 'cancelled'
          ORDER BY r.submitted_at, t.sort_order`,
        [eventId, sessionId, optionId, source.group_id],
      );
      const left = new Map<string, number | null>(targets.map((t) => [t.id as string, t.quota_id ? Math.max(t.capacity - t.sold_count - t.held, 0) : null]));
      const travelers = rows.map((r) => {
        const taken = new Set<string>(r.other_options ?? []);
        const suggested = (r.preferences as string[]).find((id) => {
          if (taken.has(id) || !left.has(id)) return false;
          const n = left.get(id);
          return n === null || n! > 0;
        }) ?? null;
        if (suggested && left.get(suggested) !== null) left.set(suggested, left.get(suggested)! - 1);
        return {
          id: r.id,
          name: r.name,
          isEmployeeSelf: r.is_employee_self,
          employeeName: r.employee_name,
          employeeNo: r.employee_no,
          currentPrice: r.price_snapshot,
          preferences: r.preferences,
          excluded: [...taken],
          suggested,
        };
      });
      return {
        option: { id: source.id, name: source.name },
        targets: targets.map((t) => ({ id: t.id, name: t.name, price: t.price, remaining: t.quota_id ? Math.max(t.capacity - t.sold_count - t.held, 0) : null })),
        travelers,
      };
    });
  }

  /**
   * 沒選改派目的地的旅客維持原行程。名額不足時整批不生效。
   * 費用依新行程重算：新行程用目前價格，已付款的差額由旅行社處理。
   */
  async reassign(ctx: AgencyUserContext, eventId: string, input: ReassignInput) {
    const result = await this.db.withTenant(ctx.agencyId, async (tx) => {
      const { source, targets } = await this.targetsOf(tx, eventId, input.sessionId, input.optionId);
      const targetById = new Map(targets.map((t) => [t.id as string, t]));
      if (new Set(input.assignments.map((a) => a.travelerId)).size !== input.assignments.length) throw new DomainError('INVALID_INPUT', { issues: ['assignments'] });
      if (input.assignments.some((a) => !targetById.has(a.toOptionId))) throw new DomainError('INVALID_INPUT', { issues: ['toOptionId'] });

      // 與報名相同的鎖定順序：先梯次，再依 ID 排序的選項名額。
      await tx.query(`SELECT id FROM event_sessions WHERE id = $1 FOR UPDATE`, [input.sessionId]);
      const { rows: sourceQuota } = await tx.query(`SELECT id FROM option_session_quotas WHERE option_id = $1 AND session_id = $2`, [input.optionId, input.sessionId]);
      const quotaIds = [...new Set([...sourceQuota.map((q) => q.id as string), ...targets.flatMap((t) => (t.quota_id ? [t.quota_id as string] : []))])].sort();
      for (const id of quotaIds) await tx.query(`SELECT id FROM option_session_quotas WHERE id = $1 FOR UPDATE`, [id]);

      const need = new Map<string, number>();
      for (const a of input.assignments) need.set(a.toOptionId, (need.get(a.toOptionId) ?? 0) + 1);
      for (const [optionId, n] of need) {
        const t = targetById.get(optionId)!;
        if (!t.quota_id) continue;
        const { rows: fresh } = await tx.query(
          `SELECT q.capacity, q.sold_count, COALESCE((SELECT sum(i.quantity) FROM seat_hold_items i JOIN seat_holds h ON h.id = i.hold_id
                     WHERE i.quota_id = q.id AND h.status = 'active' AND h.expires_at > now()), 0)::int AS held
             FROM option_session_quotas q WHERE q.id = $1`,
          [t.quota_id],
        );
        const remaining = fresh[0].capacity - fresh[0].sold_count - fresh[0].held;
        if (n > remaining) throw new DomainError('OPTION_FULL', { optionId, remaining: Math.max(remaining, 0) });
      }

      const byRegistration = new Map<string, { traveler: string; from: string; to: string; diff: number }[]>();
      for (const a of input.assignments) {
        const { rows } = await tx.query(
          `SELECT t.id, t.name, t.registration_id, x.price_snapshot
             FROM traveler_options x JOIN travelers t ON t.id = x.traveler_id JOIN registrations r ON r.id = t.registration_id
            WHERE x.traveler_id = $1 AND x.option_id = $2 AND r.event_id = $3 AND r.session_id = $4 AND r.status <> 'cancelled'`,
          [a.travelerId, input.optionId, eventId, input.sessionId],
        );
        if (!rows[0]) throw new DomainError('INVALID_INPUT', { issues: ['travelerId'] });
        const already = await tx.query(`SELECT 1 FROM traveler_options WHERE traveler_id = $1 AND option_id = $2`, [a.travelerId, a.toOptionId]);
        if (already.rowCount) throw new DomainError('INVALID_INPUT', { issues: ['toOptionId'] });
        const target = targetById.get(a.toOptionId)!;
        await tx.query(`DELETE FROM traveler_options WHERE traveler_id = $1 AND option_id = $2`, [a.travelerId, input.optionId]);
        await tx.query(`INSERT INTO traveler_options (agency_id, traveler_id, option_id, price_snapshot) VALUES ($1, $2, $3, $4)`, [ctx.agencyId, a.travelerId, a.toOptionId, target.price]);
        // 新行程已是第一志願，不再留在第二、第三志願；其餘志願往前補。
        await tx.query(`DELETE FROM traveler_option_preferences WHERE traveler_id = $1 AND option_id = $2`, [a.travelerId, a.toOptionId]);
        await tx.query(`UPDATE traveler_option_preferences SET rank = 2 WHERE traveler_id = $1 AND group_id = $2 AND rank = 3 AND NOT EXISTS (SELECT 1 FROM traveler_option_preferences p WHERE p.traveler_id = $1 AND p.group_id = $2 AND p.rank = 2)`, [a.travelerId, source.group_id]);
        const list = byRegistration.get(rows[0].registration_id) ?? [];
        list.push({ traveler: rows[0].name, from: source.name, to: target.name, diff: target.price - rows[0].price_snapshot });
        byRegistration.set(rows[0].registration_id, list);
      }

      if (sourceQuota[0]) await tx.query(`UPDATE option_session_quotas SET sold_count = sold_count - $2 WHERE id = $1`, [sourceQuota[0].id, input.assignments.length]);
      for (const [optionId, n] of need) {
        const quotaId = targetById.get(optionId)!.quota_id;
        if (quotaId) await tx.query(`UPDATE option_session_quotas SET sold_count = sold_count + $2 WHERE id = $1`, [quotaId, n]);
      }

      const mails: PendingMail[] = [];
      for (const registrationId of [...byRegistration.keys()].sort()) {
        const changes = byRegistration.get(registrationId)!;
        const r = await this.lockRegistration(tx, eventId, registrationId);
        const total = Math.max(r.total_amount + changes.reduce((sum, c) => sum + c.diff, 0), 0);
        const selfPay = Math.max(total - r.subsidy_amount, 0);
        await tx.query(`UPDATE registrations SET total_amount = $2, payment_status = $3, updated_at = now() WHERE id = $1`, [registrationId, total, paymentAfter(r.payment_status, selfPay)]);
        const plain = changes.map(({ traveler, from, to }) => ({ traveler, from, to }));
        await addRevision(tx, ctx.agencyId, registrationId, { type: 'agency_user', id: ctx.user.id }, { action: 'reassigned', from: r.total_amount, to: total, reason: input.reason, changes: plain });
        mails.push({ employee: { id: r.event_employee_id, name: r.employee_name, email: r.email }, template: { key: 'reassigned', reason: input.reason, changes: plain, total, selfPay } });
      }
      return { mails, event: await this.notifications.mailEvent(tx, eventId), moved: input.assignments.length, registrations: byRegistration.size };
    });
    this.notify(ctx.agencyId, eventId, result.event, result.mails);
    return { moved: result.moved, registrations: result.registrations };
  }
}
