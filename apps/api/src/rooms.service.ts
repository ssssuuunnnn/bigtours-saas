import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CreateRoomInput, UpdateRoomInput } from '@bigtours/shared';
import type { AgencyUserContext } from './agency-admin.service.ts';
import { DatabaseService, type Tx } from './database.service.ts';
import { DomainError } from './errors.ts';
import { NotificationService } from './notification.service.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SnapshotTraveler { id: string; name: string; employeeId: string }
interface SnapshotRoom { label: string; typeName: string | null; travelers: SnapshotTraveler[] }
export interface RoomSnapshot { rooms: SnapshotRoom[] }

/** 不佔床的旅客要排進房間才看得出跟誰住，但不算人數。 */
const roomStatus = (beds: number, capacity: number) => (beds > capacity ? 'over' : beds < capacity ? 'under' : 'ok');
const roomLine = (r: SnapshotRoom) => `${r.label}${r.typeName ? ` ${r.typeName}` : ''}：${r.travelers.map((t) => t.name).join('、')}`;

@Injectable()
export class RoomService {
  private readonly logger = new Logger(RoomService.name);

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  /** 同一個梯次的分房操作一次一個，自動編號和公布檢查才不會互相干擾。 */
  private async lockSession(tx: Tx, eventId: string, sessionId: string) {
    if (!UUID.test(sessionId)) throw new DomainError('NOT_FOUND');
    const { rows } = await tx.query(`SELECT id, name FROM event_sessions WHERE id = $1 AND event_id = $2 FOR UPDATE`, [sessionId, eventId]);
    if (!rows[0]) throw new DomainError('NOT_FOUND');
    return rows[0] as { id: string; name: string };
  }

  private async lockRoom(tx: Tx, eventId: string, roomId: string) {
    if (!UUID.test(roomId)) throw new DomainError('NOT_FOUND');
    const found = await tx.query(`SELECT r.session_id FROM rooms r JOIN event_sessions s ON s.id = r.session_id WHERE r.id = $1 AND s.event_id = $2`, [roomId, eventId]);
    if (!found.rows[0]) throw new DomainError('NOT_FOUND');
    await this.lockSession(tx, eventId, found.rows[0].session_id);
    return found.rows[0].session_id as string;
  }

  private async sessionRoomTypes(tx: Tx, sessionId: string) {
    const { rows } = await tx.query(`SELECT id, name, capacity FROM session_room_types WHERE session_id = $1 ORDER BY sort_order, name`, [sessionId]);
    return rows as { id: string; name: string; capacity: number }[];
  }

  private async loadTravelers(tx: Tx, sessionId: string) {
    const { rows } = await tx.query(
      `SELECT t.id, t.name, t.registration_id, t.requested_room_no, t.session_room_type_id, tt.name AS type_name, tt.occupies_bed,
              rt.name AS selected_room, m.id AS employee_id, m.name AS employee_name, m.email, a.room_id
         FROM travelers t
         JOIN registrations r ON r.id = t.registration_id AND r.status <> 'cancelled' AND r.session_id = $1
         JOIN traveler_types tt ON tt.id = t.traveler_type_id
         JOIN event_employees m ON m.id = r.event_employee_id
         LEFT JOIN session_room_types rt ON rt.id = t.session_room_type_id
         LEFT JOIN room_assignments a ON a.traveler_id = t.id
        ORDER BY r.submitted_at, t.sort_order`,
      [sessionId],
    );
    return rows;
  }

  private async loadRooms(tx: Tx, sessionId: string) {
    const { rows } = await tx.query(
      `SELECT r.id, r.label, r.note, r.session_room_type_id, COALESCE(rt.capacity, r.capacity) AS capacity, rt.name AS type_name
         FROM rooms r LEFT JOIN session_room_types rt ON rt.id = r.session_room_type_id
        WHERE r.session_id = $1 ORDER BY r.label`,
      [sessionId],
    );
    return rows;
  }

  private buildSnapshot(rooms: any[], travelers: any[]): RoomSnapshot {
    return {
      rooms: rooms.flatMap((r) => {
        const members = travelers.filter((t) => t.room_id === r.id);
        if (!members.length) return [];
        return [{ label: r.label, typeName: r.type_name, travelers: members.map((t) => ({ id: t.id, name: t.name, employeeId: t.employee_id })) }];
      }),
    };
  }

  /** 房間或同房對象有變動的員工。第一次公布時是所有人。 */
  private affectedEmployees(before: RoomSnapshot | null, after: RoomSnapshot) {
    const signature = (s: RoomSnapshot | null) => {
      const map = new Map<string, string>();
      for (const room of s?.rooms ?? []) {
        const mates = room.travelers.map((t) => t.id).sort().join(',');
        for (const t of room.travelers) map.set(t.id, `${room.label}|${room.typeName ?? ''}|${mates}|${room.travelers.map((x) => x.name).join(',')}`);
      }
      return map;
    };
    const old = signature(before);
    const now = signature(after);
    const ids = new Set<string>();
    for (const room of after.rooms) {
      for (const t of room.travelers) if (old.get(t.id) !== now.get(t.id)) ids.add(t.employeeId);
    }
    return ids;
  }

  private roomChanges(before: RoomSnapshot | null, after: RoomSnapshot) {
    if (!before) return [];
    const names = (r?: SnapshotRoom) => r?.travelers.map((t) => t.name) ?? [];
    const labels = [...new Set([...before.rooms, ...after.rooms].map((r) => r.label))].sort();
    return labels.flatMap((label) => {
      const a = before.rooms.find((r) => r.label === label);
      const b = after.rooms.find((r) => r.label === label);
      if (JSON.stringify(a) === JSON.stringify(b)) return [];
      return [{ label, typeName: b?.typeName ?? a?.typeName ?? null, before: names(a), after: names(b) }];
    });
  }

  overview(ctx: AgencyUserContext, eventId: string, sessionId?: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const { rows: sessions } = await tx.query(`SELECT id, name FROM event_sessions WHERE event_id = $1 ORDER BY sort_order, name`, [eventId]);
      const current = sessionId ? sessions.find((s) => s.id === sessionId) : sessions[0];
      if (sessionId && !current) throw new DomainError('NOT_FOUND');
      if (!current) return { sessions, session: null };

      const [rooms, travelers, roomTypes] = [await this.loadRooms(tx, current.id), await this.loadTravelers(tx, current.id), await this.sessionRoomTypes(tx, current.id)];
      const wishes = await tx.query(
        `SELECT p.registration_id, p.requested_room_no, p.preferred_coworker_name FROM room_preferences p JOIN registrations r ON r.id = p.registration_id
          WHERE r.session_id = $1 AND r.status <> 'cancelled' AND p.preferred_coworker_name IS NOT NULL`,
        [current.id],
      );
      const wishOf = (registrationId: string, no: number | null) => wishes.rows.find((w) => w.registration_id === registrationId && w.requested_room_no === (no ?? 1))?.preferred_coworker_name ?? null;
      const view = (t: any) => ({ id: t.id, name: t.name, typeName: t.type_name, occupiesBed: t.occupies_bed, employeeName: t.employee_name, selectedRoom: t.selected_room, roomTypeId: t.session_room_type_id });

      const roomViews = rooms.map((r) => {
        const members = travelers.filter((t) => t.room_id === r.id);
        const beds = members.filter((t) => t.occupies_bed).length;
        return {
          id: r.id, label: r.label, note: r.note, roomTypeId: r.session_room_type_id, typeName: r.type_name, capacity: r.capacity, beds,
          status: members.length ? roomStatus(beds, r.capacity) : 'empty',
          travelers: members.map(view),
          // 最終房型和員工選的不同時只提醒，費用由旅行社手動調整。
          mismatched: r.session_room_type_id ? members.filter((t) => t.occupies_bed && t.session_room_type_id !== r.session_room_type_id).map((t) => ({ name: t.name, selectedRoom: t.selected_room })) : [],
          wishes: [...new Set(members.map((t) => wishOf(t.registration_id, t.requested_room_no)).filter(Boolean))],
        };
      });

      const groups = new Map<string, any[]>();
      for (const t of travelers.filter((x) => !x.room_id)) {
        const key = `${t.registration_id}:${t.requested_room_no ?? 1}`;
        groups.set(key, [...(groups.get(key) ?? []), t]);
      }
      const unassigned = [...groups.entries()].map(([key, members]) => ({
        key, employeeName: members[0].employee_name, travelers: members.map(view),
        selectedRoom: members.find((m) => m.selected_room)?.selected_room ?? null,
        wish: wishOf(members[0].registration_id, members[0].requested_room_no),
      }));

      const pub = await tx.query(`SELECT p.snapshot, p.published_at FROM room_publications p WHERE p.session_id = $1`, [current.id]);
      const before: RoomSnapshot | null = pub.rows[0]?.snapshot ?? null;
      const after = this.buildSnapshot(rooms, travelers);
      const affected = this.affectedEmployees(before, after);
      const withEmail = new Set(travelers.filter((t) => t.email).map((t) => t.employee_id));
      const changes = this.roomChanges(before, after);

      return {
        sessions,
        session: {
          id: current.id, name: current.name, roomTypes,
          rooms: roomViews,
          unassigned,
          stats: {
            total: travelers.length,
            assigned: travelers.filter((t) => t.room_id).length,
            over: roomViews.filter((r) => r.status === 'over').length,
            under: roomViews.filter((r) => r.status === 'under').length,
            wishes: unassigned.filter((g) => g.wish).length,
          },
          publication: before ? { publishedAt: pub.rows[0].published_at, changes } : null,
          notifyCount: [...affected].filter((id) => withEmail.has(id)).length,
        },
      };
    });
  }

  private async nextLabel(tx: Tx, eventId: string, sessionId: string) {
    const { rows } = await tx.query(`SELECT id FROM event_sessions WHERE event_id = $1 ORDER BY sort_order, name`, [eventId]);
    const index = rows.findIndex((s) => s.id === sessionId);
    const prefix = index < 26 ? String.fromCharCode(65 + index) : `S${index + 1}`;
    const used = await tx.query(`SELECT label FROM rooms WHERE session_id = $1`, [sessionId]);
    const labels = new Set(used.rows.map((r) => r.label as string));
    let n = 1;
    const format = (x: number) => `${prefix}-${String(x).padStart(3, '0')}`;
    while (labels.has(format(n))) n += 1;
    return format(n);
  }

  /** 有房型的梯次要選房型，可住人數跟著房型；沒有房型的梯次自己填人數。 */
  private async resolveType(tx: Tx, sessionId: string, roomTypeId: string | null, capacity: number | undefined) {
    const types = await this.sessionRoomTypes(tx, sessionId);
    if (roomTypeId) {
      const type = types.find((t) => t.id === roomTypeId);
      if (!type) throw new DomainError('INVALID_INPUT');
      return { roomTypeId, capacity: type.capacity };
    }
    if (types.length > 0 || !capacity) throw new DomainError('INVALID_INPUT');
    return { roomTypeId: null, capacity };
  }

  private labelTaken(err: unknown): never {
    if ((err as { code?: string }).code === '23505') throw new DomainError('ROOM_LABEL_TAKEN');
    throw err;
  }

  async create(ctx: AgencyUserContext, eventId: string, input: CreateRoomInput) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockSession(tx, eventId, input.sessionId);
      const { roomTypeId, capacity } = await this.resolveType(tx, input.sessionId, input.roomTypeId, input.capacity);
      const label = input.label || await this.nextLabel(tx, eventId, input.sessionId);
      const { rows } = await tx.query(
        `INSERT INTO rooms (agency_id, session_id, label, session_room_type_id, capacity, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [ctx.agencyId, input.sessionId, label, roomTypeId, capacity, input.note || null],
      );
      return { id: rows[0].id as string, label };
    }).catch((e) => this.labelTaken(e));
  }

  async update(ctx: AgencyUserContext, eventId: string, roomId: string, input: UpdateRoomInput) {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      const sessionId = await this.lockRoom(tx, eventId, roomId);
      const { roomTypeId, capacity } = await this.resolveType(tx, sessionId, input.roomTypeId, input.capacity);
      await tx.query(`UPDATE rooms SET label = $2, session_room_type_id = $3, capacity = $4, note = $5 WHERE id = $1`, [roomId, input.label, roomTypeId, capacity, input.note || null]);
    }).catch((e) => this.labelTaken(e));
  }

  /** 房間裡的旅客回到未分房。 */
  async remove(ctx: AgencyUserContext, eventId: string, roomId: string) {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockRoom(tx, eventId, roomId);
      await tx.query(`DELETE FROM rooms WHERE id = $1`, [roomId]);
    });
  }

  /** roomId 為 null 表示移出房間。只能安排這個梯次的有效旅客。 */
  async assign(ctx: AgencyUserContext, eventId: string, sessionId: string, roomId: string | null, travelerIds: string[]) {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockSession(tx, eventId, sessionId);
      if (roomId) {
        const room = await tx.query(`SELECT 1 FROM rooms WHERE id = $1 AND session_id = $2`, [roomId, sessionId]);
        if (!room.rowCount) throw new DomainError('NOT_FOUND');
      }
      const valid = await tx.query(
        `SELECT t.id FROM travelers t JOIN registrations r ON r.id = t.registration_id WHERE t.id = ANY($1::uuid[]) AND r.session_id = $2 AND r.status <> 'cancelled'`,
        [travelerIds, sessionId],
      );
      if (valid.rowCount !== new Set(travelerIds).size) throw new DomainError('NOT_FOUND');
      if (!roomId) {
        await tx.query(`DELETE FROM room_assignments WHERE traveler_id = ANY($1::uuid[])`, [travelerIds]);
        return;
      }
      for (const id of new Set(travelerIds)) {
        await tx.query(
          `INSERT INTO room_assignments (traveler_id, agency_id, room_id, assigned_by) VALUES ($1, $2, $3, $4)
           ON CONFLICT (traveler_id) DO UPDATE SET room_id = EXCLUDED.room_id, assigned_by = EXCLUDED.assigned_by, assigned_at = now()`,
          [id, ctx.agencyId, roomId, ctx.user.id],
        );
      }
    });
  }

  /**
   * 依員工填的「第幾間」建立草稿，只處理還沒分房的旅客，已排好的房間不動。
   * 同一間已經有人排好時加入那一間；房型取同一間旅客最多人選的，一樣多時取先選的。
   */
  async draft(ctx: AgencyUserContext, eventId: string, sessionId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.lockSession(tx, eventId, sessionId);
      const travelers = await this.loadTravelers(tx, sessionId);
      const types = await this.sessionRoomTypes(tx, sessionId);
      const groups = new Map<string, any[]>();
      for (const t of travelers) {
        const key = `${t.registration_id}:${t.requested_room_no ?? 1}`;
        groups.set(key, [...(groups.get(key) ?? []), t]);
      }
      let created = 0;
      let placed = 0;
      for (const members of groups.values()) {
        const pending = members.filter((t) => !t.room_id);
        if (!pending.length) continue;
        let roomId: string | undefined = members.find((t) => t.room_id)?.room_id;
        if (!roomId) {
          const counts = new Map<string, number>();
          for (const t of members) if (t.occupies_bed && t.session_room_type_id) counts.set(t.session_room_type_id, (counts.get(t.session_room_type_id) ?? 0) + 1);
          const typeId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? types[0]?.id ?? null;
          const capacity = types.find((t) => t.id === typeId)?.capacity ?? Math.max(members.filter((t) => t.occupies_bed).length, 1);
          const label = await this.nextLabel(tx, eventId, sessionId);
          const { rows } = await tx.query(
            `INSERT INTO rooms (agency_id, session_id, label, session_room_type_id, capacity) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [ctx.agencyId, sessionId, label, typeId, capacity],
          );
          roomId = rows[0].id as string;
          created += 1;
        }
        for (const t of pending) {
          await tx.query(`INSERT INTO room_assignments (traveler_id, agency_id, room_id, assigned_by) VALUES ($1, $2, $3, $4)`, [t.id, ctx.agencyId, roomId, ctx.user.id]);
          placed += 1;
        }
      }
      return { created, placed };
    });
  }

  /** 所有有效旅客都分房、沒有超過可住人數才能公布。重新公布只通知有變動的員工。 */
  async publish(ctx: AgencyUserContext, eventId: string, sessionId: string) {
    const result = await this.db.withTenant(ctx.agencyId, async (tx) => {
      const session = await this.lockSession(tx, eventId, sessionId);
      const [rooms, travelers] = [await this.loadRooms(tx, sessionId), await this.loadTravelers(tx, sessionId)];
      const unassigned = travelers.filter((t) => !t.room_id).length;
      const over = rooms.filter((r) => travelers.filter((t) => t.room_id === r.id && t.occupies_bed).length > r.capacity).length;
      if (!travelers.length || unassigned || over) throw new DomainError('ROOMS_NOT_READY', { unassigned, over });

      const pub = await tx.query(`SELECT snapshot FROM room_publications WHERE session_id = $1`, [sessionId]);
      const before: RoomSnapshot | null = pub.rows[0]?.snapshot ?? null;
      const after = this.buildSnapshot(rooms, travelers);
      const affected = this.affectedEmployees(before, after);
      await tx.query(
        `INSERT INTO room_publications (session_id, agency_id, snapshot, published_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (session_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, published_at = now(), published_by = EXCLUDED.published_by`,
        [sessionId, ctx.agencyId, JSON.stringify(after), ctx.user.id],
      );
      const recipients = [...new Map(travelers.filter((t) => t.email && affected.has(t.employee_id)).map((t) => [t.employee_id, t])).values()].map((t) => ({
        employee: { id: t.employee_id as string, name: t.employee_name as string, email: t.email as string },
        rooms: after.rooms.filter((r) => r.travelers.some((x) => x.employeeId === t.employee_id)).map(roomLine).join('\n'),
      }));
      return { recipients, sessionName: session.name, event: await this.notifications.mailEvent(tx, eventId) };
    });
    void this.sendAll(ctx.agencyId, eventId, result);
    return { notified: result.recipients.length };
  }

  private async sendAll(agencyId: string, eventId: string, r: { recipients: { employee: { id: string; name: string; email: string }; rooms: string }[]; sessionName: string; event: any }) {
    const queue = [...r.recipients];
    const worker = async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        await this.notifications.deliver(agencyId, eventId, r.event, m.employee, { key: 'room_published', sessionName: r.sessionName, rooms: m.rooms });
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker)).catch((err) => this.logger.error(`分房通知失敗：${(err as Error).message}`));
  }
}
