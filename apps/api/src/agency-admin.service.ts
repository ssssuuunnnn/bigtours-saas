import { Inject, Injectable } from '@nestjs/common';
import { can, type AgencyPermission, type EventNavKey, type FieldInput, type SessionInput } from '@bigtours/shared';
import { generateToken, hashPassword, verifyPassword } from '@bigtours/shared/crypto';
import { randomBytes } from 'node:crypto';
import { AccessService } from './access.service.ts';
import { DatabaseService, type Tx } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { DomainError } from './errors.ts';

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

const fieldRow = (r: any) => ({
  id: r.id,
  label: r.label,
  type: r.field_type,
  choices: r.choices,
  isRequired: r.is_required,
  isSensitive: r.is_sensitive,
});
const FIELD_COLUMNS = 'id, label, field_type, choices, is_required, is_sensitive';

@Injectable()
export class AgencyAdminService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  // ===== 登入 =====

  async login(host: string | undefined, email: string, password: string) {
    const agency = await this.access.findAgency(host);
    const user = await this.db.withTenant(agency.id, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, password_hash, locked_until > now() AS locked FROM agency_users WHERE email = $1 AND status = 'active'`,
        [email],
      );
      return rows[0] as { id: string; password_hash: string; locked: boolean | null } | undefined;
    });
    const matched = await verifyPassword(password, user?.password_hash ?? (await DUMMY_HASH));
    if (!user || user.locked) throw new DomainError('INVALID_CREDENTIALS');
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
      await tx.query(`UPDATE agency_users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [user.id]);
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
        `SELECT e.id, e.slug, e.name, e.status, c.name AS company_name
           FROM events e JOIN companies c ON c.id = e.company_id
          WHERE e.status <> 'archived' ORDER BY e.created_at DESC`,
      );
      return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, status: r.status, companyName: r.company_name }));
    });
  }

  getEvent(ctx: AgencyUserContext, eventId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const event = await this.lockEvent(tx, eventId, false);
      return { id: event.id, slug: event.slug, name: event.name, tierMax: event.max_travelers, hasRegistrations: await this.hasRegistrations(tx, eventId) };
    });
  }

  // ===== 梯次 =====

  listSessions(ctx: AgencyUserContext, eventId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockEvent(tx, eventId, false);
      const { rows } = await tx.query(`SELECT ${SESSION_COLUMNS} FROM event_sessions WHERE event_id = $1 ORDER BY sort_order, departs_on, name`, [eventId]);
      return rows.map(sessionRow);
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
      return sessionRow(rows[0]);
    });
  }

  updateSession(ctx: AgencyUserContext, eventId: string, sessionId: string, input: SessionInput) {
    this.assertUuid(sessionId);
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const event = await this.lockEvent(tx, eventId, true);
      // 與保留、送出相同，先鎖梯次，人數才不會在檢查後改變
      const { rows: found } = await tx.query(`SELECT sold_count FROM event_sessions WHERE id = $1 AND event_id = $2 FOR UPDATE`, [sessionId, eventId]);
      if (!found[0]) throw new DomainError('NOT_FOUND');
      if (input.capacity < found[0].sold_count) throw new DomainError('CAPACITY_BELOW_SOLD', { soldCount: found[0].sold_count });
      await this.assertTierLimit(tx, eventId, event.max_travelers, input.capacity, sessionId);
      const { rows } = await tx.query(
        `UPDATE event_sessions
            SET name = $3, departs_on = $4, returns_on = $5, departure_time = $6, return_arrival_time = $7,
                outbound_flight_no = $8, return_flight_no = $9, capacity = $10
          WHERE id = $1 AND event_id = $2 RETURNING ${SESSION_COLUMNS}`,
        [sessionId, eventId, input.name, input.departsOn, input.returnsOn, input.departureTime, input.returnArrivalTime,
          input.outboundFlightNo, input.returnFlightNo, input.capacity],
      );
      return sessionRow(rows[0]);
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
      await tx.query(`DELETE FROM event_sessions WHERE id = $1`, [sessionId]);
    });
  }

  reorderSessions(ctx: AgencyUserContext, eventId: string, ids: string[]) {
    return this.reorder(ctx, eventId, 'event_sessions', ids);
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

  private async reorder(ctx: AgencyUserContext, eventId: string, table: 'event_sessions' | 'event_fields', ids: string[]) {
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
