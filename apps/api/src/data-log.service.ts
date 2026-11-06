import { Inject, Injectable } from '@nestjs/common';
import type { AgencyUserContext } from './agency-admin.service.ts';
import { DatabaseService } from './database.service.ts';

const ACTIONS = ['registration.sensitive_viewed', 'export_sensitive', 'export_sensitive_download'];
const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DataLogQuery { event?: string; action?: string; actor?: string; days?: string; offset?: string }

/** 誰在什麼時候查看或匯出了敏感個資。紀錄本身不含個資內容，也沒有修改或刪除的功能。 */
@Injectable()
export class DataLogService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  list(ctx: AgencyUserContext, q: DataLogQuery) {
    const days = q.days === 'all' ? null : Number(q.days) === 90 ? 90 : 30;
    const offset = Math.max(Number(q.offset) || 0, 0);
    const action = q.action && ACTIONS.includes(q.action) ? [q.action] : ACTIONS;
    const eventId = q.event && UUID.test(q.event) ? q.event : null;
    const actorId = q.actor && UUID.test(q.actor) ? q.actor : null;
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT l.id, l.created_at, l.action, l.metadata, u.name AS actor_name, e.id AS event_id, e.name AS event_name,
                m.name AS employee_name, m.employee_no, s.name AS session_name,
                (SELECT count(*)::int FROM travelers t WHERE t.registration_id = r.id) AS traveler_count
           FROM audit_logs l
           LEFT JOIN agency_users u ON u.id = l.actor_id
           LEFT JOIN registrations r ON l.target_type = 'registration' AND r.id = l.target_id
           LEFT JOIN event_employees m ON m.id = r.event_employee_id
           LEFT JOIN events e ON e.id = CASE WHEN l.target_type = 'event' THEN l.target_id ELSE r.event_id END
           LEFT JOIN event_sessions s ON s.id = (l.metadata->>'sessionId')::uuid
          WHERE l.action = ANY($1::text[])
            AND ($2::uuid IS NULL OR e.id = $2)
            AND ($3::uuid IS NULL OR l.actor_id = $3)
            AND ($4::int IS NULL OR l.created_at > now() - make_interval(days => $4))
          ORDER BY l.created_at DESC, l.id DESC LIMIT $5 OFFSET $6`,
        [action, eventId, actorId, days, PAGE_SIZE + 1, offset],
      );
      const events = await tx.query(`SELECT id, name FROM events ORDER BY created_at DESC`);
      const actors = await tx.query(
        `SELECT DISTINCT u.id, u.name FROM audit_logs l JOIN agency_users u ON u.id = l.actor_id WHERE l.action = ANY($1::text[]) ORDER BY u.name`,
        [ACTIONS],
      );
      return {
        rows: rows.slice(0, PAGE_SIZE).map((l) => ({
          id: l.id, at: l.created_at, action: l.action, actorName: l.actor_name, eventName: l.event_name,
          employeeName: l.employee_name, employeeNo: l.employee_no, travelerCount: l.traveler_count,
          name: l.metadata.name ?? null, sessionName: l.session_name, rows: l.metadata.rows ?? null, fields: l.metadata.fields ?? [],
        })),
        hasMore: rows.length > PAGE_SIZE,
        events: events.rows,
        actors: actors.rows,
      };
    });
  }
}
