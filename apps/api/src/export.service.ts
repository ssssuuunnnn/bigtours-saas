import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { can, type ExportRequest, type ExportTemplateInput } from '@bigtours/shared';
import ExcelJS from 'exceljs';
import type { AgencyUserContext } from './agency-admin.service.ts';
import { DatabaseService, type Tx } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { DomainError } from './errors.ts';
import { StorageService } from './storage.service.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEEP_DAYS = 7;
/** 系統中途重啟時，還沒做完的工作不會再繼續，超過這個時間就顯示失敗。 */
const STALE_MINUTES = 15;
const CLEANUP_INTERVAL = 60 * 60 * 1000;

type Scope = 'travelers' | 'registrations';
interface Column { key: string; label: string; sensitive: boolean; date?: boolean }

const TRAVELER_BASE: Column[] = [
  ['session', '梯次'], ['departs_on', '出發日'], ['employee_no', '員工編號'], ['employee_name', '員工姓名'], ['department', '部門'],
  ['traveler_name', '旅客姓名'], ['traveler_type', '旅客類型'],
].map(([key, label]) => ({ key: key!, label: label!, sensitive: false }));
const TRAVELER_TAIL: Column[] = [
  ['preferences', '第二、第三志願'], ['selected_room', '報名時選的房型'], ['requested_room', '希望住第幾間'], ['coworker_wish', '同房意願'],
  ['final_room', '房號'], ['final_room_type', '最終房型'], ['roommates', '同房旅客'], ['traveler_fee', '旅客費用'],
].map(([key, label]) => ({ key: key!, label: label!, sensitive: false }));
const REGISTRATION_COLUMNS: Column[] = [
  ['session', '梯次'], ['employee_no', '員工編號'], ['employee_name', '員工姓名'], ['department', '部門'], ['traveler_count', '旅客人數'],
  ['total', '整筆費用'], ['subsidy', '企業補助'], ['self_pay', '員工自付'], ['payment_status', '付款狀態'], ['paid_amount', '已付金額'], ['payment_diff', '付款差額'],
  ['reg_status', '報名狀態'], ['submitted_at', '報名時間'],
].map(([key, label]) => ({ key: key!, label: label!, sensitive: false }));

const PAYMENT: Record<string, string> = { unpaid: '未付', paid: '已付', refunded: '已退款', not_required: '無需付款' };
const REG_STATUS: Record<string, string> = { confirmed: '有效', cancel_requested: '待處理取消' };
const NUMERIC = new Set(['traveler_fee', 'traveler_count', 'total', 'subsidy', 'self_pay', 'paid_amount', 'payment_diff', 'requested_room']);

const taipei = (d: Date) => {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
};

@Injectable()
export class ExportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExportService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.cleanupAll().catch((e) => this.logger.error(`清除匯出檔失敗：${(e as Error).message}`)), CLEANUP_INTERVAL);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async catalog(tx: Tx, eventId: string, sensitiveAllowed: boolean) {
    const fields = await tx.query(`SELECT field_key, label, is_sensitive, field_type FROM event_fields WHERE event_id = $1 ORDER BY sort_order`, [eventId]);
    const groups = await tx.query(`SELECT name FROM option_groups WHERE event_id = $1 ORDER BY sort_order`, [eventId]);
    const fieldColumns: Column[] = fields.rows.filter((f) => sensitiveAllowed || !f.is_sensitive).map((f) => ({ key: `field:${f.field_key}`, label: f.label, sensitive: f.is_sensitive, date: f.field_type === 'date' }));
    // 欄位與行程用代碼和名稱當 key，範本才能跨活動共用。
    const groupColumns: Column[] = groups.rows.map((g) => ({ key: `group:${g.name}`, label: g.name, sensitive: false }));
    return { travelers: [...TRAVELER_BASE, ...fieldColumns, ...groupColumns, ...TRAVELER_TAIL], registrations: REGISTRATION_COLUMNS };
  }

  private builtinTemplates(catalog: { travelers: Column[]; registrations: Column[] }) {
    const fieldKeys = catalog.travelers.filter((c) => c.key.startsWith('field:') && !c.sensitive).map((c) => c.key);
    // 保險通常要生日和證件號碼，所以帶入日期與敏感欄位，旅行社可以再調整。
    const insuranceKeys = catalog.travelers.filter((c) => c.sensitive || c.date).map((c) => c.key);
    const groupKeys = catalog.travelers.filter((c) => c.key.startsWith('group:')).map((c) => c.key);
    return [
      { id: 'builtin:all', name: '旅客總表', scope: 'travelers' as const, columns: ['employee_no', 'employee_name', 'session', 'traveler_name', 'traveler_type', ...fieldKeys, ...groupKeys, 'selected_room', 'traveler_fee'], builtin: true },
      { id: 'builtin:rooms', name: '分房表', scope: 'travelers' as const, columns: ['session', 'final_room', 'final_room_type', 'traveler_name', 'traveler_type', 'employee_name', 'roommates', 'coworker_wish'], builtin: true },
      { id: 'builtin:insurance', name: '保險名單', scope: 'travelers' as const, columns: ['session', 'traveler_name', 'traveler_type', 'employee_no', ...insuranceKeys], builtin: true },
      { id: 'builtin:fees', name: '費用報表', scope: 'registrations' as const, columns: ['session', 'employee_no', 'employee_name', 'department', 'traveler_count', 'total', 'subsidy', 'self_pay', 'payment_status', 'payment_diff'], builtin: true },
    ];
  }

  private async assertEvent(tx: Tx, eventId: string) {
    if (!UUID.test(eventId)) throw new DomainError('NOT_FOUND');
    const { rowCount } = await tx.query(`SELECT 1 FROM events WHERE id = $1`, [eventId]);
    if (!rowCount) throw new DomainError('NOT_FOUND');
  }

  overview(ctx: AgencyUserContext, eventId: string) {
    const sensitiveAllowed = can(ctx.user.role, 'viewSensitiveData');
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertEvent(tx, eventId);
      const catalog = await this.catalog(tx, eventId, sensitiveAllowed);
      const known = { travelers: new Set(catalog.travelers.map((c) => c.key)), registrations: new Set(catalog.registrations.map((c) => c.key)) };
      const custom = await tx.query(`SELECT id, name, scope, columns FROM export_templates ORDER BY name`);
      const sessions = await tx.query(`SELECT id, name FROM event_sessions WHERE event_id = $1 ORDER BY sort_order, name`, [eventId]);
      // 管理員看得到所有人的匯出；其他人只看得到自己的，含個資的檔案也不會列給他們。
      const jobs = await tx.query(
        `SELECT j.id, j.name, j.session_id, s.name AS session_name, j.scope, j.status, j.row_count, j.contains_sensitive, j.created_at, j.expires_at, u.name AS created_by_name,
                j.status IN ('pending', 'running') AND j.created_at < now() - make_interval(mins => ${STALE_MINUTES}) AS stale
           FROM export_jobs j LEFT JOIN event_sessions s ON s.id = j.session_id LEFT JOIN agency_users u ON u.id = j.created_by
          WHERE j.event_id = $1 AND (j.expires_at IS NULL OR j.expires_at > now()) AND ($2::boolean OR j.created_by = $3)
          ORDER BY j.created_at DESC LIMIT 30`,
        [eventId, sensitiveAllowed, ctx.user.id],
      );
      return {
        catalog,
        canExportSensitive: sensitiveAllowed,
        sessions: sessions.rows,
        templates: [
          ...this.builtinTemplates(catalog),
          ...custom.rows.map((t) => ({ id: t.id, name: t.name, scope: t.scope, columns: (t.columns as string[]).filter((k) => known[t.scope as Scope].has(k)), builtin: false })),
        ],
        jobs: jobs.rows.map((j) => ({
          id: j.id, name: j.name, sessionName: j.session_name, scope: j.scope, status: j.stale ? 'failed' : j.status, rowCount: j.row_count,
          containsSensitive: j.contains_sensitive, createdAt: j.created_at, expiresAt: j.expires_at, createdByName: j.created_by_name,
        })),
      };
    });
  }

  /** 只能用這個活動有的欄位；沒有權限的人選不到敏感欄位。 */
  private resolveColumns(catalog: { travelers: Column[]; registrations: Column[] }, scope: Scope, keys: string[]) {
    return keys.map((key) => {
      const column = catalog[scope].find((c) => c.key === key);
      if (!column) throw new DomainError('INVALID_INPUT');
      return column;
    });
  }

  private async sensitiveFieldKeys(tx: Tx, eventId: string, keys: string[]) {
    const { rows } = await tx.query(`SELECT field_key FROM event_fields WHERE event_id = $1 AND is_sensitive`, [eventId]);
    return keys.filter((k) => rows.some((f) => `field:${f.field_key}` === k));
  }

  async saveTemplate(ctx: AgencyUserContext, eventId: string, input: ExportTemplateInput) {
    const allowed = can(ctx.user.role, 'viewSensitiveData');
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertEvent(tx, eventId);
      if (!allowed && (await this.sensitiveFieldKeys(tx, eventId, input.columns)).length) throw new DomainError('FORBIDDEN');
      this.resolveColumns(await this.catalog(tx, eventId, allowed), input.scope, input.columns);
      const { rows } = await tx.query(
        `INSERT INTO export_templates (agency_id, name, scope, columns, created_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (agency_id, name) DO UPDATE SET scope = EXCLUDED.scope, columns = EXCLUDED.columns RETURNING id`,
        [ctx.agencyId, input.name, input.scope, JSON.stringify(input.columns), ctx.user.id],
      );
      return { id: rows[0].id as string };
    });
  }

  async deleteTemplate(ctx: AgencyUserContext, templateId: string) {
    if (!UUID.test(templateId)) throw new DomainError('NOT_FOUND');
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      const { rowCount } = await tx.query(`DELETE FROM export_templates WHERE id = $1`, [templateId]);
      if (!rowCount) throw new DomainError('NOT_FOUND');
    });
  }

  /** 先記錄工作再回應，檔案在背景產生。含個資的匯出在這裡留下紀錄。 */
  async create(ctx: AgencyUserContext, eventId: string, input: ExportRequest) {
    const allowed = can(ctx.user.role, 'viewSensitiveData');
    const job = await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertEvent(tx, eventId);
      if (!allowed && (await this.sensitiveFieldKeys(tx, eventId, input.columns)).length) throw new DomainError('FORBIDDEN');
      const columns = this.resolveColumns(await this.catalog(tx, eventId, allowed), input.scope, input.columns);
      if (input.sessionId) {
        const found = await tx.query(`SELECT 1 FROM event_sessions WHERE id = $1 AND event_id = $2`, [input.sessionId, eventId]);
        if (!found.rowCount) throw new DomainError('NOT_FOUND');
      }
      const containsSensitive = columns.some((c) => c.sensitive);
      const { rows } = await tx.query(
        `INSERT INTO export_jobs (agency_id, event_id, name, scope, session_id, columns, contains_sensitive, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [ctx.agencyId, eventId, input.name, input.scope, input.sessionId, JSON.stringify(columns), containsSensitive, ctx.user.id],
      );
      return { id: rows[0].id as string, columns, containsSensitive };
    });
    void this.generate(ctx, eventId, job.id, input, job.columns);
    return { id: job.id };
  }

  private async generate(ctx: AgencyUserContext, eventId: string, jobId: string, input: ExportRequest, columns: Column[]) {
    try {
      const rows = await this.db.withTenant(ctx.agencyId, async (tx) => {
        await tx.query(`UPDATE export_jobs SET status = 'running' WHERE id = $1`, [jobId]);
        return input.scope === 'travelers' ? this.travelerRows(tx, eventId, input.sessionId, columns) : this.registrationRows(tx, eventId, input.sessionId);
      });
      const buffer = await this.workbook(input.name, columns, rows);
      const key = `exports/${ctx.agencyId}/${jobId}.xlsx`;
      await this.storage.put(key, buffer);
      await this.db.withTenant(ctx.agencyId, async (tx) => {
        await tx.query(
          `UPDATE export_jobs SET status = 'completed', result_object_key = $2, row_count = $3, finished_at = now(), expires_at = now() + make_interval(days => ${KEEP_DAYS}) WHERE id = $1`,
          [jobId, key, rows.length],
        );
        if (columns.some((c) => c.sensitive)) {
          await tx.query(
            `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id, metadata) VALUES ($1, 'agency_user', $2, 'export_sensitive', 'event', $3, $4)`,
            [ctx.agencyId, ctx.user.id, eventId, JSON.stringify({ jobId, name: input.name, sessionId: input.sessionId, rows: rows.length, fields: columns.filter((c) => c.sensitive).map((c) => c.label) })],
          );
        }
      });
    } catch (err) {
      this.logger.error(`匯出失敗：${(err as Error).message}`);
      await this.db.withTenant(ctx.agencyId, (tx) => tx.query(`UPDATE export_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [jobId, (err as Error).message.slice(0, 500)])).catch(() => undefined);
    }
  }

  private async travelerRows(tx: Tx, eventId: string, sessionId: string | null, columns: Column[]) {
    const needsSensitive = columns.some((c) => c.sensitive);
    const { rows } = await tx.query(
      `SELECT t.id, t.name, t.field_values, ${needsSensitive ? 't.sensitive_values_encrypted,' : ''} t.requested_room_no, t.base_price_snapshot, t.room_surcharge_snapshot, t.registration_id,
              tt.name AS type_name, s.name AS session_name, s.departs_on, s.sort_order AS session_order, m.employee_no, m.name AS employee_name, m.department,
              rt.name AS selected_room, room.id AS room_id, room.label AS room_label, frt.name AS room_type,
              COALESCE((SELECT json_agg(json_build_object('group', g.name, 'name', o.name, 'price', x.price_snapshot))
                          FROM traveler_options x JOIN options o ON o.id = x.option_id JOIN option_groups g ON g.id = o.group_id WHERE x.traveler_id = t.id), '[]') AS options,
              COALESCE((SELECT json_agg(o.name ORDER BY p.rank) FROM traveler_option_preferences p JOIN options o ON o.id = p.option_id WHERE p.traveler_id = t.id), '[]') AS preferences,
              (SELECT w.preferred_coworker_name FROM room_preferences w WHERE w.registration_id = t.registration_id AND w.requested_room_no = COALESCE(t.requested_room_no, 1)) AS wish
         FROM travelers t
         JOIN registrations r ON r.id = t.registration_id AND r.status <> 'cancelled' AND r.event_id = $1 AND ($2::uuid IS NULL OR r.session_id = $2)
         JOIN event_sessions s ON s.id = r.session_id
         JOIN traveler_types tt ON tt.id = t.traveler_type_id
         JOIN event_employees m ON m.id = r.event_employee_id
         LEFT JOIN session_room_types rt ON rt.id = t.session_room_type_id
         LEFT JOIN room_assignments a ON a.traveler_id = t.id
         LEFT JOIN rooms room ON room.id = a.room_id
         LEFT JOIN session_room_types frt ON frt.id = room.session_room_type_id
        ORDER BY s.sort_order, s.name, m.employee_no, t.sort_order`,
      [eventId, sessionId],
    );
    // 有房號欄位時依房號排，分房表才會同房的排在一起。
    if (columns.some((c) => c.key === 'final_room')) {
      rows.sort((x, y) => x.session_order - y.session_order || String(x.session_name).localeCompare(y.session_name) || String(x.room_label ?? '￿').localeCompare(y.room_label ?? '￿'));
    }
    const byRoom = new Map<string, string[]>();
    for (const t of rows) if (t.room_id) byRoom.set(t.room_id, [...(byRoom.get(t.room_id) ?? []), t.name]);

    return rows.map((t) => {
      const sensitive: Record<string, unknown> = needsSensitive && t.sensitive_values_encrypted ? this.encryption.decryptJson(t.sensitive_values_encrypted) : {};
      const options: { group: string; name: string; price: number }[] = t.options;
      const row: Record<string, unknown> = {
        session: t.session_name, departs_on: t.departs_on ?? '',
        employee_no: t.employee_no, employee_name: t.employee_name, department: t.department ?? '',
        traveler_name: t.name, traveler_type: t.type_name, preferences: t.preferences.join('、'), selected_room: t.selected_room ?? '',
        requested_room: t.requested_room_no, coworker_wish: t.wish ?? '', final_room: t.room_label ?? '', final_room_type: t.room_type ?? '',
        roommates: t.room_id ? byRoom.get(t.room_id)!.filter((n) => n !== t.name).join('、') : '',
        traveler_fee: t.base_price_snapshot + t.room_surcharge_snapshot + options.reduce((sum, o) => sum + o.price, 0),
      };
      for (const c of columns) {
        if (c.key.startsWith('field:')) {
          const name = c.key.slice(6);
          const value = c.sensitive ? sensitive[name] : t.field_values[name];
          row[c.key] = Array.isArray(value) ? value.join('、') : value ?? '';
        } else if (c.key.startsWith('group:')) {
          row[c.key] = options.filter((o) => o.group === c.key.slice(6)).map((o) => o.name).join('、');
        }
      }
      return row;
    });
  }

  private async registrationRows(tx: Tx, eventId: string, sessionId: string | null) {
    const { rows } = await tx.query(
      `SELECT r.total_amount, r.subsidy_amount, r.self_pay_amount, r.payment_status, r.paid_amount, r.status, r.submitted_at,
              s.name AS session_name, m.employee_no, m.name AS employee_name, m.department,
              (SELECT count(*)::int FROM travelers t WHERE t.registration_id = r.id) AS traveler_count
         FROM registrations r JOIN event_sessions s ON s.id = r.session_id JOIN event_employees m ON m.id = r.event_employee_id
        WHERE r.event_id = $1 AND r.status <> 'cancelled' AND ($2::uuid IS NULL OR r.session_id = $2)
        ORDER BY s.sort_order, s.name, m.employee_no`,
      [eventId, sessionId],
    );
    return rows.map((r) => ({
      session: r.session_name, employee_no: r.employee_no, employee_name: r.employee_name, department: r.department ?? '', traveler_count: r.traveler_count,
      total: r.total_amount, subsidy: Math.min(r.subsidy_amount, r.total_amount), self_pay: r.self_pay_amount, payment_status: PAYMENT[r.payment_status] ?? r.payment_status,
      paid_amount: r.paid_amount ?? '', payment_diff: r.payment_status === 'paid' && r.paid_amount !== null ? r.self_pay_amount - r.paid_amount : '',
      reg_status: REG_STATUS[r.status] ?? r.status, submitted_at: taipei(new Date(r.submitted_at)),
    })) as Record<string, unknown>[];
  }

  /** 文字一律寫成文字格式，身分證、電話開頭的 0 不會被 Excel 吃掉，也不會被當成公式。 */
  private async workbook(name: string, columns: Column[], rows: Record<string, unknown>[]) {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet(name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'export', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = columns.map((c) => ({ header: c.label, key: c.key, width: Math.max(12, c.label.length * 2 + 2) }));
    sheet.getRow(1).font = { bold: true };
    for (const row of rows) {
      const added = sheet.addRow(columns.map((c) => {
        const v = row[c.key];
        if (v === null || v === undefined) return '';
        return NUMERIC.has(c.key) ? v : String(v);
      }));
      columns.forEach((c, i) => {
        if (!NUMERIC.has(c.key)) added.getCell(i + 1).numFmt = '@';
      });
    }
    return Buffer.from(await book.xlsx.writeBuffer());
  }

  /** 別人的檔案、含個資但沒有權限、已到期都視為不存在。下載含個資的檔案也留下紀錄。 */
  async download(ctx: AgencyUserContext, eventId: string, jobId: string) {
    if (!UUID.test(jobId)) throw new DomainError('NOT_FOUND');
    const sensitiveAllowed = can(ctx.user.role, 'viewSensitiveData');
    const job = await this.db.withTenant(ctx.agencyId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT name, result_object_key, contains_sensitive, created_by, created_at FROM export_jobs
          WHERE id = $1 AND event_id = $2 AND status = 'completed' AND expires_at > now()`,
        [jobId, eventId],
      );
      const j = rows[0];
      if (!j || !j.result_object_key || (!sensitiveAllowed && (j.contains_sensitive || j.created_by !== ctx.user.id))) throw new DomainError('NOT_FOUND');
      if (j.contains_sensitive) {
        await tx.query(
          `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id, metadata) VALUES ($1, 'agency_user', $2, 'export_sensitive_download', 'event', $3, $4)`,
          [ctx.agencyId, ctx.user.id, eventId, JSON.stringify({ jobId, name: j.name })],
        );
      }
      return j;
    });
    return { name: `${job.name}-${taipei(new Date(job.created_at)).slice(0, 10)}.xlsx`, content: await this.storage.get(job.result_object_key) };
  }

  /** 到期的檔案和紀錄一起刪掉。 */
  async cleanup(agencyId: string) {
    const expired = await this.db.withTenant(agencyId, async (tx) => (await tx.query(
      `DELETE FROM export_jobs WHERE expires_at <= now() OR (expires_at IS NULL AND created_at <= now() - make_interval(days => ${KEEP_DAYS})) RETURNING result_object_key`,
    )).rows);
    for (const r of expired) if (r.result_object_key) await this.storage.delete(r.result_object_key);
    return expired.length;
  }

  private async cleanupAll() {
    const { rows } = await this.db.pool.query(`SELECT id FROM agencies`);
    for (const a of rows) await this.cleanup(a.id);
  }
}
