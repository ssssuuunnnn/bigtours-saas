import { Inject, Injectable } from '@nestjs/common';
import { can, pageState, type AgencyPermission, type ContactsInput, type EventBasicInput, type EventNavKey, type EventScheduleInput, type FieldInput, type OptionGroupInput, type OptionInput, type PaymentTermsInput, type PricingInput, type SessionInput } from '@bigtours/shared';
import { generateToken, hashPassword, verifyPassword } from '@bigtours/shared/crypto';
import { randomBytes } from 'node:crypto';
import { AccessService } from './access.service.ts';
import { DatabaseService, type Tx } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { DomainError } from './errors.ts';
import { agencyImages, imageContentType, imageExtension, isImageKind, StorageService, type ImageKind } from './storage.service.ts';

const SESSION_HOURS = 12;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const DUMMY_HASH = hashPassword('not-a-real-password-0');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AgencyUserContext {
  agencyId: string;
  agencyName: string;
  user: { id: string; name: string; role: string; pinnedNavItems: string[] };
}

const sessionRow = (r: any) => ({
  id: r.id,
  name: r.name,
  departsOn: r.departs_on,
  returnsOn: r.returns_on,
  departureTime: r.departure_time,
  returnArrivalTime: r.return_arrival_time,
  outboundFlightNo: r.outbound_flight_no,
  returnFlightNo: r.return_flight_no,
  capacity: r.capacity,
  soldCount: r.sold_count,
});
const SESSION_COLUMNS = `id, name, departs_on, returns_on, to_char(departure_time, 'HH24:MI') AS departure_time,
  to_char(return_arrival_time, 'HH24:MI') AS return_arrival_time, outbound_flight_no, return_flight_no, capacity, sold_count`;

const roomTypeRow = (r: any) => ({
  id: r.id,
  name: r.name,
  capacity: r.capacity,
  surcharge: r.surcharge,
  bedQuota: r.bed_quota,
  soldCount: r.sold_count,
});
const travelerTypeRow = (r: any) => ({
  id: r.id,
  name: r.name,
  basePrice: r.base_price,
  note: r.note,
  occupiesBed: r.occupies_bed,
  isEmployeeSelf: r.is_employee_self,
});

const fieldRow = (r: any) => ({
  id: r.id,
  label: r.label,
  type: r.field_type,
  choices: r.choices,
  isRequired: r.is_required,
  isSensitive: r.is_sensitive,
});
const FIELD_COLUMNS = 'id, label, field_type, choices, is_required, is_sensitive';

type NewEventInput = { companyId: string; name: string; slug: string; pricingTierId: string };

const IMAGE_COLUMN: Record<ImageKind, string> = { login: 'hero_object_key', 'login-mobile': 'login_mobile_object_key', home: 'home_image_object_key' };

@Injectable()
export class AgencyAdminService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  // ===== 登入 =====

  async login(host: string | undefined, email: string, password: string) {
    const agency = await this.access.findAgency(host);
    const user = await this.db.withTenant(agency.id, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, password_hash, locked_until > now() AS locked FROM agency_users WHERE email = $1 AND status = 'active'`,
        [email],
      );
      return rows[0] as { id: string; password_hash: string | null; locked: boolean | null } | undefined;
    });
    const matched = await verifyPassword(password, user?.password_hash ?? (await DUMMY_HASH));
    if (!user?.password_hash || user.locked) throw new DomainError('INVALID_CREDENTIALS');
    if (!matched) {
      await this.db.withTenant(agency.id, (tx) =>
        tx.query(
          `UPDATE agency_users
              SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
                  locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
            WHERE id = $1`,
          [user.id, MAX_FAILED_LOGINS, LOCK_MINUTES],
        ),
      );
      throw new DomainError('INVALID_CREDENTIALS');
    }
    const token = generateToken();
    await this.db.withTenant(agency.id, async (tx) => {
      await tx.query(`UPDATE agency_users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [user.id]);
      await tx.query(`DELETE FROM agency_user_sessions WHERE agency_user_id = $1 AND expires_at <= now()`, [user.id]);
      await tx.query(
        `INSERT INTO agency_user_sessions (agency_id, agency_user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
        [agency.id, user.id, this.encryption.hashToken(token), SESSION_HOURS],
      );
    });
    return { token, maxAgeMs: SESSION_HOURS * 3_600_000 };
  }

  async logout(host: string | undefined, token: string | undefined) {
    if (!token) return;
    const agency = await this.access.findAgency(host);
    await this.db.withTenant(agency.id, (tx) =>
      tx.query(`UPDATE agency_user_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [
        this.encryption.hashToken(token),
      ]),
    );
  }

  async resolve(host: string | undefined, token: string | undefined): Promise<AgencyUserContext> {
    const agency = await this.access.findAgency(host);
    if (!token) throw new DomainError('UNAUTHENTICATED');
    const user = await this.db.withTenant(agency.id, async (tx) => {
      const { rows } = await tx.query(
        `SELECT u.id, u.name, u.role, u.pinned_nav_items FROM agency_user_sessions s JOIN agency_users u ON u.id = s.agency_user_id
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
        [this.encryption.hashToken(token)],
      );
      return rows[0];
    });
    if (!user) throw new DomainError('UNAUTHENTICATED');
    return { agencyId: agency.id, agencyName: agency.name, user: { id: user.id, name: user.name, role: user.role, pinnedNavItems: user.pinned_nav_items } };
  }

  assertCan(ctx: AgencyUserContext, permission: AgencyPermission) {
    if (!can(ctx.user.role, permission)) throw new DomainError('FORBIDDEN');
  }

  setPinnedNav(ctx: AgencyUserContext, items: EventNavKey[]) {
    return this.db.withTenant(ctx.agencyId, (tx) =>
      tx.query(`UPDATE agency_users SET pinned_nav_items = $2 WHERE id = $1`, [ctx.user.id, items]),
    );
  }

  // ===== 活動 =====

  listEvents(ctx: AgencyUserContext) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT e.id, e.slug, e.name, e.status, e.registration_opens_at, e.registration_closes_at, c.name AS company_name, t.max_travelers,
                (SELECT count(*)::int FROM travelers tr JOIN registrations r ON r.id = tr.registration_id
                  WHERE r.event_id = e.id AND r.status <> 'cancelled') AS traveler_count
           FROM events e JOIN companies c ON c.id = e.company_id JOIN pricing_tiers t ON t.id = e.pricing_tier_id
          WHERE e.status <> 'archived' ORDER BY e.created_at DESC`,
      );
      return rows.map((r) => ({
        id: r.id, slug: r.slug, name: r.name, status: r.status, companyName: r.company_name,
        registrationOpensAt: r.registration_opens_at, registrationClosesAt: r.registration_closes_at,
        tierMax: r.max_travelers, travelerCount: r.traveler_count,
      }));
    });
  }

  getEvent(ctx: AgencyUserContext, eventId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const event = await this.lockEvent(tx, eventId, false);
      const { rows } = await tx.query(
        `SELECT e.status, e.itinerary, e.theme_color, e.support_phone, e.support_hours, e.page_mode, e.page_is_open, e.page_opens_at, e.page_closes_at,
                e.registration_opens_at, e.registration_closes_at, e.payment_instructions, e.retention_days,
                e.terms_file_name, e.terms_version, e.hero_object_key, e.login_mobile_object_key, e.home_image_object_key, c.name AS company_name,
                (SELECT count(*)::int FROM seat_holds h WHERE h.event_id = e.id AND h.status = 'active' AND h.expires_at > now()) AS active_holds
           FROM events e JOIN companies c ON c.id = e.company_id WHERE e.id = $1`,
        [eventId],
      );
      const r = rows[0];
      return {
        id: event.id, slug: event.slug, name: event.name, tierMax: event.max_travelers, hasRegistrations: await this.hasRegistrations(tx, eventId),
        status: r.status, companyName: r.company_name, days: r.itinerary?.days ?? [], themeColor: r.theme_color,
        supportPhone: r.support_phone, supportHours: r.support_hours,
        pageMode: r.page_mode, pageIsOpen: r.page_is_open, pageOpensAt: r.page_opens_at, pageClosesAt: r.page_closes_at,
        registrationOpensAt: r.registration_opens_at, registrationClosesAt: r.registration_closes_at,
        pageState: this.currentPageState(r), activeHolds: r.active_holds,
        paymentInstructions: r.payment_instructions, retentionDays: r.retention_days,
        termsFileName: r.terms_file_name, termsVersion: r.terms_version,
        images: agencyImages(eventId, { login: r.hero_object_key, 'login-mobile': r.login_mobile_object_key, home: r.home_image_object_key }),
      };
    });
  }

  private currentPageState(r: any) {
    if (r.status === 'draft') return 'closed';
    return pageState({ mode: r.page_mode, isOpen: r.page_is_open, opensAt: r.page_opens_at, closesAt: r.page_closes_at });
  }

  // ===== 額度與企業客戶 =====

  quota(ctx: AgencyUserContext) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT t.id, t.min_travelers, t.max_travelers, t.price_amount,
                COALESCE((SELECT sum(l.change)::int FROM agency_quota_ledger l WHERE l.pricing_tier_id = t.id), 0) AS remaining
           FROM pricing_tiers t WHERE t.is_active ORDER BY t.min_travelers`,
      );
      return rows.map((r) => ({ id: r.id, minTravelers: r.min_travelers, maxTravelers: r.max_travelers, price: r.price_amount, remaining: r.remaining }));
    });
  }

  listCompanies(ctx: AgencyUserContext) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT c.id, c.name, (SELECT count(*)::int FROM events e WHERE e.company_id = c.id AND e.status <> 'archived') AS event_count
           FROM companies c WHERE c.status = 'active' ORDER BY c.created_at`,
      );
      return rows.map((r) => ({ id: r.id, name: r.name, eventCount: r.event_count }));
    });
  }

  createCompany(ctx: AgencyUserContext, name: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const { rows } = await tx.query(`INSERT INTO companies (agency_id, name) VALUES ($1, $2) RETURNING id, name`, [ctx.agencyId, name]);
      return { id: rows[0].id, name: rows[0].name, eventCount: 0 };
    });
  }

  // ===== 活動 =====

  async createEvent(ctx: AgencyUserContext, input: NewEventInput) {
    return this.uniqueSlug(() => this.db.withTenant(ctx.agencyId, async (tx) => {
      const id = await this.insertDraftEvent(tx, ctx, input);
      await tx.query(
        `INSERT INTO traveler_types (agency_id, event_id, name, base_price, is_employee_self) VALUES ($1, $2, '員工本人', 0, true)`,
        [ctx.agencyId, id],
      );
      return { id };
    }));
  }

  /** 新活動一律是草稿，不帶員工名單、報名、開放時間與梯次；檔案共用，不會被刪除。 */
  async copyEvent(ctx: AgencyUserContext, sourceId: string, input: NewEventInput) {
    return this.uniqueSlug(() => this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, sourceId, false);
      const id = await this.insertDraftEvent(tx, ctx, input);
      await tx.query(
        `UPDATE events t SET itinerary = s.itinerary, theme_color = s.theme_color, support_phone = s.support_phone, support_hours = s.support_hours,
                hero_object_key = s.hero_object_key, login_mobile_object_key = s.login_mobile_object_key, home_image_object_key = s.home_image_object_key,
                default_subsidy_amount = s.default_subsidy_amount, default_dependent_limit = s.default_dependent_limit, allow_dependents_only = s.allow_dependents_only,
                payment_instructions = s.payment_instructions, terms_object_key = s.terms_object_key, terms_file_name = s.terms_file_name, retention_days = s.retention_days
           FROM events s WHERE t.id = $1 AND s.id = $2`,
        [id, sourceId],
      );
      await tx.query(`UPDATE events t SET notify_emails = s.notify_emails FROM events s WHERE t.id = $1 AND s.id = $2`, [id, sourceId]);
      await tx.query(
        `INSERT INTO email_templates (agency_id, event_id, template_key, subject, body, sender_name)
         SELECT agency_id, $1, template_key, subject, body, sender_name FROM email_templates WHERE event_id = $2`,
        [id, sourceId],
      );
      await tx.query(
        `INSERT INTO traveler_types (agency_id, event_id, name, base_price, is_employee_self, note, occupies_bed, sort_order)
         SELECT agency_id, $1, name, base_price, is_employee_self, note, occupies_bed, sort_order FROM traveler_types WHERE event_id = $2`,
        [id, sourceId],
      );
      await tx.query(
        `INSERT INTO event_fields (agency_id, event_id, field_key, label, field_type, choices, validation, is_required, is_sensitive, sort_order)
         SELECT agency_id, $1, field_key, label, field_type, choices, validation, is_required, is_sensitive, sort_order FROM event_fields WHERE event_id = $2`,
        [id, sourceId],
      );
      await tx.query(
        `INSERT INTO event_service_contacts (agency_id, event_id, name, phone, scope, sort_order)
         SELECT agency_id, $1, name, phone, scope, sort_order FROM event_service_contacts WHERE event_id = $2`,
        [id, sourceId],
      );
      const { rows: groups } = await tx.query(`SELECT id FROM option_groups WHERE event_id = $1`, [sourceId]);
      for (const g of groups) {
        const { rows } = await tx.query(
          `INSERT INTO option_groups (agency_id, event_id, name, is_required, min_select, max_select, is_room_type, preference_count, sort_order)
           SELECT agency_id, $1, name, is_required, min_select, max_select, is_room_type, preference_count, sort_order FROM option_groups WHERE id = $2 RETURNING id`,
          [id, g.id],
        );
        await tx.query(
          `INSERT INTO options (agency_id, group_id, name, description, price, sort_order, pdf_object_key, pdf_file_name)
           SELECT agency_id, $1, name, description, price, sort_order, pdf_object_key, pdf_file_name FROM options WHERE group_id = $2`,
          [rows[0].id, g.id],
        );
      }
      return { id };
    }));
  }

  private async insertDraftEvent(tx: Tx, ctx: AgencyUserContext, input: NewEventInput) {
    // 同一旅行社、同一級距依序扣額度，避免同時建立時超扣。
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`quota:${ctx.agencyId}:${input.pricingTierId}`]);
    const { rows: tiers } = await tx.query(
      `SELECT COALESCE((SELECT sum(l.change)::int FROM agency_quota_ledger l WHERE l.pricing_tier_id = t.id), 0) AS remaining
         FROM pricing_tiers t WHERE t.id = $1 AND t.is_active`,
      [input.pricingTierId],
    );
    if (!tiers[0]) throw new DomainError('NOT_FOUND');
    if (tiers[0].remaining < 1) throw new DomainError('QUOTA_EMPTY');
    const { rows: companies } = await tx.query(`SELECT id FROM companies WHERE id = $1 AND status = 'active'`, [input.companyId]);
    if (!companies[0]) throw new DomainError('NOT_FOUND');
    // 手動模式下，活動頁預設關閉，發布後由旅行社開啟。
    const { rows } = await tx.query(
      `INSERT INTO events (agency_id, company_id, slug, name, status, pricing_tier_id, page_mode, page_is_open, created_by)
       VALUES ($1, $2, $3, $4, 'draft', $5, 'manual', false, $6) RETURNING id`,
      [ctx.agencyId, input.companyId, input.slug, input.name, input.pricingTierId, ctx.user.id],
    );
    await tx.query(
      `INSERT INTO agency_quota_ledger (agency_id, pricing_tier_id, change, reason, event_id, created_by) VALUES ($1, $2, -1, 'event_created', $3, $4)`,
      [ctx.agencyId, input.pricingTierId, rows[0].id, ctx.user.id],
    );
    return rows[0].id as string;
  }

  /** 只有未發布的活動可以刪除，額度退回；代碼釋出給新活動使用。 */
  deleteEvent(ctx: AgencyUserContext, eventId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      const { rows } = await tx.query(`SELECT status, pricing_tier_id FROM events WHERE id = $1`, [eventId]);
      if (rows[0].status !== 'draft') throw new DomainError('EVENT_NOT_DRAFT');
      await tx.query(`UPDATE events SET status = 'archived', slug = $2, updated_at = now() WHERE id = $1`, [eventId, `deleted-${eventId}`]);
      await tx.query(
        `INSERT INTO agency_quota_ledger (agency_id, pricing_tier_id, change, reason, event_id, created_by) VALUES ($1, $2, 1, 'event_deleted', $3, $4)`,
        [ctx.agencyId, rows[0].pricing_tier_id, eventId, ctx.user.id],
      );
    });
  }

  updateBasic(ctx: AgencyUserContext, eventId: string, input: EventBasicInput) {
    return this.uniqueSlug(() => this.db.withTenant(ctx.agencyId, async (tx) => {
      const event = await this.lockEvent(tx, eventId, true);
      const { rows } = await tx.query(`SELECT status FROM events WHERE id = $1`, [eventId]);
      if (input.slug !== event.slug && rows[0].status !== 'draft') throw new DomainError('EVENT_NOT_DRAFT');
      await tx.query(
        `UPDATE events SET name = $2, slug = $3, itinerary = itinerary || jsonb_build_object('days', $4::jsonb),
                theme_color = $5, support_phone = $6, support_hours = $7, updated_at = now() WHERE id = $1`,
        [eventId, input.name, input.slug, JSON.stringify(input.days), input.themeColor, input.supportPhone, input.supportHours],
      );
    }));
  }

  updateSchedule(ctx: AgencyUserContext, eventId: string, input: EventScheduleInput) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      const { rows } = await tx.query(`SELECT status, page_mode, page_is_open, page_opens_at, page_closes_at FROM events WHERE id = $1`, [eventId]);
      // 切回手動時維持目前的開關狀態，不會突然開啟或關閉。
      const isOpen = input.pageMode === 'manual' && rows[0].page_mode === 'scheduled' ? this.currentPageState(rows[0]) === 'open' : rows[0].page_is_open;
      await tx.query(
        `UPDATE events SET page_mode = $2, page_is_open = $3, page_opens_at = $4, page_closes_at = $5,
                registration_opens_at = $6, registration_closes_at = $7, updated_at = now() WHERE id = $1`,
        [eventId, input.pageMode, isOpen, input.pageOpensAt, input.pageClosesAt, input.registrationOpensAt, input.registrationClosesAt],
      );
    });
  }

  setPageOpen(ctx: AgencyUserContext, eventId: string, open: boolean) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      const { rows } = await tx.query(`SELECT status, page_mode FROM events WHERE id = $1`, [eventId]);
      if (rows[0].page_mode !== 'manual') throw new DomainError('PAGE_MODE_MISMATCH');
      if (open && rows[0].status === 'draft') throw new DomainError('EVENT_NOT_PUBLISHED');
      await tx.query(`UPDATE events SET page_is_open = $2, updated_at = now() WHERE id = $1`, [eventId, open]);
    });
  }

  private async uniqueSlug<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e: any) {
      if (e?.code === '23505' && e?.constraint === 'events_agency_id_slug_key') throw new DomainError('SLUG_TAKEN');
      throw e;
    }
  }

  // ===== 梯次 =====

  listSessions(ctx: AgencyUserContext, eventId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, false);
      const { rows } = await tx.query(`SELECT ${SESSION_COLUMNS} FROM event_sessions WHERE event_id = $1 ORDER BY sort_order, departs_on, name`, [eventId]);
      return this.withRoomTypes(tx, rows);
    });
  }

  createSession(ctx: AgencyUserContext, eventId: string, input: SessionInput) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const event = await this.lockEvent(tx, eventId, true);
      await this.assertTierLimit(tx, eventId, event.max_travelers, input.capacity, null);
      const { rows } = await tx.query(
        `INSERT INTO event_sessions (agency_id, event_id, name, departs_on, returns_on, departure_time, return_arrival_time,
                                     outbound_flight_no, return_flight_no, capacity, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 (SELECT COALESCE(max(sort_order), 0) + 1 FROM event_sessions WHERE event_id = $2))
         RETURNING ${SESSION_COLUMNS}`,
        [ctx.agencyId, eventId, input.name, input.departsOn, input.returnsOn, input.departureTime, input.returnArrivalTime,
          input.outboundFlightNo, input.returnFlightNo, input.capacity],
      );
      if (input.roomTypes) await this.saveRoomTypes(tx, ctx.agencyId, rows[0].id, input.roomTypes);
      return (await this.withRoomTypes(tx, rows))[0];
    });
  }

  updateSession(ctx: AgencyUserContext, eventId: string, sessionId: string, input: SessionInput) {
    this.assertUuid(sessionId);
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const event = await this.lockEvent(tx, eventId, true);
      // 與保留、送出相同，先鎖梯次，人數才不會在檢查後改變
      const { rows: found } = await tx.query(`SELECT sold_count FROM event_sessions WHERE id = $1 AND event_id = $2 FOR UPDATE`, [sessionId, eventId]);
      if (!found[0]) throw new DomainError('NOT_FOUND');
      // 保留中的名額送出時會變成已報名，所以也要算進去。
      const { rows: holds } = await tx.query(
        `SELECT COALESCE(sum(quantity), 0)::int AS held FROM seat_holds WHERE session_id = $1 AND status = 'active' AND expires_at > now()`,
        [sessionId],
      );
      const taken = found[0].sold_count + holds[0].held;
      if (input.capacity < taken) throw new DomainError('CAPACITY_BELOW_SOLD', { soldCount: taken });
      await this.assertTierLimit(tx, eventId, event.max_travelers, input.capacity, sessionId);
      const { rows } = await tx.query(
        `UPDATE event_sessions
            SET name = $3, departs_on = $4, returns_on = $5, departure_time = $6, return_arrival_time = $7,
                outbound_flight_no = $8, return_flight_no = $9, capacity = $10
          WHERE id = $1 AND event_id = $2 RETURNING ${SESSION_COLUMNS}`,
        [sessionId, eventId, input.name, input.departsOn, input.returnsOn, input.departureTime, input.returnArrivalTime,
          input.outboundFlightNo, input.returnFlightNo, input.capacity],
      );
      if (input.roomTypes) await this.saveRoomTypes(tx, ctx.agencyId, sessionId, input.roomTypes);
      return (await this.withRoomTypes(tx, rows))[0];
    });
  }

  async deleteSession(ctx: AgencyUserContext, eventId: string, sessionId: string) {
    this.assertUuid(sessionId);
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      const { rows } = await tx.query(`SELECT id FROM event_sessions WHERE id = $1 AND event_id = $2 FOR UPDATE`, [sessionId, eventId]);
      if (!rows[0]) throw new DomainError('NOT_FOUND');
      const used = await tx.query(
        `SELECT 1 FROM registrations WHERE session_id = $1
         UNION ALL SELECT 1 FROM seat_holds WHERE session_id = $1 LIMIT 1`,
        [sessionId],
      );
      if (used.rowCount) throw new DomainError('SESSION_IN_USE');
      const { rows: others } = await tx.query(
        `SELECT e.status, (SELECT count(*)::int FROM event_sessions s WHERE s.event_id = e.id AND s.id <> $2) AS others FROM events e WHERE e.id = $1`,
        [eventId, sessionId],
      );
      if (others[0].status !== 'draft' && others[0].others === 0) throw new DomainError('PUBLISH_REQUIREMENT');
      await tx.query(`DELETE FROM event_sessions WHERE id = $1`, [sessionId]);
    });
  }

  reorderSessions(ctx: AgencyUserContext, eventId: string, ids: string[]) {
    return this.reorder(ctx, eventId, 'event_sessions', ids);
  }

  private async withRoomTypes(tx: Tx, sessions: any[]) {
    const { rows } = await tx.query(
      `SELECT id, session_id, name, capacity, surcharge, bed_quota, sold_count FROM session_room_types
        WHERE session_id = ANY($1::uuid[]) ORDER BY sort_order, name`,
      [sessions.map((s) => s.id)],
    );
    return sessions.map((s) => ({ ...sessionRow(s), roomTypes: rows.filter((r) => r.session_id === s.id).map(roomTypeRow) }));
  }

  /** 整份覆蓋這個梯次的房型；已售出的房型不能刪除，床位也不能低於已售。 */
  private async saveRoomTypes(tx: Tx, agencyId: string, sessionId: string, input: NonNullable<SessionInput['roomTypes']>) {
    this.assertUniqueNames(input.map((r) => r.name));
    // 保留中的床位送出時會變成已售，所以也要算進去。
    const { rows } = await tx.query(
      `SELECT r.id, r.sold_count + COALESCE((SELECT sum(i.quantity) FROM seat_hold_room_items i JOIN seat_holds h ON h.id = i.hold_id
                WHERE i.room_type_id = r.id AND h.status = 'active' AND h.expires_at > now()), 0)::int AS taken,
              EXISTS (SELECT 1 FROM travelers t WHERE t.session_room_type_id = r.id) AS referenced
         FROM session_room_types r WHERE r.session_id = $1 FOR UPDATE OF r`,
      [sessionId],
    );
    const existing = new Map(rows.map((r) => [r.id as string, r.taken as number]));
    const referenced = new Set(rows.filter((r) => r.referenced).map((r) => r.id as string));
    const keep = new Set(input.flatMap((r) => (r.id ? [r.id] : [])));
    if (input.some((r) => r.id && !existing.has(r.id))) throw new DomainError('INVALID_INPUT', { issues: ['roomTypes'] });
    if ([...existing].some(([id, taken]) => (taken > 0 || referenced.has(id)) && !keep.has(id))) throw new DomainError('ROOM_TYPE_IN_USE');
    await tx.query(`DELETE FROM session_room_types WHERE session_id = $1 AND NOT (id = ANY($2::uuid[]))`, [sessionId, [...keep]]);
    for (const [i, r] of input.entries()) {
      const sold = r.id ? existing.get(r.id)! : 0;
      if (r.bedQuota < sold) throw new DomainError('CAPACITY_BELOW_SOLD', { soldCount: sold });
      if (r.id) {
        await tx.query(
          `UPDATE session_room_types SET name = $2, capacity = $3, surcharge = $4, bed_quota = $5, sort_order = $6 WHERE id = $1`,
          [r.id, r.name, r.capacity, r.surcharge, r.bedQuota, i + 1],
        );
      } else {
        await tx.query(
          `INSERT INTO session_room_types (agency_id, session_id, name, capacity, surcharge, bed_quota, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [agencyId, sessionId, r.name, r.capacity, r.surcharge, r.bedQuota, i + 1],
        );
      }
    }
  }

  // ===== 旅客類型與團費 =====

  getPricing(ctx: AgencyUserContext, eventId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, false);
      return this.readPricing(tx, eventId);
    });
  }

  /** 價格改動只影響之後的新報名，已送出的報名保留當時的快照。 */
  savePricing(ctx: AgencyUserContext, eventId: string, input: PricingInput) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      const { rows } = await tx.query(`SELECT id, name, is_employee_self FROM traveler_types WHERE event_id = $1 FOR UPDATE`, [eventId]);
      const existing = new Map(rows.map((r) => [r.id as string, r]));
      if (input.types.some((t) => t.id && !existing.has(t.id))) throw new DomainError('INVALID_INPUT', { issues: ['types'] });
      const keep = input.types.flatMap((t) => (t.id ? [t.id] : []));
      if (rows.some((r) => r.is_employee_self && !keep.includes(r.id))) throw new DomainError('INVALID_INPUT', { issues: ['types'] });
      // 員工本人固定：名稱不變，也一定佔床。
      const types = input.types.map((t) => {
        const self = t.id ? existing.get(t.id)?.is_employee_self : false;
        return self ? { ...t, name: existing.get(t.id!)!.name as string, occupiesBed: true } : t;
      });
      this.assertUniqueNames(types.map((t) => t.name));

      const removed = rows.filter((r) => !keep.includes(r.id)).map((r) => r.id as string);
      if (removed.length) {
        const used = await tx.query(`SELECT 1 FROM travelers WHERE traveler_type_id = ANY($1::uuid[]) LIMIT 1`, [removed]);
        if (used.rowCount) throw new DomainError('TRAVELER_TYPE_IN_USE');
        await tx.query(`DELETE FROM traveler_types WHERE id = ANY($1::uuid[])`, [removed]);
      }
      for (const [i, t] of types.entries()) {
        if (t.id) {
          await tx.query(
            `UPDATE traveler_types SET name = $2, base_price = $3, note = $4, occupies_bed = $5, sort_order = $6 WHERE id = $1`,
            [t.id, t.name, t.basePrice, t.note, t.occupiesBed, i + 1],
          );
        } else {
          await tx.query(
            `INSERT INTO traveler_types (agency_id, event_id, name, base_price, note, occupies_bed, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [ctx.agencyId, eventId, t.name, t.basePrice, t.note, t.occupiesBed, i + 1],
          );
        }
      }
      await tx.query(
        `UPDATE events SET default_subsidy_amount = $2, default_dependent_limit = $3, allow_dependents_only = $4, updated_at = now() WHERE id = $1`,
        [eventId, input.defaultSubsidyAmount, input.defaultDependentLimit, input.allowDependentsOnly],
      );
      return this.readPricing(tx, eventId);
    });
  }

  private async readPricing(tx: Tx, eventId: string) {
    const { rows } = await tx.query(
      `SELECT id, name, base_price, note, occupies_bed, is_employee_self FROM traveler_types
        WHERE event_id = $1 ORDER BY is_employee_self DESC, sort_order, name`,
      [eventId],
    );
    const { rows: events } = await tx.query(`SELECT default_subsidy_amount, default_dependent_limit, allow_dependents_only FROM events WHERE id = $1`, [eventId]);
    return {
      types: rows.map(travelerTypeRow),
      defaultSubsidyAmount: events[0].default_subsidy_amount,
      defaultDependentLimit: events[0].default_dependent_limit,
      allowDependentsOnly: events[0].allow_dependents_only,
    };
  }

  // ===== 自選行程 =====

  listOptionGroups(ctx: AgencyUserContext, eventId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, false);
      const { rows: groups } = await tx.query(
        `SELECT id, name, is_required, max_select, preference_count FROM option_groups WHERE event_id = $1 ORDER BY sort_order, name`,
        [eventId],
      );
      const { rows: options } = await tx.query(
        `SELECT o.id, o.group_id, o.name, o.price, o.pdf_file_name FROM options o JOIN option_groups g ON g.id = o.group_id
          WHERE g.event_id = $1 ORDER BY o.sort_order, o.name`,
        [eventId],
      );
      const { rows: quotas } = await tx.query(
        `SELECT q.option_id, q.session_id, q.capacity, q.sold_count FROM option_session_quotas q
           JOIN event_sessions s ON s.id = q.session_id WHERE s.event_id = $1`,
        [eventId],
      );
      return groups.map((g) => ({
        id: g.id,
        name: g.name,
        isRequired: g.is_required,
        maxSelect: g.max_select,
        preferenceCount: g.preference_count,
        options: options.filter((o) => o.group_id === g.id).map((o) => ({
          id: o.id,
          name: o.name,
          price: o.price,
          pdfFileName: o.pdf_file_name,
          quotas: Object.fromEntries(quotas.filter((q) => q.option_id === o.id)
            .map((q) => [q.session_id, { capacity: q.capacity, soldCount: q.sold_count }])),
        })),
      }));
    });
  }

  createOptionGroup(ctx: AgencyUserContext, eventId: string, input: OptionGroupInput) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      await this.assertNameFree(tx, 'option_groups', 'event_id', eventId, input.name, null);
      const { rows } = await tx.query(
        `INSERT INTO option_groups (agency_id, event_id, name, is_required, min_select, max_select, preference_count, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT COALESCE(max(sort_order), 0) + 1 FROM option_groups WHERE event_id = $2)) RETURNING id`,
        [ctx.agencyId, eventId, input.name, input.isRequired, input.isRequired ? 1 : 0, input.maxSelect, input.preferenceCount],
      );
      return { id: rows[0].id as string };
    });
  }

  async updateOptionGroup(ctx: AgencyUserContext, eventId: string, groupId: string, input: OptionGroupInput) {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      await this.assertGroup(tx, eventId, groupId);
      await this.assertNameFree(tx, 'option_groups', 'event_id', eventId, input.name, groupId);
      await tx.query(
        `UPDATE option_groups SET name = $2, is_required = $3, min_select = $4, max_select = $5, preference_count = $6 WHERE id = $1`,
        [groupId, input.name, input.isRequired, input.isRequired ? 1 : 0, input.maxSelect, input.preferenceCount],
      );
    });
  }

  async deleteOptionGroup(ctx: AgencyUserContext, eventId: string, groupId: string) {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      await this.assertGroup(tx, eventId, groupId);
      const { rows } = await tx.query(`SELECT id FROM options WHERE group_id = $1`, [groupId]);
      await this.clearOptionHolds(tx, rows.map((r) => r.id));
      await tx.query(`DELETE FROM option_groups WHERE id = $1`, [groupId]);
    });
  }

  createOption(ctx: AgencyUserContext, eventId: string, groupId: string, input: OptionInput) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      await this.assertGroup(tx, eventId, groupId);
      await this.assertNameFree(tx, 'options', 'group_id', groupId, input.name, null);
      const { rows } = await tx.query(
        `INSERT INTO options (agency_id, group_id, name, price, sort_order)
         VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(sort_order), 0) + 1 FROM options WHERE group_id = $2)) RETURNING id`,
        [ctx.agencyId, groupId, input.name, input.price],
      );
      await this.saveQuotas(tx, ctx.agencyId, eventId, rows[0].id, input.quotas);
      return { id: rows[0].id as string };
    });
  }

  /** 價格改動只影響之後的新報名，已選的旅客保留當時的快照。 */
  async updateOption(ctx: AgencyUserContext, eventId: string, optionId: string, input: OptionInput) {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      const groupId = await this.optionGroupId(tx, eventId, optionId);
      await this.assertNameFree(tx, 'options', 'group_id', groupId, input.name, optionId);
      await tx.query(`UPDATE options SET name = $2, price = $3 WHERE id = $1`, [optionId, input.name, input.price]);
      await this.saveQuotas(tx, ctx.agencyId, eventId, optionId, input.quotas);
    });
  }

  async deleteOption(ctx: AgencyUserContext, eventId: string, optionId: string) {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      await this.optionGroupId(tx, eventId, optionId);
      await this.clearOptionHolds(tx, [optionId]);
      await tx.query(`DELETE FROM options WHERE id = $1`, [optionId]);
    });
  }

  private async saveQuotas(tx: Tx, agencyId: string, eventId: string, optionId: string, quotas: OptionInput['quotas']) {
    const ids = quotas.map((q) => q.sessionId);
    const { rows: sessions } = await tx.query(`SELECT id FROM event_sessions WHERE event_id = $1 AND id = ANY($2::uuid[])`, [eventId, ids]);
    if (new Set(ids).size !== ids.length || sessions.length !== ids.length) throw new DomainError('INVALID_INPUT', { issues: ['quotas'] });
    for (const { sessionId, capacity } of quotas) {
      // 與保留、送出相同，先鎖名額列，人數才不會在檢查後改變。
      const { rows } = await tx.query(
        `SELECT q.id, q.sold_count,
                COALESCE((SELECT sum(i.quantity) FROM seat_hold_items i JOIN seat_holds h ON h.id = i.hold_id
                           WHERE i.quota_id = q.id AND h.status = 'active' AND h.expires_at > now()), 0)::int AS held
           FROM option_session_quotas q WHERE q.option_id = $1 AND q.session_id = $2 FOR UPDATE OF q`,
        [optionId, sessionId],
      );
      const found = rows[0];
      const taken = found ? found.sold_count + found.held : 0;
      if (capacity === null) {
        if (!found) continue;
        // 名額列記著已售人數，已有人選時移除會讓之後的計數歸零。
        if (taken > 0) throw new DomainError('QUOTA_IN_USE');
        await tx.query(`DELETE FROM seat_hold_items WHERE quota_id = $1`, [found.id]);
        await tx.query(`DELETE FROM option_session_quotas WHERE id = $1`, [found.id]);
      } else if (found) {
        if (capacity < taken) throw new DomainError('CAPACITY_BELOW_SOLD', { soldCount: taken });
        await tx.query(`UPDATE option_session_quotas SET capacity = $2 WHERE id = $1`, [found.id, capacity]);
      } else {
        await tx.query(
          `INSERT INTO option_session_quotas (agency_id, option_id, session_id, capacity) VALUES ($1, $2, $3, $4)`,
          [agencyId, optionId, sessionId, capacity],
        );
      }
    }
  }

  /** 有旅客選過或保留中的選項不能刪除；已結束的保留紀錄會一併清除。 */
  private async clearOptionHolds(tx: Tx, optionIds: string[]) {
    const used = await tx.query(
      `SELECT 1 FROM traveler_options WHERE option_id = ANY($1::uuid[])
       UNION ALL
       SELECT 1 FROM seat_hold_items i JOIN seat_holds h ON h.id = i.hold_id JOIN option_session_quotas q ON q.id = i.quota_id
        WHERE q.option_id = ANY($1::uuid[]) AND h.status = 'active' AND h.expires_at > now()
       LIMIT 1`,
      [optionIds],
    );
    if (used.rowCount) throw new DomainError('OPTION_IN_USE');
    await tx.query(
      `DELETE FROM seat_hold_items WHERE quota_id IN (SELECT id FROM option_session_quotas WHERE option_id = ANY($1::uuid[]))`,
      [optionIds],
    );
  }

  private async assertGroup(tx: Tx, eventId: string, groupId: string) {
    this.assertUuid(groupId);
    const { rows } = await tx.query(`SELECT id FROM option_groups WHERE id = $1 AND event_id = $2 FOR UPDATE`, [groupId, eventId]);
    if (!rows[0]) throw new DomainError('NOT_FOUND');
  }

  private async optionGroupId(tx: Tx, eventId: string, optionId: string) {
    this.assertUuid(optionId);
    const { rows } = await tx.query(
      `SELECT o.group_id FROM options o JOIN option_groups g ON g.id = o.group_id WHERE o.id = $1 AND g.event_id = $2 FOR UPDATE OF o`,
      [optionId, eventId],
    );
    if (!rows[0]) throw new DomainError('NOT_FOUND');
    return rows[0].group_id as string;
  }

  private assertUniqueNames(names: string[]) {
    if (new Set(names).size !== names.length) throw new DomainError('DUPLICATE_NAME');
  }

  /** 呼叫前已鎖定活動，同時新增不會產生相同名稱。 */
  private async assertNameFree(tx: Tx, table: 'option_groups' | 'options', scope: 'event_id' | 'group_id', scopeId: string, name: string, excludeId: string | null) {
    const { rowCount } = await tx.query(
      `SELECT 1 FROM ${table} WHERE ${scope} = $1 AND name = $2 AND ($3::uuid IS NULL OR id <> $3)`,
      [scopeId, name, excludeId],
    );
    if (rowCount) throw new DomainError('DUPLICATE_NAME');
  }

  reorderOptionGroups(ctx: AgencyUserContext, eventId: string, ids: string[]) {
    return this.reorder(ctx, eventId, 'option_groups', ids);
  }

  async reorderOptions(ctx: AgencyUserContext, eventId: string, groupId: string, ids: string[]) {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      await this.assertGroup(tx, eventId, groupId);
      const { rows } = await tx.query(`SELECT id FROM options WHERE group_id = $1`, [groupId]);
      const existing = new Set(rows.map((r) => r.id as string));
      if (new Set(ids).size !== ids.length || ids.length !== existing.size || ids.some((id) => !existing.has(id))) {
        throw new DomainError('INVALID_INPUT', { issues: ['ids'] });
      }
      await tx.query(
        `UPDATE options t SET sort_order = o.ord FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, ord) WHERE t.id = o.id AND t.group_id = $2`,
        [ids, groupId],
      );
    });
  }

  // ===== 付款說明與條款 =====

  async savePaymentTerms(ctx: AgencyUserContext, eventId: string, input: PaymentTermsInput) {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      if (!input.paymentInstructions && await this.isPublished(tx, eventId)) throw new DomainError('PUBLISH_REQUIREMENT');
      await tx.query(
        `UPDATE events SET payment_instructions = $2, retention_days = $3, updated_at = now() WHERE id = $1`,
        [eventId, input.paymentInstructions, input.retentionDays],
      );
    });
  }

  /** 更換條款會產生新版本；舊檔保留，才能對照員工當時同意的內容。 */
  uploadTerms(ctx: AgencyUserContext, eventId: string, name: string, content: unknown) {
    if (!Buffer.isBuffer(content) || content.subarray(0, 5).toString('latin1') !== '%PDF-') throw new DomainError('INVALID_FILE');
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      const { rows } = await tx.query(`SELECT terms_object_key, terms_version FROM events WHERE id = $1`, [eventId]);
      const version: number = rows[0].terms_object_key ? rows[0].terms_version + 1 : rows[0].terms_version;
      const key = `${ctx.agencyId}/events/${eventId}/terms/v${version}-${randomBytes(6).toString('hex')}.pdf`;
      const fileName = name.replace(/[\\/\p{Cc}]/gu, '').trim().slice(-200) || 'terms.pdf';
      await this.storage.put(key, content);
      await tx.query(
        `UPDATE events SET terms_object_key = $2, terms_file_name = $3, terms_version = $4, updated_at = now() WHERE id = $1`,
        [eventId, key, fileName, version],
      );
      return { termsFileName: fileName, termsVersion: version };
    });
  }

  async readTerms(ctx: AgencyUserContext, eventId: string) {
    const r = await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, false);
      const { rows } = await tx.query(`SELECT terms_object_key, terms_file_name FROM events WHERE id = $1`, [eventId]);
      return rows[0];
    });
    if (!r.terms_object_key) throw new DomainError('NOT_FOUND');
    return { name: r.terms_file_name as string, content: await this.storage.get(r.terms_object_key) };
  }

  // ===== 前台圖片 =====

  /** 舊檔不刪除：複製出去的活動可能共用同一個檔案。 */
  uploadImage(ctx: AgencyUserContext, eventId: string, kind: string, content: unknown) {
    const column = this.imageColumn(kind);
    const ext = Buffer.isBuffer(content) ? imageExtension(content) : null;
    if (!ext) throw new DomainError('INVALID_FILE');
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      const key = `${ctx.agencyId}/events/${eventId}/images/${kind}-${randomBytes(6).toString('hex')}.${ext}`;
      await this.storage.put(key, content as Buffer);
      await tx.query(`UPDATE events SET ${column} = $2, updated_at = now() WHERE id = $1`, [eventId, key]);
      return { ok: true };
    });
  }

  async readImage(ctx: AgencyUserContext, eventId: string, kind: string) {
    const column = this.imageColumn(kind);
    const key = await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, false);
      const { rows } = await tx.query(`SELECT ${column} AS key FROM events WHERE id = $1`, [eventId]);
      return rows[0].key as string | null;
    });
    if (!key) throw new DomainError('NOT_FOUND');
    return { contentType: imageContentType(key), content: await this.storage.get(key) };
  }

  async deleteImage(ctx: AgencyUserContext, eventId: string, kind: string) {
    const column = this.imageColumn(kind);
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      await tx.query(`UPDATE events SET ${column} = NULL, updated_at = now() WHERE id = $1`, [eventId]);
    });
  }

  private imageColumn(kind: string) {
    if (!isImageKind(kind)) throw new DomainError('NOT_FOUND');
    return IMAGE_COLUMN[kind];
  }

  // ===== 行程 PDF =====

  uploadOptionPdf(ctx: AgencyUserContext, eventId: string, optionId: string, name: string, content: unknown) {
    if (!Buffer.isBuffer(content) || content.subarray(0, 5).toString('latin1') !== '%PDF-') throw new DomainError('INVALID_FILE');
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      await this.optionGroupId(tx, eventId, optionId);
      const key = `${ctx.agencyId}/events/${eventId}/options/${optionId}-${randomBytes(6).toString('hex')}.pdf`;
      const fileName = name.replace(/[\\/\p{Cc}]/gu, '').trim().slice(-200) || 'itinerary.pdf';
      await this.storage.put(key, content);
      await tx.query(`UPDATE options SET pdf_object_key = $2, pdf_file_name = $3 WHERE id = $1`, [optionId, key, fileName]);
      return { pdfFileName: fileName };
    });
  }

  async readOptionPdf(ctx: AgencyUserContext, eventId: string, optionId: string) {
    const r = await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, false);
      await this.optionGroupId(tx, eventId, optionId);
      const { rows } = await tx.query(`SELECT pdf_object_key, pdf_file_name FROM options WHERE id = $1`, [optionId]);
      return rows[0];
    });
    if (!r.pdf_object_key) throw new DomainError('NOT_FOUND');
    return { name: r.pdf_file_name as string, content: await this.storage.get(r.pdf_object_key) };
  }

  async deleteOptionPdf(ctx: AgencyUserContext, eventId: string, optionId: string) {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      await this.optionGroupId(tx, eventId, optionId);
      await tx.query(`UPDATE options SET pdf_object_key = NULL, pdf_file_name = NULL WHERE id = $1`, [optionId]);
    });
  }

  // ===== 服務人員 =====

  listContacts(ctx: AgencyUserContext, eventId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, false);
      return this.readContacts(tx, eventId);
    });
  }

  saveContacts(ctx: AgencyUserContext, eventId: string, input: ContactsInput['contacts']) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      if (input.length === 0 && await this.isPublished(tx, eventId)) throw new DomainError('PUBLISH_REQUIREMENT');
      const { rows } = await tx.query(`SELECT id FROM event_service_contacts WHERE event_id = $1`, [eventId]);
      const existing = new Set(rows.map((r) => r.id as string));
      if (input.some((c) => c.id && !existing.has(c.id))) throw new DomainError('INVALID_INPUT', { issues: ['contacts'] });
      const keep = input.flatMap((c) => (c.id ? [c.id] : []));
      await tx.query(`DELETE FROM event_service_contacts WHERE event_id = $1 AND NOT (id = ANY($2::uuid[]))`, [eventId, keep]);
      for (const [i, c] of input.entries()) {
        if (c.id) {
          await tx.query(`UPDATE event_service_contacts SET name = $2, phone = $3, scope = $4, sort_order = $5 WHERE id = $1`, [c.id, c.name, c.phone, c.scope, i + 1]);
        } else {
          await tx.query(
            `INSERT INTO event_service_contacts (agency_id, event_id, name, phone, scope, sort_order) VALUES ($1, $2, $3, $4, $5, $6)`,
            [ctx.agencyId, eventId, c.name, c.phone, c.scope, i + 1],
          );
        }
      }
      return this.readContacts(tx, eventId);
    });
  }

  private async readContacts(tx: Tx, eventId: string) {
    const { rows } = await tx.query(`SELECT id, name, phone, scope FROM event_service_contacts WHERE event_id = $1 ORDER BY sort_order, name`, [eventId]);
    return rows;
  }

  // ===== 發布 =====

  publishCheck(ctx: AgencyUserContext, eventId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, false);
      return this.computePublishChecks(tx, eventId);
    });
  }

  /** 重新檢查後才發布；檢查與改狀態都在鎖定活動的交易內。 */
  async publish(ctx: AgencyUserContext, eventId: string, confirmFreeSelfFee: boolean) {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      const { status, checks } = await this.computePublishChecks(tx, eventId);
      if (status !== 'draft') throw new DomainError('EVENT_NOT_DRAFT');
      const blocked = checks.filter((c) => c.state === 'block' || (c.state === 'confirm' && !confirmFreeSelfFee)).map((c) => c.key);
      if (blocked.length) throw new DomainError('PUBLISH_BLOCKED', { keys: blocked });
      await tx.query(`UPDATE events SET status = 'published', updated_at = now() WHERE id = $1`, [eventId]);
    });
  }

  private async computePublishChecks(tx: Tx, eventId: string) {
    const { rows } = await tx.query(
      `SELECT e.status, e.itinerary, e.hero_object_key, e.terms_object_key, e.terms_version, e.payment_instructions,
              e.registration_opens_at, e.registration_closes_at, e.page_mode,
              (SELECT count(*)::int FROM event_fields f WHERE f.event_id = e.id) AS fields,
              (SELECT count(*)::int FROM event_service_contacts c WHERE c.event_id = e.id) AS contacts,
              (SELECT count(*)::int FROM event_employees m WHERE m.event_id = e.id AND m.status = 'active') AS employees,
              (SELECT count(*)::int FROM traveler_types t WHERE t.event_id = e.id) AS types,
              (SELECT base_price FROM traveler_types t WHERE t.event_id = e.id AND t.is_employee_self) AS self_fee,
              (SELECT count(*)::int FROM event_sessions s WHERE s.event_id = e.id) AS sessions,
              (SELECT COALESCE(sum(s.capacity), 0)::int FROM event_sessions s WHERE s.event_id = e.id) AS capacity,
              (SELECT count(*)::int FROM event_sessions s WHERE s.event_id = e.id AND EXISTS (SELECT 1 FROM session_room_types r WHERE r.session_id = s.id)
                  AND (SELECT sum(r.bed_quota) FROM session_room_types r WHERE r.session_id = s.id) < s.capacity) AS short_beds,
              (SELECT count(*)::int FROM option_groups g WHERE g.event_id = e.id) AS groups,
              (SELECT count(*)::int FROM option_groups g WHERE g.event_id = e.id AND g.is_required AND NOT EXISTS (SELECT 1 FROM options o WHERE o.group_id = g.id)) AS required_empty,
              (SELECT count(*)::int FROM option_groups g WHERE g.event_id = e.id AND NOT g.is_required AND NOT EXISTS (SELECT 1 FROM options o WHERE o.group_id = g.id)) AS optional_empty
         FROM events e WHERE e.id = $1`,
      [eventId],
    );
    const r = rows[0];
    const days: number = r.itinerary?.days?.length ?? 0;
    const hasPeriod = r.registration_opens_at !== null && r.registration_closes_at !== null;
    const check = (key: string, state: 'ok' | 'warn' | 'block' | 'confirm', data: Record<string, unknown> = {}) => ({ key, state, data });
    const selfFee: number = r.self_fee ?? 0;
    const checks = [
      check('basic', days > 0 ? 'ok' : 'warn', { days }),
      check('heroImage', r.hero_object_key ? 'ok' : 'warn'),
      check('schedule', hasPeriod ? 'ok' : 'warn', { hasPeriod, opensAt: r.registration_opens_at, closesAt: r.registration_closes_at, pageMode: r.page_mode }),
      check('sessions', r.sessions === 0 || r.capacity === 0 ? 'block' : r.short_beds > 0 ? 'warn' : 'ok', { count: r.sessions, capacity: r.capacity, shortBeds: r.short_beds }),
      check('types', r.self_fee === null ? 'block' : selfFee === 0 ? 'confirm' : 'ok', { count: r.types, selfFee }),
      check('options', r.required_empty > 0 ? 'block' : r.optional_empty > 0 ? 'warn' : 'ok', { count: r.groups, requiredEmpty: r.required_empty, optionalEmpty: r.optional_empty }),
      check('fields', 'ok', { count: r.fields }),
      check('terms', r.terms_object_key ? 'ok' : 'block', { version: r.terms_version }),
      check('payment', r.payment_instructions ? 'ok' : 'block'),
      check('contacts', r.contacts > 0 ? 'ok' : 'block', { count: r.contacts }),
      check('roster', r.employees > 0 ? 'ok' : 'warn', { count: r.employees }),
    ];
    return { status: r.status as string, checks };
  }

  private async isPublished(tx: Tx, eventId: string) {
    const { rows } = await tx.query(`SELECT status FROM events WHERE id = $1`, [eventId]);
    return rows[0].status !== 'draft';
  }

  // ===== 旅客資料欄位 =====

  listFields(ctx: AgencyUserContext, eventId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, false);
      const { rows } = await tx.query(`SELECT ${FIELD_COLUMNS} FROM event_fields WHERE event_id = $1 ORDER BY sort_order, label`, [eventId]);
      return rows.map(fieldRow);
    });
  }

  createField(ctx: AgencyUserContext, eventId: string, input: FieldInput) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      const { rows } = await tx.query(
        `INSERT INTO event_fields (agency_id, event_id, field_key, label, field_type, choices, is_required, is_sensitive, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (SELECT COALESCE(max(sort_order), 0) + 1 FROM event_fields WHERE event_id = $2))
         RETURNING ${FIELD_COLUMNS}`,
        [ctx.agencyId, eventId, `f_${randomBytes(6).toString('hex')}`, input.label, input.type,
          input.choices ? JSON.stringify(input.choices) : null, input.isRequired, input.isSensitive],
      );
      return fieldRow(rows[0]);
    });
  }

  /** 已有報名後不能改型態或敏感設定：舊資料的格式與儲存方式都依原設定。 */
  updateField(ctx: AgencyUserContext, eventId: string, fieldId: string, input: FieldInput) {
    this.assertUuid(fieldId);
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      const { rows: found } = await tx.query(`SELECT field_type, is_sensitive FROM event_fields WHERE id = $1 AND event_id = $2`, [fieldId, eventId]);
      const current = found[0];
      if (!current) throw new DomainError('NOT_FOUND');
      if ((current.field_type !== input.type || current.is_sensitive !== input.isSensitive) && (await this.hasRegistrations(tx, eventId))) {
        throw new DomainError('FIELD_LOCKED');
      }
      const { rows } = await tx.query(
        `UPDATE event_fields SET label = $3, field_type = $4, choices = $5, is_required = $6, is_sensitive = $7
          WHERE id = $1 AND event_id = $2 RETURNING ${FIELD_COLUMNS}`,
        [fieldId, eventId, input.label, input.type, input.choices ? JSON.stringify(input.choices) : null, input.isRequired, input.isSensitive],
      );
      return fieldRow(rows[0]);
    });
  }

  async deleteField(ctx: AgencyUserContext, eventId: string, fieldId: string) {
    this.assertUuid(fieldId);
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      if (await this.hasRegistrations(tx, eventId)) throw new DomainError('FIELD_LOCKED');
      const { rowCount } = await tx.query(`DELETE FROM event_fields WHERE id = $1 AND event_id = $2`, [fieldId, eventId]);
      if (!rowCount) throw new DomainError('NOT_FOUND');
    });
  }

  reorderFields(ctx: AgencyUserContext, eventId: string, ids: string[]) {
    return this.reorder(ctx, eventId, 'event_fields', ids);
  }

  // ===== 內部 =====

  private async reorder(ctx: AgencyUserContext, eventId: string, table: 'event_sessions' | 'event_fields' | 'option_groups', ids: string[]) {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, true);
      const { rows } = await tx.query(`SELECT id FROM ${table} WHERE event_id = $1`, [eventId]);
      const existing = new Set(rows.map((r) => r.id as string));
      if (new Set(ids).size !== ids.length || ids.length !== existing.size || ids.some((id) => !existing.has(id))) {
        throw new DomainError('INVALID_INPUT', { issues: ['ids'] });
      }
      await tx.query(
        `UPDATE ${table} t SET sort_order = o.ord FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, ord) WHERE t.id = o.id AND t.event_id = $2`,
        [ids, eventId],
      );
    });
  }

  private assertUuid(id: string) {
    if (!UUID.test(id)) throw new DomainError('NOT_FOUND');
  }

  /** forUpdate 讓同一活動的後台修改依序執行，名額上限的加總才不會被同時修改繞過。 */
  private async lockEvent(tx: Tx, eventId: string, forUpdate: boolean) {
    this.assertUuid(eventId);
    const { rows } = await tx.query(
      `SELECT e.id, e.slug, e.name, t.max_travelers FROM events e JOIN pricing_tiers t ON t.id = e.pricing_tier_id
        WHERE e.id = $1 ${forUpdate ? 'FOR UPDATE OF e' : ''}`,
      [eventId],
    );
    if (!rows[0]) throw new DomainError('NOT_FOUND');
    return rows[0];
  }

  private async hasRegistrations(tx: Tx, eventId: string) {
    const r = await tx.query(`SELECT 1 FROM registrations WHERE event_id = $1 LIMIT 1`, [eventId]);
    return !!r.rowCount;
  }

  private async assertTierLimit(tx: Tx, eventId: string, tierMax: number, capacity: number, excludeSessionId: string | null) {
    const { rows } = await tx.query(
      `SELECT COALESCE(sum(capacity), 0)::int AS total FROM event_sessions WHERE event_id = $1 AND id IS DISTINCT FROM $2`,
      [eventId, excludeSessionId],
    );
    if (rows[0].total + capacity > tierMax) throw new DomainError('TIER_LIMIT_EXCEEDED', { tierMax, otherSessions: rows[0].total });
  }
}
