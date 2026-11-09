import { Inject, Injectable, Logger } from '@nestjs/common';
import { publicCompanyLogo, publicImages, StorageService } from './storage.service.ts';
import {
  calculateFees,
  maskValue,
  seatStatus,
  type DraftRequest,
  type ErrorCode,
  type AgencyModifyRequest,
  type HoldRequest,
  type ModifyRequest,
  type SubmitRequest,
} from '@bigtours/shared';
import type { EmployeeContext } from './access.service.ts';
import { DatabaseService, type Tx } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { DomainError } from './errors.ts';
import { addRevision, paymentAfter } from './registration-log.ts';
import { NotificationService, type MailEvent } from './notification.service.ts';

const HOLD_MINUTES = 15;

type Selection = HoldRequest['travelers'];

interface EventConfig {
  types: Map<string, { id: string; name: string; basePrice: number; isEmployeeSelf: boolean; note: string | null; occupiesBed: boolean }>;
  groups: Map<string, { id: string; name: string; isRequired: boolean; minSelect: number; maxSelect: number; preferenceCount: number; activityDate: string | null; options: string[] }>;
  options: Map<string, { id: string; groupId: string; name: string; price: number; hasPdf: boolean }>;
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

/** 一筆保留需要的選項名額與房型床位。 */
interface SeatNeeds { quotas: Map<string, number>; rooms: Map<string, number> }
type RoomType = { id: string; surcharge: number };
interface SelectionRules { allowDependentsOnly: boolean; dependentLimit: number | null }
const employeeRules = (ctx: EmployeeContext): SelectionRules => ({ allowDependentsOnly: ctx.event.allowDependentsOnly, dependentLimit: ctx.employee.dependentLimit });

/** 不同梯次的併發請求不會互相排隊，由唯一索引作為最後防線，並轉成一般錯誤。 */
function rethrowUniqueViolation(constraint: string, code: ErrorCode) {
  return (err: { code?: string; constraint?: string }): never => {
    if (err.code === '23505' && err.constraint === constraint) throw new DomainError(code);
    throw err;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  // ===== 查詢 =====

  /** 行程 PDF 只給已登入的員工，一律開啟最新版。 */
  async readOptionPdf(ctx: EmployeeContext, optionId: string) {
    if (!UUID.test(optionId)) throw new DomainError('NOT_FOUND');
    const { rows } = await this.db.withTenant(ctx.agency.id, (tx) => tx.query(
      `SELECT o.pdf_object_key, o.pdf_file_name FROM options o JOIN option_groups g ON g.id = o.group_id WHERE o.id = $1 AND g.event_id = $2`,
      [optionId, ctx.event.id],
    ));
    if (!rows[0]?.pdf_object_key) throw new DomainError('NOT_FOUND');
    return { name: rows[0].pdf_file_name as string, content: await this.storage.get(rows[0].pdf_object_key) };
  }

  /** 條款只給已登入的員工，一律開啟最新版。 */
  async readTerms(ctx: EmployeeContext) {
    const { rows } = await this.db.withTenant(ctx.agency.id, (tx) =>
      tx.query(`SELECT terms_object_key, terms_file_name FROM events WHERE id = $1`, [ctx.event.id]));
    if (!rows[0]?.terms_object_key) throw new DomainError('NOT_FOUND');
    return { name: rows[0].terms_file_name as string, content: await this.storage.get(rows[0].terms_object_key) };
  }

  async getState(ctx: EmployeeContext) {
    return this.db.withTenant(ctx.agency.id, async (tx) => {
      const config = await this.loadConfig(tx, ctx.event.id);
      const availability = await this.loadAvailability(tx, ctx.event.id);
      const hold = await this.loadActiveHold(tx, ctx.employee.id);
      const registration = await this.loadRegistration(tx, ctx.employee.id, config);
      const draft = await this.loadDraft(tx, ctx.employee.id, config);
      // 保留逾時後重新整理，還要知道剛才改到哪個梯次。
      const lastModification = registration && draft
        ? await tx.query(`SELECT session_id FROM seat_holds WHERE event_employee_id = $1 AND modifies_registration_id = $2 ORDER BY created_at DESC LIMIT 1`, [ctx.employee.id, registration.id])
        : null;
      return {
        modificationSessionId: lastModification?.rows[0]?.session_id ?? null,
        agency: { name: ctx.agency.name },
        company: { name: ctx.event.companyName, logoUrl: publicCompanyLogo(ctx.agency.code, ctx.event.slug, ctx.event.companyLogoKey) },
        serviceContacts: (await tx.query(`SELECT name, phone, scope FROM event_service_contacts WHERE event_id = $1 ORDER BY sort_order`, [ctx.event.id])).rows,
        event: {
          slug: ctx.event.slug,
          name: ctx.event.name,
          themeColor: ctx.event.themeColor,
          itinerary: ctx.event.itinerary,
          registrationOpensAt: ctx.event.registrationOpensAt,
          registrationClosesAt: ctx.event.registrationClosesAt,
          allowDependentsOnly: ctx.event.allowDependentsOnly,
          termsVersion: ctx.event.termsVersion,
          hasTerms: ctx.event.hasTerms,
          paymentInstructions: ctx.event.paymentInstructions,
          images: publicImages(ctx.agency.code, ctx.event.slug, ctx.event.images),
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
      this.validateSelection(employeeRules(ctx), config, req.travelers);
      await this.assertNotRegistered(tx, ctx.employee.id);

      const needs = await this.seatNeeds(tx, config, req.sessionId, req.travelers);
      await this.lockSeats(tx, ctx.event.id, req.sessionId, [...needs.quotas.keys()], [...needs.rooms.keys()]);

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
      this.validateSelection(await this.modificationRules(tx, ctx), config, travelers);
      const current = await tx.query(
        `SELECT id, session_id, modifies_registration_id FROM seat_holds
          WHERE event_employee_id = $1 AND status = 'active' AND expires_at > now()`,
        [ctx.employee.id],
      );
      const hold = current.rows[0];
      if (!hold) throw new DomainError('HOLD_EXPIRED');

      const full = await this.seatNeeds(tx, config, hold.session_id, travelers);
      const delta = hold.modifies_registration_id ? await this.modificationDelta(tx, hold.modifies_registration_id, hold.session_id, travelers.length, full) : null;
      const needs = delta?.needs ?? full;
      const quantity = delta?.quantity ?? travelers.length;
      const existingItems = await tx.query(`SELECT quota_id FROM seat_hold_items WHERE hold_id = $1`, [hold.id]);
      const existingRooms = await tx.query(`SELECT room_type_id FROM seat_hold_room_items WHERE hold_id = $1`, [hold.id]);
      const quotaIds = new Set<string>([...needs.quotas.keys(), ...existingItems.rows.map((r) => r.quota_id as string)]);
      const roomIds = new Set<string>([...needs.rooms.keys(), ...existingRooms.rows.map((r) => r.room_type_id as string)]);
      await this.lockSeats(tx, ctx.event.id, hold.session_id, [...quotaIds], [...roomIds]);

      // 取得鎖之後再確認一次，避免等待期間已逾時或已送出
      const locked = await tx.query(
        `SELECT id FROM seat_holds WHERE id = $1 AND status = 'active' AND expires_at > now() FOR UPDATE`,
        [hold.id],
      );
      if (!locked.rowCount) throw new DomainError('HOLD_EXPIRED');

      await this.assertSeats(tx, hold.session_id, quantity, needs, hold.id);
      await tx.query(`UPDATE seat_holds SET quantity = $1 WHERE id = $2`, [quantity, hold.id]);
      await tx.query(`DELETE FROM seat_hold_items WHERE hold_id = $1`, [hold.id]);
      await tx.query(`DELETE FROM seat_hold_room_items WHERE hold_id = $1`, [hold.id]);
      await this.writeHoldItems(tx, ctx.agency.id, hold.id, needs);
      return this.loadActiveHold(tx, ctx.employee.id);
    });
  }

  async releaseHold(ctx: EmployeeContext) {
    await this.db.withTenant(ctx.agency.id, (tx) =>
      tx.query(
        `WITH released AS (
           UPDATE seat_holds SET status = 'released', closed_at = now() WHERE event_employee_id = $1 AND status = 'active'
         )
         -- 已經報名的人放棄修改時，改到一半的內容也不用留了；第一次報名的草稿要留著。
         DELETE FROM registration_drafts d WHERE d.event_employee_id = $1
           AND EXISTS (SELECT 1 FROM registrations r WHERE r.event_employee_id = $1 AND r.status <> 'cancelled')`,
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
    const registration = await this.createRegistration(ctx, req);
    if (registration) {
      void this.mailRegistered(ctx, registration);
      void this.notifications.checkTierUsage(ctx.agency.id, ctx.event.id);
    }
    return registration;
  }

  /** 寄信失敗不影響已完成的報名。 */
  private async mailRegistered(ctx: EmployeeContext, r: { sessionId: string; travelers: unknown[]; totalAmount: number; subsidyAmount: number; selfPayAmount: number }) {
    try {
      const { event, email, sessionName } = await this.db.withTenant(ctx.agency.id, async (tx) => {
        const emp = await tx.query(`SELECT email FROM event_employees WHERE id = $1`, [ctx.employee.id]);
        const session = await tx.query(`SELECT name FROM event_sessions WHERE id = $1`, [r.sessionId]);
        return { event: await this.notifications.mailEvent(tx, ctx.event.id), email: emp.rows[0]?.email as string | null, sessionName: session.rows[0]?.name as string };
      });
      if (!email) return;
      await this.notifications.deliver(ctx.agency.id, ctx.event.id, event, { id: ctx.employee.id, name: ctx.employee.name, email }, {
        key: 'registration_success', sessionName, travelers: r.travelers.length, total: r.totalAmount, subsidy: r.subsidyAmount, selfPay: r.selfPayAmount, paymentInstructions: ctx.event.paymentInstructions,
      });
    } catch (err) {
      this.logger.error(`報名成功通知失敗：${(err as Error).message}`);
    }
  }

  private async createRegistration(ctx: EmployeeContext, req: SubmitRequest) {
    this.assertOpen(ctx);
    return this.db.withTenant(ctx.agency.id, async (tx) => {
      const config = await this.loadConfig(tx, ctx.event.id);
      this.validateSelection(employeeRules(ctx), config, req.travelers);
      await this.assertNotRegistered(tx, ctx.employee.id);

      const current = await tx.query(
        `SELECT id, session_id FROM seat_holds
          WHERE event_employee_id = $1 AND status = 'active' AND expires_at > now() AND modifies_registration_id IS NULL`,
        [ctx.employee.id],
      );
      const found = current.rows[0];
      if (!found) throw new DomainError('HOLD_EXPIRED');

      const needs = await this.seatNeeds(tx, config, found.session_id, req.travelers);
      await this.lockSeats(tx, ctx.event.id, found.session_id, [...needs.quotas.keys()], [...needs.rooms.keys()]);

      const locked = await tx.query(
        `SELECT id, quantity, session_id FROM seat_holds WHERE id = $1 AND status = 'active' AND expires_at > now() FOR UPDATE`,
        [found.id],
      );
      const hold = locked.rows[0];
      if (!hold) throw new DomainError('HOLD_EXPIRED');

      const heldItems = await tx.query(`SELECT quota_id, quantity FROM seat_hold_items WHERE hold_id = $1`, [hold.id]);
      const heldRooms = await tx.query(`SELECT room_type_id, quantity FROM seat_hold_room_items WHERE hold_id = $1`, [hold.id]);
      const sameItems =
        heldItems.rowCount === needs.quotas.size && heldItems.rows.every((r) => needs.quotas.get(r.quota_id) === r.quantity) &&
        heldRooms.rowCount === needs.rooms.size && heldRooms.rows.every((r) => needs.rooms.get(r.room_type_id) === r.quantity);
      if (hold.quantity !== req.travelers.length || !sameItems) throw new DomainError('HOLD_MISMATCH');

      const previous = await this.readDraftPayload(tx, ctx.employee.id);
      const details = this.mergeSensitive(req, previous, config).travelers;
      this.validateDetails(config, details);

      const roomTypes = await this.sessionRoomTypes(tx, hold.session_id);
      const surcharge = (roomTypeId: string | null) => (roomTypeId ? roomTypes.get(roomTypeId)!.surcharge : 0);
      const fees = calculateFees(
        details.map((t) => ({
          basePrice: config.types.get(t.travelerTypeId)!.basePrice,
          roomSurcharge: surcharge(t.roomTypeId),
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
                                  field_values, sensitive_values_encrypted, sensitive_masks, requested_room_no, sort_order,
                                  session_room_type_id, room_surcharge_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
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
            t.roomTypeId,
            surcharge(t.roomTypeId),
          ],
        );
        for (const optionId of t.optionIds) {
          await tx.query(
            `INSERT INTO traveler_options (agency_id, traveler_id, option_id, price_snapshot) VALUES ($1, $2, $3, $4)`,
            [ctx.agency.id, inserted.rows[0].id, optionId, config.options.get(optionId)!.price],
          );
        }
        for (const [groupId, optionIds] of Object.entries(t.preferences)) {
          for (const [i, optionId] of optionIds.entries()) {
            await tx.query(
              `INSERT INTO traveler_option_preferences (agency_id, traveler_id, group_id, rank, option_id) VALUES ($1, $2, $3, $4, $5)`,
              [ctx.agency.id, inserted.rows[0].id, groupId, i + 2, optionId],
            );
          }
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
      for (const [quotaId, quantity] of needs.quotas) {
        await tx.query(`UPDATE option_quotas SET sold_count = sold_count + $1 WHERE id = $2`, [quantity, quotaId]);
      }
      for (const [roomId, quantity] of needs.rooms) {
        await tx.query(`UPDATE session_room_types SET sold_count = sold_count + $1 WHERE id = $2`, [quantity, roomId]);
      }
      await tx.query(
        `UPDATE seat_holds SET status = 'converted', registration_id = $1, closed_at = now() WHERE id = $2`,
        [registrationId, hold.id],
      );
      await tx.query(`DELETE FROM registration_drafts WHERE event_employee_id = $1`, [ctx.employee.id]);
      await tx.query(
        `INSERT INTO registration_revisions (agency_id, registration_id, revision_no, actor_type, actor_id, changed_fields, after_encrypted, summary)
         VALUES ($1, $2, 1, 'employee', $3, '{created}', $4, '{"action":"created"}')`,
        [ctx.agency.id, registrationId, ctx.employee.id, this.encryption.encryptJson(details)],
      );
      return this.loadRegistration(tx, ctx.employee.id, config);
    }).catch(rethrowUniqueViolation('registrations_one_active', 'ALREADY_REGISTERED'));
  }

  // ===== 修改報名 =====

  /** 只保留比原報名多出來的名額；減少的部分要等送出後才釋出。 */
  async createModificationHold(ctx: EmployeeContext, req: HoldRequest) {
    this.assertOpen(ctx);
    return this.db.withTenant(ctx.agency.id, async (tx) => {
      const config = await this.loadConfig(tx, ctx.event.id);
      this.validateSelection(await this.modificationRules(tx, ctx), config, req.travelers);
      const reg = await this.modifiableRegistration(tx, ctx.employee.id);

      const full = await this.seatNeeds(tx, config, req.sessionId, req.travelers);
      const { needs, quantity } = await this.modificationDelta(tx, reg.id, req.sessionId, req.travelers.length, full);
      await this.lockSeats(tx, ctx.event.id, req.sessionId, [...needs.quotas.keys()], [...needs.rooms.keys()]);

      await tx.query(
        `UPDATE seat_holds SET status = 'expired', closed_at = now() WHERE event_employee_id = $1 AND status = 'active' AND expires_at <= now()`,
        [ctx.employee.id],
      );
      // 修改中換梯次：換掉原本的保留但不重新計時；新梯次沒名額時整個交易還原，舊保留還在。
      const existing = await tx.query(
        `SELECT id, expires_at, modifies_registration_id FROM seat_holds WHERE event_employee_id = $1 AND status = 'active' FOR UPDATE`,
        [ctx.employee.id],
      );
      const replacing = existing.rows[0];
      if (replacing && !replacing.modifies_registration_id) throw new DomainError('HOLD_EXISTS');
      if (replacing) await tx.query(`UPDATE seat_holds SET status = 'released', closed_at = now() WHERE id = $1`, [replacing.id]);

      await this.assertSeats(tx, req.sessionId, quantity, needs);
      const { rows } = await tx.query(
        `INSERT INTO seat_holds (agency_id, event_id, event_employee_id, session_id, quantity, expires_at, modifies_registration_id)
         VALUES ($1, $2, $3, $4, $5, COALESCE($8, now() + make_interval(mins => $6)), $7) RETURNING id`,
        [ctx.agency.id, ctx.event.id, ctx.employee.id, req.sessionId, quantity, HOLD_MINUTES, reg.id, replacing?.expires_at ?? null],
      );
      await this.writeHoldItems(tx, ctx.agency.id, rows[0].id, needs);
      return this.loadActiveHold(tx, ctx.employee.id);
    }).catch(rethrowUniqueViolation('seat_holds_one_active', 'HOLD_EXISTS'));
  }

  /** 送出前原報名不變；倒數結束只讓這次修改失效。 */
  async submitModification(ctx: EmployeeContext, req: ModifyRequest) {
    this.assertOpen(ctx);
    let mail: { event: MailEvent; total: number; selfPay: number; from: number } | null = null;
    const result = await this.db.withTenant(ctx.agency.id, async (tx) => {
      const config = await this.loadConfig(tx, ctx.event.id);
      this.validateSelection(await this.modificationRules(tx, ctx), config, req.travelers);
      const current = await tx.query(
        `SELECT id, session_id, modifies_registration_id FROM seat_holds
          WHERE event_employee_id = $1 AND status = 'active' AND expires_at > now() AND modifies_registration_id IS NOT NULL`,
        [ctx.employee.id],
      );
      const found = current.rows[0];
      if (!found) throw new DomainError('HOLD_EXPIRED');

      const full = await this.seatNeeds(tx, config, found.session_id, req.travelers);
      const old = await this.oldSeats(tx, found.modifies_registration_id);
      await this.lockSeats(tx, ctx.event.id, [found.session_id, old.sessionId], [...new Set([...full.quotas.keys(), ...old.quotas.keys()])], [...new Set([...full.rooms.keys(), ...old.rooms.keys()])]);
      const locked = await tx.query(`SELECT id FROM seat_holds WHERE id = $1 AND status = 'active' AND expires_at > now() FOR UPDATE`, [found.id]);
      if (!locked.rowCount) throw new DomainError('HOLD_EXPIRED');

      // 保留之後原報名可能被旅行社改過，差額要和保留的一致才能送出。
      const { needs, quantity } = await this.modificationDelta(tx, found.modifies_registration_id, found.session_id, req.travelers.length, full);
      const heldQuantity = await tx.query(`SELECT quantity FROM seat_holds WHERE id = $1`, [found.id]);
      const heldItems = await tx.query(`SELECT quota_id, quantity FROM seat_hold_items WHERE hold_id = $1`, [found.id]);
      const heldRooms = await tx.query(`SELECT room_type_id, quantity FROM seat_hold_room_items WHERE hold_id = $1`, [found.id]);
      const same = heldQuantity.rows[0].quantity === quantity
        && heldItems.rowCount === needs.quotas.size && heldItems.rows.every((r) => needs.quotas.get(r.quota_id) === r.quantity)
        && heldRooms.rowCount === needs.rooms.size && heldRooms.rows.every((r) => needs.rooms.get(r.room_type_id) === r.quantity);
      if (!same) throw new DomainError('HOLD_MISMATCH');

      const previous = await this.readDraftPayload(tx, ctx.employee.id);
      const merged = this.mergeSensitive(req, previous, config);
      const r = await this.applyModification(tx, ctx.agency.id, found.modifies_registration_id, found.session_id, config, merged, full, { type: 'employee', id: ctx.employee.id });
      await tx.query(`UPDATE seat_holds SET status = 'converted', registration_id = $1, closed_at = now() WHERE id = $2`, [found.modifies_registration_id, found.id]);
      await tx.query(`DELETE FROM registration_drafts WHERE event_employee_id = $1`, [ctx.employee.id]);
      mail = { event: await this.notifications.mailEvent(tx, ctx.event.id), total: r.total, selfPay: r.selfPay, from: r.from };
      return this.loadRegistration(tx, ctx.employee.id, config);
    });
    void this.notifications.checkTierUsage(ctx.agency.id, ctx.event.id);
    if (mail && result) {
      const before: { event: MailEvent; total: number; selfPay: number; from?: number } = mail;
      void this.notifications.notifyAgency(ctx.agency.id, ctx.event.id, {
        key: 'agency_modified', employeeName: ctx.employee.name, employeeNo: ctx.employee.employeeNo, from: before.from ?? before.total, to: before.total, eventId: ctx.event.id, registrationId: result.id,
      });
    }
    const email = await this.employeeEmail(ctx.agency.id, ctx.employee.id);
    if (mail && email) {
      const m: { event: MailEvent; total: number; selfPay: number } = mail;
      void this.notifications.deliver(ctx.agency.id, ctx.event.id, m.event, { id: ctx.employee.id, name: ctx.employee.name, email }, { key: 'modified', byAgency: false, total: m.total, selfPay: m.selfPay });
    }
    return result;
  }

  /** 旅行社修改：截止後也可以，立即生效，不需要保留；不受員工的眷屬上限限制。 */
  async modifyByAgency(agencyId: string, eventId: string, registrationId: string, actorId: string, req: AgencyModifyRequest) {
    let mail: { event: MailEvent; total: number; selfPay: number; employee: { id: string; name: string; email: string | null } };
    await this.db.withTenant(agencyId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT r.id, r.status, r.event_employee_id, m.name, m.email, e.allow_dependents_only
           FROM registrations r JOIN event_employees m ON m.id = r.event_employee_id JOIN events e ON e.id = r.event_id
          WHERE r.id = $1 AND r.event_id = $2`,
        [registrationId, eventId],
      );
      const reg = rows[0];
      if (!reg) throw new DomainError('NOT_FOUND');
      if (reg.status === 'cancelled') throw new DomainError('NOT_MODIFIABLE');
      const config = await this.loadConfig(tx, eventId);
      this.validateSelection({ allowDependentsOnly: reg.allow_dependents_only, dependentLimit: null }, config, req.travelers);
      const session = await tx.query(`SELECT 1 FROM event_sessions WHERE id = $1 AND event_id = $2`, [req.sessionId, eventId]);
      if (!session.rowCount) throw new DomainError('INVALID_SELECTION', { reason: 'unknown_session' });

      const full = await this.seatNeeds(tx, config, req.sessionId, req.travelers);
      const old = await this.oldSeats(tx, registrationId);
      await this.lockSeats(tx, eventId, [req.sessionId, old.sessionId], [...new Set([...full.quotas.keys(), ...old.quotas.keys()])], [...new Set([...full.rooms.keys(), ...old.rooms.keys()])]);
      const { needs, quantity } = await this.modificationDelta(tx, registrationId, req.sessionId, req.travelers.length, full);
      await this.assertSeats(tx, req.sessionId, quantity, needs);
      const r = await this.applyModification(tx, agencyId, registrationId, req.sessionId, config, req, full, { type: 'agency_user', id: actorId });
      mail = { event: await this.notifications.mailEvent(tx, eventId), total: r.total, selfPay: r.selfPay, employee: { id: reg.event_employee_id, name: reg.name, email: reg.email } };
    });
    void this.notifications.checkTierUsage(agencyId, eventId);
    const m = mail!;
    if (m.employee.email) {
      void this.notifications.deliver(agencyId, eventId, m.event, { id: m.employee.id, name: m.employee.name, email: m.employee.email }, { key: 'modified', byAgency: true, total: m.total, selfPay: m.selfPay });
    }
  }

  /** 修改畫面需要的設定、各梯次剩餘名額與目前內容。 */
  editData(agencyId: string, eventId: string, registrationId: string) {
    return this.db.withTenant(agencyId, async (tx) => {
      const { rows } = await tx.query(`SELECT r.event_employee_id, r.status FROM registrations r WHERE r.id = $1 AND r.event_id = $2`, [registrationId, eventId]);
      if (!rows[0]) throw new DomainError('NOT_FOUND');
      const config = await this.loadConfig(tx, eventId);
      return {
        travelerTypes: [...config.types.values()],
        optionGroups: [...config.groups.values()].map((g) => ({ ...g, options: g.options.map((id) => config.options.get(id)!) })),
        fields: config.fields.map(({ id: _id, ...f }) => f),
        availability: await this.loadAvailability(tx, eventId),
        registration: await this.loadRegistration(tx, rows[0].event_employee_id, config, registrationId),
      };
    });
  }

  /** 旅行社可能幫員工加到超過上限；修改時不要求把人減回去，只是不能再多。 */
  private async modificationRules(tx: Tx, ctx: EmployeeContext): Promise<SelectionRules> {
    const { rows } = await tx.query(
      `SELECT count(*)::int AS n FROM travelers t JOIN registrations r ON r.id = t.registration_id
        WHERE r.event_employee_id = $1 AND r.status <> 'cancelled' AND NOT t.is_employee_self`,
      [ctx.employee.id],
    );
    return { ...employeeRules(ctx), dependentLimit: Math.max(ctx.employee.dependentLimit, rows[0].n) };
  }

  private async employeeEmail(agencyId: string, employeeId: string) {
    const { rows } = await this.db.withTenant(agencyId, (tx) => tx.query(`SELECT email FROM event_employees WHERE id = $1`, [employeeId]));
    return (rows[0]?.email ?? null) as string | null;
  }

  private async modifiableRegistration(tx: Tx, employeeId: string) {
    const { rows } = await tx.query(`SELECT id, status FROM registrations WHERE event_employee_id = $1 AND status <> 'cancelled' FOR UPDATE`, [employeeId]);
    if (!rows[0] || rows[0].status !== 'confirmed') throw new DomainError('NOT_MODIFIABLE');
    return rows[0] as { id: string; status: string };
  }

  /** 原報名佔用的名額。 */
  private async oldSeats(tx: Tx, registrationId: string) {
    const { rows } = await tx.query(`SELECT session_id FROM registrations WHERE id = $1`, [registrationId]);
    const sessionId: string = rows[0].session_id;
    const count = await tx.query(`SELECT count(*)::int AS n FROM travelers WHERE registration_id = $1`, [registrationId]);
    const quotas = await tx.query(
      `SELECT q.quota_id AS id, count(*)::int AS n FROM travelers t JOIN traveler_options o ON o.traveler_id = t.id
         JOIN option_quota_sessions q ON q.option_id = o.option_id AND q.session_id = $2
        WHERE t.registration_id = $1 GROUP BY q.quota_id`,
      [registrationId, sessionId],
    );
    const rooms = await tx.query(
      `SELECT session_room_type_id AS id, count(*)::int AS n FROM travelers WHERE registration_id = $1 AND session_room_type_id IS NOT NULL GROUP BY session_room_type_id`,
      [registrationId],
    );
    return {
      sessionId,
      travelers: count.rows[0].n as number,
      quotas: new Map<string, number>(quotas.rows.map((r) => [r.id, r.n])),
      rooms: new Map<string, number>(rooms.rows.map((r) => [r.id, r.n])),
    };
  }

  /** 新內容比原報名多佔的名額。換梯次時原梯次的名額不能抵用，共用的選項名額除外。 */
  private async modificationDelta(tx: Tx, registrationId: string, sessionId: string, travelers: number, full: SeatNeeds) {
    const old = await this.oldSeats(tx, registrationId);
    const positive = (next: Map<string, number>, prev: Map<string, number>) => new Map([...next].flatMap(([id, n]) => {
      const more = n - (prev.get(id) ?? 0);
      return more > 0 ? [[id, more] as [string, number]] : [];
    }));
    // 換梯次時梯次與房型名額要全部重新保留；選項名額若與原梯次共用同一組，原本佔用的可以抵用。
    if (old.sessionId !== sessionId) return { quantity: travelers, needs: { quotas: positive(full.quotas, old.quotas), rooms: full.rooms } };
    return {
      quantity: Math.max(travelers - old.travelers, 0),
      needs: { quotas: positive(full.quotas, old.quotas), rooms: positive(full.rooms, old.rooms) },
    };
  }

  /** 改動前後的內容（敏感欄位只有遮罩），加密存進修改紀錄。 */
  private async snapshot(tx: Tx, registrationId: string, config: EventConfig) {
    const { rows: reg } = await tx.query(
      `SELECT r.total_amount, s.name AS session_name FROM registrations r JOIN event_sessions s ON s.id = r.session_id WHERE r.id = $1`,
      [registrationId],
    );
    const { rows } = await tx.query(
      `SELECT t.id, t.name, t.traveler_type_id, t.base_price_snapshot, t.room_surcharge_snapshot, t.field_values, t.sensitive_masks, rt.name AS room_type,
              COALESCE((SELECT json_agg(json_build_object('optionId', o.option_id, 'price', o.price_snapshot)) FROM traveler_options o WHERE o.traveler_id = t.id), '[]') AS options,
              COALESCE((SELECT json_agg(p.option_id ORDER BY p.rank) FROM traveler_option_preferences p WHERE p.traveler_id = t.id), '[]') AS preferences
         FROM travelers t LEFT JOIN session_room_types rt ON rt.id = t.session_room_type_id
        WHERE t.registration_id = $1 ORDER BY t.sort_order`,
      [registrationId],
    );
    return {
      session: reg[0].session_name,
      total: reg[0].total_amount,
      travelers: rows.map((t) => ({
        id: t.id,
        name: t.name,
        type: config.types.get(t.traveler_type_id)?.name ?? '',
        basePrice: t.base_price_snapshot,
        roomType: t.room_type,
        roomSurcharge: t.room_surcharge_snapshot,
        fields: config.fields.flatMap((f) => {
          const v = t.sensitive_masks[f.key] ?? t.field_values[f.key];
          return v === undefined ? [] : [{ label: f.label, value: Array.isArray(v) ? v.join('、') : String(v) }];
        }),
        options: t.options.map((o: { optionId: string; price: number }) => ({ name: config.options.get(o.optionId)?.name ?? '', price: o.price })),
        preferences: t.preferences.map((id: string) => config.options.get(id)?.name ?? ''),
      })),
    };
  }

  /**
   * 沒改動的項目保留原本的價格快照，新選的項目用目前價格。
   * 曾手動調整過的差額會保留：新總額 = 舊總額 + 明細的增減。補助維持報名時的金額。
   * 呼叫前必須已取得新舊梯次、選項與房型的鎖。
   */
  private async applyModification(tx: Tx, agencyId: string, registrationId: string, sessionId: string, config: EventConfig, req: ModifyRequest, full: SeatNeeds, actor: { type: 'employee' | 'agency_user'; id: string }) {
    const { rows: regs } = await tx.query(`SELECT status, session_id, total_amount, subsidy_amount, payment_status FROM registrations WHERE id = $1 FOR UPDATE`, [registrationId]);
    const reg = regs[0];
    if (!reg || reg.status === 'cancelled' || (actor.type === 'employee' && reg.status !== 'confirmed')) throw new DomainError('NOT_MODIFIABLE');
    const old = await this.oldSeats(tx, registrationId);
    const before = await this.snapshot(tx, registrationId, config);

    const { rows: oldRows } = await tx.query(
      `SELECT t.id, t.traveler_type_id, t.base_price_snapshot, t.session_room_type_id, t.room_surcharge_snapshot, t.sensitive_values_encrypted, t.field_values,
              COALESCE((SELECT json_object_agg(o.option_id, o.price_snapshot) FROM traveler_options o WHERE o.traveler_id = t.id), '{}') AS option_prices
         FROM travelers t WHERE t.registration_id = $1`,
      [registrationId],
    );
    const oldById = new Map(oldRows.map((r) => [r.id as string, r]));
    const oldSum = oldRows.reduce((sum, r) => sum + r.base_price_snapshot + r.room_surcharge_snapshot + (Object.values(r.option_prices) as number[]).reduce((a, b) => a + b, 0), 0);

    const details = req.travelers.map((t) => {
      const existing = oldById.get(t.key);
      if (!existing?.sensitive_values_encrypted) return t;
      // 敏感欄位留空表示不變更。
      const saved = this.encryption.decryptJson<Record<string, unknown>>(existing.sensitive_values_encrypted);
      const fieldValues: typeof t.fieldValues = { ...t.fieldValues };
      for (const [k, v] of Object.entries(saved)) {
        const incoming = fieldValues[k];
        if (incoming === undefined || incoming === null || incoming === '') fieldValues[k] = v as never;
      }
      return { ...t, fieldValues };
    });
    this.validateDetails(config, details);

    const roomTypes = await this.sessionRoomTypes(tx, sessionId);
    const keep = details.map((t) => t.key).filter((k) => oldById.has(k));
    await tx.query(`DELETE FROM travelers WHERE registration_id = $1 AND NOT (id = ANY($2::uuid[]))`, [registrationId, keep]);

    let newSum = 0;
    for (const [index, t] of details.entries()) {
      const existing = oldById.get(t.key);
      const type = config.types.get(t.travelerTypeId)!;
      const basePrice = existing && existing.traveler_type_id === t.travelerTypeId ? existing.base_price_snapshot as number : type.basePrice;
      const surcharge = !t.roomTypeId ? 0 : existing && existing.session_room_type_id === t.roomTypeId ? existing.room_surcharge_snapshot as number : roomTypes.get(t.roomTypeId)!.surcharge;
      const { plain, sensitive, masks } = this.splitFields(config, t.fieldValues);
      const encrypted = Object.keys(sensitive).length ? this.encryption.encryptJson(sensitive) : null;
      let travelerId: string = t.key;
      if (existing) {
        await tx.query(
          `UPDATE travelers SET traveler_type_id = $2, is_employee_self = $3, name = $4, base_price_snapshot = $5, field_values = $6, sensitive_values_encrypted = $7, sensitive_masks = $8,
                  requested_room_no = $9, sort_order = $10, session_room_type_id = $11, room_surcharge_snapshot = $12 WHERE id = $1`,
          [t.key, type.id, type.isEmployeeSelf, t.name, basePrice, JSON.stringify(plain), encrypted, JSON.stringify(masks), t.requestedRoomNo, index, t.roomTypeId, surcharge],
        );
      } else {
        const inserted = await tx.query(
          `INSERT INTO travelers (agency_id, registration_id, traveler_type_id, is_employee_self, name, base_price_snapshot, field_values, sensitive_values_encrypted, sensitive_masks,
                                  requested_room_no, sort_order, session_room_type_id, room_surcharge_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
          [agencyId, registrationId, type.id, type.isEmployeeSelf, t.name, basePrice, JSON.stringify(plain), encrypted, JSON.stringify(masks), t.requestedRoomNo, index, t.roomTypeId, surcharge],
        );
        travelerId = inserted.rows[0].id;
      }
      const prices: Record<string, number> = existing?.option_prices ?? {};
      await tx.query(`DELETE FROM traveler_options WHERE traveler_id = $1`, [travelerId]);
      await tx.query(`DELETE FROM traveler_option_preferences WHERE traveler_id = $1`, [travelerId]);
      newSum += basePrice + surcharge;
      for (const optionId of t.optionIds) {
        const price = prices[optionId] ?? config.options.get(optionId)!.price;
        newSum += price;
        await tx.query(`INSERT INTO traveler_options (agency_id, traveler_id, option_id, price_snapshot) VALUES ($1, $2, $3, $4)`, [agencyId, travelerId, optionId, price]);
      }
      for (const [groupId, optionIds] of Object.entries(t.preferences)) {
        for (const [i, optionId] of optionIds.entries()) {
          await tx.query(`INSERT INTO traveler_option_preferences (agency_id, traveler_id, group_id, rank, option_id) VALUES ($1, $2, $3, $4, $5)`, [agencyId, travelerId, groupId, i + 2, optionId]);
        }
      }
    }

    await tx.query(`DELETE FROM room_preferences WHERE registration_id = $1`, [registrationId]);
    for (const p of req.roomPreferences) {
      await tx.query(`INSERT INTO room_preferences (agency_id, registration_id, requested_room_no, preferred_coworker_name, note) VALUES ($1, $2, $3, $4, $5)`, [agencyId, registrationId, p.requestedRoomNo, p.preferredCoworkerName, p.note]);
    }
    // 換梯次後原本的分房不再適用。
    if (old.sessionId !== sessionId) {
      await tx.query(`DELETE FROM room_assignments WHERE traveler_id IN (SELECT id FROM travelers WHERE registration_id = $1)`, [registrationId]);
    }

    // 先釋出再佔用，同一個計數才不會暫時超過上限。
    await tx.query(`UPDATE event_sessions SET sold_count = sold_count - $1 WHERE id = $2`, [old.travelers, old.sessionId]);
    for (const [id, n] of old.quotas) await tx.query(`UPDATE option_quotas SET sold_count = sold_count - $1 WHERE id = $2`, [n, id]);
    for (const [id, n] of old.rooms) await tx.query(`UPDATE session_room_types SET sold_count = sold_count - $1 WHERE id = $2`, [n, id]);
    await tx.query(`UPDATE event_sessions SET sold_count = sold_count + $1 WHERE id = $2`, [details.length, sessionId]);
    for (const [id, n] of full.quotas) await tx.query(`UPDATE option_quotas SET sold_count = sold_count + $1 WHERE id = $2`, [n, id]);
    for (const [id, n] of full.rooms) await tx.query(`UPDATE session_room_types SET sold_count = sold_count + $1 WHERE id = $2`, [n, id]);

    const total = Math.max(reg.total_amount + newSum - oldSum, 0);
    const selfPay = Math.max(total - reg.subsidy_amount, 0);
    await tx.query(
      `UPDATE registrations SET session_id = $2, total_amount = $3, payment_status = $4, updated_at = now() WHERE id = $1`,
      [registrationId, sessionId, total, paymentAfter(reg.payment_status, selfPay)],
    );
    const after = await this.snapshot(tx, registrationId, config);
    await addRevision(tx, agencyId, registrationId, actor, { action: 'modified', from: reg.total_amount, to: total }, { before: this.encryption.encryptJson(before), after: this.encryption.encryptJson(after) });
    return { total, selfPay, from: reg.total_amount as number };
  }

  // ===== 取消 =====

  async requestCancel(ctx: EmployeeContext) {
    const r = await this.markCancelRequested(ctx);
    if (r) {
      const sessionName = await this.db.withTenant(ctx.agency.id, async (tx) => (await tx.query(`SELECT name FROM event_sessions WHERE id = $1`, [r.sessionId])).rows[0]?.name as string);
      void this.notifications.notifyAgency(ctx.agency.id, ctx.event.id, {
        key: 'agency_cancel_requested', employeeName: ctx.employee.name, employeeNo: ctx.employee.employeeNo, sessionName, eventId: ctx.event.id, registrationId: r.id,
      });
    }
    return r;
  }

  private markCancelRequested(ctx: EmployeeContext) {
    return this.db.withTenant(ctx.agency.id, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE registrations SET status = 'cancel_requested', cancel_requested_at = now(), updated_at = now()
          WHERE event_employee_id = $1 AND status = 'confirmed' RETURNING id`,
        [ctx.employee.id],
      );
      if (!rows[0]) throw new DomainError('NOT_CANCELLABLE');
      await addRevision(tx, ctx.agency.id, rows[0].id, { type: 'employee', id: ctx.employee.id }, { action: 'cancel_requested' });
      const config = await this.loadConfig(tx, ctx.event.id);
      return this.loadRegistration(tx, ctx.employee.id, config);
    });
  }

  /** 旅行社確認取消後才生效並釋出名額。 */
  async confirmCancel(agencyId: string, registrationId: string, actorId: string | null) {
    await this.db.withTenant(agencyId, async (tx) => {
      const found = await tx.query(`SELECT id, event_id, session_id FROM registrations WHERE id = $1`, [registrationId]);
      const reg = found.rows[0];
      if (!reg) throw new DomainError('NOT_FOUND');

      const { rows: quotaRows } = await tx.query(
        `SELECT q.quota_id AS id, count(*)::int AS quantity
           FROM travelers t
           JOIN traveler_options o ON o.traveler_id = t.id
           JOIN option_quota_sessions q ON q.option_id = o.option_id AND q.session_id = $2
          WHERE t.registration_id = $1
          GROUP BY q.quota_id`,
        [registrationId, reg.session_id],
      );
      const { rows: roomRows } = await tx.query(
        `SELECT session_room_type_id AS id, count(*)::int AS quantity FROM travelers
          WHERE registration_id = $1 AND session_room_type_id IS NOT NULL GROUP BY session_room_type_id`,
        [registrationId],
      );
      await this.lockSeats(tx, reg.event_id, reg.session_id, quotaRows.map((r) => r.id), roomRows.map((r) => r.id));

      const updated = await tx.query(
        `UPDATE registrations SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, updated_at = now()
          WHERE id = $1 AND status = 'cancel_requested'`,
        [registrationId, actorId],
      );
      if (!updated.rowCount) throw new DomainError('NOT_CANCELLABLE');
      await addRevision(tx, agencyId, registrationId, { type: 'agency_user', id: actorId }, { action: 'cancel_confirmed' });
      // 已取消的旅客不再佔房間；分房頁會顯示有異動，需要重新公布。
      await tx.query(`DELETE FROM room_assignments WHERE traveler_id IN (SELECT id FROM travelers WHERE registration_id = $1)`, [registrationId]);

      const count = await tx.query(`SELECT count(*)::int AS n FROM travelers WHERE registration_id = $1`, [registrationId]);
      await tx.query(`UPDATE event_sessions SET sold_count = sold_count - $1 WHERE id = $2`, [
        count.rows[0].n,
        reg.session_id,
      ]);
      for (const q of quotaRows) {
        await tx.query(`UPDATE option_quotas SET sold_count = sold_count - $1 WHERE id = $2`, [q.quantity, q.id]);
      }
      for (const r of roomRows) {
        await tx.query(`UPDATE session_room_types SET sold_count = sold_count - $1 WHERE id = $2`, [r.quantity, r.id]);
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

  private validateSelection(rules: SelectionRules, config: EventConfig, travelers: Selection) {
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
      for (const [groupId, optionIds] of Object.entries(t.preferences)) {
        if (optionIds.length === 0) continue;
        const group = config.groups.get(groupId);
        const first = group?.options.find((id) => t.optionIds.includes(id));
        // 要先選第一志願；第二、第三志願可以是已額滿的選項，所以這裡不檢查名額。
        if (!group || !first || optionIds.length > group.preferenceCount - 1 || new Set([first, ...optionIds]).size !== optionIds.length + 1
          || optionIds.some((id) => !group.options.includes(id))) {
          throw new DomainError('INVALID_SELECTION', { reason: 'option_preferences', groupId });
        }
      }
    }

    if (selfCount > 1) throw new DomainError('INVALID_SELECTION', { reason: 'multiple_self' });
    if (selfCount === 0 && !rules.allowDependentsOnly) {
      throw new DomainError('INVALID_SELECTION', { reason: 'self_required' });
    }
    if (rules.dependentLimit !== null && travelers.length - selfCount > rules.dependentLimit) {
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

  private async sessionRoomTypes(tx: Tx, sessionId: string): Promise<Map<string, RoomType>> {
    const { rows } = await tx.query(`SELECT id, surcharge FROM session_room_types WHERE session_id = $1`, [sessionId]);
    return new Map(rows.map((r) => [r.id, { id: r.id, surcharge: r.surcharge }]));
  }

  /** 沒有名額設定的選項不限量。梯次有房型時，佔床的旅客都要選，不佔床的旅客不能選。 */
  private async seatNeeds(tx: Tx, config: EventConfig, sessionId: string, travelers: Selection): Promise<SeatNeeds> {
    const session = await tx.query(`SELECT 1 FROM event_sessions WHERE id = $1`, [sessionId]);
    if (!session.rowCount) throw new DomainError('INVALID_SELECTION', { reason: 'unknown_session' });

    const roomTypes = await this.sessionRoomTypes(tx, sessionId);
    const rooms = new Map<string, number>();
    for (const t of travelers) {
      const occupiesBed = config.types.get(t.travelerTypeId)!.occupiesBed;
      if (t.roomTypeId === null) {
        if (occupiesBed && roomTypes.size > 0) throw new DomainError('INVALID_SELECTION', { reason: 'room_type_required', key: t.key });
        continue;
      }
      if (!occupiesBed || !roomTypes.has(t.roomTypeId)) throw new DomainError('INVALID_SELECTION', { reason: 'invalid_room_type', key: t.key });
      rooms.set(t.roomTypeId, (rooms.get(t.roomTypeId) ?? 0) + 1);
    }

    const optionIds = travelers.flatMap((t) => t.optionIds);
    const quotas = new Map<string, number>();
    if (optionIds.length) {
      const { rows } = await tx.query(
        `SELECT quota_id AS id, option_id FROM option_quota_sessions WHERE session_id = $1 AND option_id = ANY($2::uuid[])`,
        [sessionId, optionIds],
      );
      const quotaByOption = new Map<string, string>(rows.map((r) => [r.option_id, r.id]));
      for (const optionId of optionIds) {
        const quotaId = quotaByOption.get(optionId);
        if (quotaId) quotas.set(quotaId, (quotas.get(quotaId) ?? 0) + 1);
      }
    }
    return { quotas, rooms };
  }

  /** 固定鎖定順序：先梯次，再依 ID 排序的選項名額與房型，避免死結。 */
  private async lockSeats(tx: Tx, eventId: string, sessionId: string | string[], quotaIds: string[], roomIds: string[] = []) {
    for (const id of [...new Set([sessionId].flat())].sort()) {
      const session = await tx.query(`SELECT id FROM event_sessions WHERE id = $1 AND event_id = $2 FOR UPDATE`, [id, eventId]);
      if (!session.rowCount) throw new DomainError('INVALID_SELECTION', { reason: 'unknown_session' });
    }
    for (const id of [...quotaIds].sort()) {
      // 旅行社剛好調整了名額組時，先前查到的名額組可能已不存在，請員工重新操作。
      const quota = await tx.query(`SELECT id FROM option_quotas WHERE id = $1 FOR UPDATE`, [id]);
      if (!quota.rowCount) throw new DomainError('HOLD_MISMATCH', { reason: 'quota_changed' });
    }
    for (const id of [...roomIds].sort()) {
      await tx.query(`SELECT id FROM session_room_types WHERE id = $1 FOR UPDATE`, [id]);
    }
  }

  /** 呼叫前必須已取得 lockSeats 的鎖。excludeHoldId 用於修改自己的保留。 */
  private async assertSeats(tx: Tx, sessionId: string, quantity: number, needs: SeatNeeds, excludeHoldId?: string) {
    const exclude = excludeHoldId ?? '00000000-0000-0000-0000-000000000000';
    const s = await tx.query(
      `SELECT s.capacity, s.sold_count,
              COALESCE((SELECT sum(h.quantity) FROM seat_holds h
                         WHERE h.session_id = s.id AND h.status = 'active' AND h.expires_at > now() AND h.id <> $2), 0)::int AS held
         FROM event_sessions s WHERE s.id = $1`,
      [sessionId, exclude],
    );
    const seat = s.rows[0];
    if (quantity > 0 && seat.sold_count + seat.held + quantity > seat.capacity) {
      throw new DomainError('SESSION_FULL', {
        status: seatStatus(seat.capacity, seat.sold_count, seat.held),
        remaining: Math.max(seat.capacity - seat.sold_count - seat.held, 0),
      });
    }
    for (const [quotaId, need] of needs.quotas) {
      const q = await tx.query(
        `SELECT q.option_id, q.capacity, q.sold_count,
                COALESCE((SELECT sum(i.quantity) FROM seat_hold_items i JOIN seat_holds h ON h.id = i.hold_id
                           WHERE i.quota_id = q.id AND h.status = 'active' AND h.expires_at > now() AND h.id <> $2), 0)::int AS held
           FROM option_quotas q WHERE q.id = $1`,
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
    for (const [roomId, need] of needs.rooms) {
      const r = await tx.query(
        `SELECT r.bed_quota, r.sold_count,
                COALESCE((SELECT sum(i.quantity) FROM seat_hold_room_items i JOIN seat_holds h ON h.id = i.hold_id
                           WHERE i.room_type_id = r.id AND h.status = 'active' AND h.expires_at > now() AND h.id <> $2), 0)::int AS held
           FROM session_room_types r WHERE r.id = $1`,
        [roomId, exclude],
      );
      const room = r.rows[0];
      if (room.sold_count + room.held + need > room.bed_quota) {
        throw new DomainError('ROOM_FULL', {
          roomTypeId: roomId,
          status: seatStatus(room.bed_quota, room.sold_count, room.held),
          remaining: Math.max(room.bed_quota - room.sold_count - room.held, 0),
        });
      }
    }
  }

  private async writeHoldItems(tx: Tx, agencyId: string, holdId: string, needs: SeatNeeds) {
    for (const [roomId, quantity] of needs.rooms) {
      await tx.query(`INSERT INTO seat_hold_room_items (agency_id, hold_id, room_type_id, quantity) VALUES ($1, $2, $3, $4)`, [agencyId, holdId, roomId, quantity]);
    }
    for (const [quotaId, quantity] of needs.quotas) {
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
      `SELECT id, name, base_price, is_employee_self, note, occupies_bed FROM traveler_types WHERE event_id = $1 ORDER BY sort_order, name`,
      [eventId],
    );
    const groups = await tx.query(
      `SELECT id, name, is_required, min_select, max_select, preference_count, activity_date FROM option_groups WHERE event_id = $1 ORDER BY sort_order, name`,
      [eventId],
    );
    const options = await tx.query(
      `SELECT o.id, o.group_id, o.name, o.price, o.pdf_object_key IS NOT NULL AS has_pdf FROM options o JOIN option_groups g ON g.id = o.group_id
        WHERE g.event_id = $1 ORDER BY o.sort_order, o.name`,
      [eventId],
    );
    const fields = await tx.query(
      `SELECT id, field_key, label, field_type, choices, is_required, is_sensitive FROM event_fields WHERE event_id = $1 ORDER BY sort_order, label`,
      [eventId],
    );
    const config: EventConfig = {
      types: new Map(
        types.rows.map((r) => [r.id, { id: r.id, name: r.name, basePrice: r.base_price, isEmployeeSelf: r.is_employee_self, note: r.note, occupiesBed: r.occupies_bed }]),
      ),
      groups: new Map(
        groups.rows.map((r) => [
          r.id,
          { id: r.id, name: r.name, isRequired: r.is_required, minSelect: r.min_select, maxSelect: r.max_select, preferenceCount: r.preference_count, activityDate: r.activity_date, options: [] as string[] },
        ]),
      ),
      options: new Map(options.rows.map((r) => [r.id, { id: r.id, groupId: r.group_id, name: r.name, price: r.price, hasPdf: r.has_pdf }])),
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
      `SELECT s.id, s.name, s.departs_on, s.returns_on, s.capacity, s.sold_count, s.itinerary_days,
              s.outbound_flight_no, s.return_flight_no,
              to_char(s.departure_time, 'HH24:MI') AS departure_time,
              to_char(s.return_arrival_time, 'HH24:MI') AS return_arrival_time,
              COALESCE((SELECT sum(h.quantity) FROM seat_holds h
                         WHERE h.session_id = s.id AND h.status = 'active' AND h.expires_at > now()), 0)::int AS held
         FROM event_sessions s WHERE s.event_id = $1 ORDER BY s.sort_order, s.departs_on, s.name`,
      [eventId],
    );
    // 共用名額在每個適用的梯次各出現一次，剩餘數相同。
    const quotas = await tx.query(
      `SELECT qs.session_id, q.option_id, q.capacity, q.sold_count,
              (SELECT count(*) FROM option_quota_sessions x WHERE x.quota_id = q.id) > 1 AS shared,
              COALESCE((SELECT sum(i.quantity) FROM seat_hold_items i JOIN seat_holds h ON h.id = i.hold_id
                         WHERE i.quota_id = q.id AND h.status = 'active' AND h.expires_at > now()), 0)::int AS held
         FROM option_quotas q JOIN option_quota_sessions qs ON qs.quota_id = q.id
         JOIN event_sessions s ON s.id = qs.session_id WHERE s.event_id = $1`,
      [eventId],
    );
    const rooms = await tx.query(
      `SELECT r.id, r.session_id, r.name, r.capacity, r.surcharge, r.bed_quota, r.sold_count,
              COALESCE((SELECT sum(i.quantity) FROM seat_hold_room_items i JOIN seat_holds h ON h.id = i.hold_id
                         WHERE i.room_type_id = r.id AND h.status = 'active' AND h.expires_at > now()), 0)::int AS held
         FROM session_room_types r JOIN event_sessions s ON s.id = r.session_id WHERE s.event_id = $1 ORDER BY r.sort_order, r.name`,
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
      /** 梯次另外設定的每日行程；null 表示沿用活動預設。 */
      itineraryDays: s.itinerary_days as { title: string; description: string }[] | null,
      remaining: Math.max(s.capacity - s.sold_count - s.held, 0),
      status: seatStatus(s.capacity, s.sold_count, s.held),
      roomTypes: rooms.rows
        .filter((r) => r.session_id === s.id)
        .map((r) => ({
          id: r.id,
          name: r.name,
          capacity: r.capacity,
          surcharge: r.surcharge,
          remaining: Math.max(r.bed_quota - r.sold_count - r.held, 0),
          status: seatStatus(r.bed_quota, r.sold_count, r.held),
        })),
      options: quotas.rows
        .filter((q) => q.session_id === s.id)
        .map((q) => ({
          optionId: q.option_id,
          remaining: Math.max(q.capacity - q.sold_count - q.held, 0),
          status: seatStatus(q.capacity, q.sold_count, q.held),
          shared: q.shared,
        })),
    }));
  }

  private async loadActiveHold(tx: Tx, employeeId: string) {
    const { rows } = await tx.query(
      `SELECT id, session_id, quantity, expires_at, modifies_registration_id FROM seat_holds
        WHERE event_employee_id = $1 AND status = 'active' AND expires_at > now()`,
      [employeeId],
    );
    const h = rows[0];
    return h ? { id: h.id, sessionId: h.session_id, quantity: h.quantity, expiresAt: h.expires_at, modifying: h.modifies_registration_id !== null } : null;
  }

  /** 已送出的報名：敏感欄位只回傳遮罩內容。 */
  private async loadRegistration(tx: Tx, employeeId: string, config: EventConfig, registrationId?: string) {
    const { rows } = await tx.query(
      `SELECT r.id, r.session_id, r.status, r.total_amount, r.subsidy_amount, r.self_pay_amount, r.payment_status, r.submitted_at,
              COALESCE((SELECT json_agg(json_build_object('requestedRoomNo', p.requested_room_no, 'preferredCoworkerName', p.preferred_coworker_name, 'note', p.note))
                          FROM room_preferences p WHERE p.registration_id = r.id), '[]') AS room_preferences
         FROM registrations r WHERE r.event_employee_id = $1 AND ${registrationId ? 'r.id = $2' : `r.status <> 'cancelled'`}`,
      registrationId ? [employeeId, registrationId] : [employeeId],
    );
    const r = rows[0];
    if (!r) return null;
    // 員工只看得到公布的結果；公布後的調整要等重新公布。
    const published = await tx.query(`SELECT snapshot, published_at FROM room_publications WHERE session_id = $1`, [r.session_id]);
    const travelers = await tx.query(
      `SELECT t.id, t.name, t.traveler_type_id, t.base_price_snapshot, t.field_values, t.sensitive_masks, t.requested_room_no,
              t.room_surcharge_snapshot, t.session_room_type_id, rt.name AS room_type_name,
              COALESCE((SELECT json_agg(json_build_object('groupId', p.group_id, 'rank', p.rank, 'optionId', p.option_id) ORDER BY p.rank)
                          FROM traveler_option_preferences p WHERE p.traveler_id = t.id), '[]') AS preferences,
              COALESCE((SELECT json_agg(json_build_object('optionId', o.option_id, 'price', o.price_snapshot))
                          FROM traveler_options o WHERE o.traveler_id = t.id), '[]') AS options
         FROM travelers t LEFT JOIN session_room_types rt ON rt.id = t.session_room_type_id
        WHERE t.registration_id = $1 ORDER BY t.sort_order`,
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
      roomPreferences: r.room_preferences,
      finalRooms: published.rows[0]
        ? (published.rows[0].snapshot.rooms as { label: string; typeName: string | null; travelers: { id: string; name: string }[] }[])
          .filter((room) => room.travelers.some((x) => travelers.rows.some((t) => t.id === x.id)))
          .map((room) => ({ label: room.label, typeName: room.typeName, names: room.travelers.map((x) => x.name) }))
        : null,
      travelers: travelers.rows.map((t) => ({
        id: t.id,
        travelerTypeId: t.traveler_type_id,
        roomTypeId: t.session_room_type_id,
        plainValues: t.field_values,
        masks: t.sensitive_masks,
        preferenceIds: t.preferences.reduce((acc: Record<string, string[]>, p: { groupId: string; optionId: string }) => ({ ...acc, [p.groupId]: [...(acc[p.groupId] ?? []), p.optionId] }), {}),
        name: t.name,
        travelerTypeName: config.types.get(t.traveler_type_id)?.name ?? '',
        basePrice: t.base_price_snapshot,
        fieldValues: { ...t.field_values, ...t.sensitive_masks },
        requestedRoomNo: t.requested_room_no,
        roomType: t.room_type_name ? { name: t.room_type_name, surcharge: t.room_surcharge_snapshot } : null,
        preferences: t.preferences.map((p: { groupId: string; rank: number; optionId: string }) => ({
          rank: p.rank,
          groupName: config.groups.get(p.groupId)?.name ?? '',
          optionName: config.options.get(p.optionId)?.name ?? '',
        })),
        options: t.options.map((o: { optionId: string; price: number }) => ({
          optionId: o.optionId,
          name: config.options.get(o.optionId)?.name ?? '',
          hasPdf: config.options.get(o.optionId)?.hasPdf ?? false,
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
