import { Inject, Injectable, Logger } from '@nestjs/common';
import { employeeInput, lineUrl, type EmployeeInput } from '@bigtours/shared';
import { parse as parseCsv } from 'csv-parse/sync';
import { randomUUID } from 'node:crypto';
import { AccountService } from './account.service.ts';
import { DatabaseService, type Tx } from './database.service.ts';
import { DomainError } from './errors.ts';
import { NotificationService } from './notification.service.ts';

const PAGE_SIZE = 50;
const MAX_IMPORT_ROWS = 5000;
const MAX_ISSUES = 200;
const SEND_CONCURRENCY = 5;
/** 超過這段時間還沒寄出，視為失敗（例如寄送途中系統重新啟動）。 */
const STALE_MINUTES = 15;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ACCOUNT_STATES = ['activated', 'sending', 'link_issued', 'failed', 'sent', 'expired', 'no_email', 'none'] as const;

/** 每位員工的帳號狀態，寫在一處，列表、統計與篩選才會一致。 */
const ROSTER_SQL = `
  SELECT m.*,
         EXISTS (SELECT 1 FROM registrations r WHERE r.event_employee_id = m.id AND r.status <> 'cancelled') AS registered,
         CASE
           WHEN m.password_set_at IS NOT NULL THEN 'activated'
           WHEN mail.status = 'queued' AND mail.created_at > now() - make_interval(mins => ${STALE_MINUTES}) THEN 'sending'
           WHEN active.delivery = 'manual' THEN 'link_issued'
           WHEN mail.status = 'failed' OR mail.status = 'bounced' OR mail.status = 'queued' THEN 'failed'
           WHEN active.delivery = 'email' THEN 'sent'
           WHEN EXISTS (SELECT 1 FROM employee_password_links l WHERE l.event_employee_id = m.id) THEN 'expired'
           WHEN m.email IS NULL THEN 'no_email'
           ELSE 'none'
         END AS account_state
    FROM event_employees m
    LEFT JOIN LATERAL (
      SELECT status, created_at FROM email_messages e
       WHERE e.event_employee_id = m.id AND e.template_key = 'account' ORDER BY e.created_at DESC LIMIT 1
    ) mail ON true
    LEFT JOIN LATERAL (
      SELECT delivery FROM employee_password_links l
       WHERE l.event_employee_id = m.id AND l.used_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > now() LIMIT 1
    ) active ON true
   WHERE m.event_id = $1 AND m.status = 'active'`;

const employeeRow = (r: any) => ({
  id: r.id,
  employeeNo: r.employee_no,
  name: r.name,
  email: r.email,
  department: r.department,
  subsidyAmount: r.subsidy_amount,
  dependentLimit: r.dependent_limit,
  accountState: r.account_state,
  registered: r.registered,
  activated: r.password_set_at !== null,
  lineBound: r.line_bound_at !== null,
});

export interface ImportIssue { row: number; employeeNo: string; name: string; code: string; value?: string; firstRow?: number }
interface ImportRow extends EmployeeInput { row: number }

/** Excel 另存的 CSV 在繁中 Windows 常是 Big5，其他多半是 UTF-8。 */
export function decodeCsv(content: Buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/^﻿/, '');
  } catch {
    try {
      return new TextDecoder('big5', { fatal: true }).decode(content);
    } catch {
      throw new DomainError('INVALID_FILE');
    }
  }
}

const HEADERS = { employeeNo: '員工編號', name: '姓名', department: '部門', email: 'Email', subsidyAmount: '補助金額', dependentLimit: '眷屬人數上限' } as const;

/** 解析與檢查都在這裡，預覽與匯入才會得到相同的結果。 */
export function parseRoster(content: unknown) {
  if (!Buffer.isBuffer(content) || content.length === 0) throw new DomainError('INVALID_FILE');
  let records: string[][];
  try {
    records = parseCsv(decodeCsv(content), { relax_column_count: true, skip_empty_lines: true, trim: true }) as string[][];
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw new DomainError('INVALID_FILE');
  }
  const header = records[0] ?? [];
  const col = (label: string) => header.findIndex((h) => h.toLowerCase() === label.toLowerCase());
  const index = {
    employeeNo: col(HEADERS.employeeNo), name: col(HEADERS.name), department: col(HEADERS.department),
    email: col(HEADERS.email), subsidyAmount: col(HEADERS.subsidyAmount), dependentLimit: col(HEADERS.dependentLimit),
  };
  if (index.employeeNo < 0 || index.name < 0) throw new DomainError('CSV_BAD_HEADER');
  const data = records.slice(1);
  if (data.length > MAX_IMPORT_ROWS) throw new DomainError('CSV_TOO_MANY_ROWS', { max: MAX_IMPORT_ROWS });

  const rows: ImportRow[] = [];
  const issues: ImportIssue[] = [];
  const seen = new Map<string, number>();
  let errors = 0;
  let duplicates = 0;
  const number = (v: string) => {
    const cleaned = v.replace(/[$,\s]/g, '');
    return /^\d+$/.test(cleaned) ? Number(cleaned) : null;
  };
  data.forEach((rec, i) => {
    const row = i + 2;
    const at = (c: number) => (c >= 0 ? rec[c] ?? '' : '');
    const employeeNo = at(index.employeeNo);
    const name = at(index.name);
    const fail = (code: string, value?: string) => {
      errors += 1;
      issues.push({ row, employeeNo, name, code, ...(value === undefined ? {} : { value }) });
    };
    if (!employeeNo) return fail('MISSING_NO');
    if (!name) return fail('MISSING_NAME');
    const first = seen.get(employeeNo);
    if (first !== undefined) {
      duplicates += 1;
      issues.push({ row, employeeNo, name, code: 'DUPLICATE', firstRow: first });
      return;
    }
    const email = at(index.email);
    const subsidy = at(index.subsidyAmount);
    const limit = at(index.dependentLimit);
    const subsidyAmount = subsidy ? number(subsidy) : null;
    const dependentLimit = limit ? number(limit) : null;
    if (subsidy && subsidyAmount === null) return fail('BAD_SUBSIDY', subsidy);
    if (limit && dependentLimit === null) return fail('BAD_LIMIT', limit);
    const parsed = employeeInput.safeParse({
      employeeNo, name, email: email || null, department: at(index.department) || null, subsidyAmount, dependentLimit,
    });
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path[0];
      if (path === 'email') return fail('BAD_EMAIL', email);
      if (path === 'subsidyAmount') return fail('BAD_SUBSIDY', subsidy);
      if (path === 'dependentLimit') return fail('BAD_LIMIT', limit);
      return fail('TOO_LONG');
    }
    seen.set(employeeNo, row);
    rows.push({ ...parsed.data, row });
  });
  return { rows, issues, errors, duplicates, hasEmailColumn: index.email >= 0, hasDepartmentColumn: index.department >= 0 };
}

/** 旅行社人員和企業窗口都會操作名單；紀錄要分得出是誰。 */
export interface RosterContext { agencyId: string; user: { id: string; name: string }; actorType?: 'company_contact' }

@Injectable()
export class RosterService {
  private readonly logger = new Logger(RosterService.name);

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AccountService) private readonly accounts: AccountService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  private async assertEvent(tx: Tx, eventId: string, forUpdate = false) {
    if (!UUID.test(eventId)) throw new DomainError('NOT_FOUND');
    const { rows } = await tx.query(
      `SELECT e.id, e.company_id, e.name, e.slug, e.registration_opens_at, e.default_subsidy_amount, e.default_dependent_limit, e.line_enabled, a.code AS agency_code, a.name AS agency_name, a.line_liff_id
         FROM events e JOIN agencies a ON a.id = e.agency_id WHERE e.id = $1${forUpdate ? ' FOR UPDATE OF e' : ''}`,
      [eventId],
    );
    if (!rows[0]) throw new DomainError('NOT_FOUND');
    return rows[0];
  }

  // ===== 列表 =====

  list(ctx: RosterContext, eventId: string, q: { search?: string; account?: string; registration?: string; line?: string; page?: number }) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const event = await this.assertEvent(tx, eventId);
      const page = Math.max(1, Math.floor(q.page ?? 1) || 1);
      const params: unknown[] = [eventId];
      const where: string[] = [];
      if (q.search?.trim()) {
        params.push(`%${q.search.trim().replace(/[\\%_]/g, '\\$&')}%`);
        where.push(`(employee_no ILIKE $${params.length} OR name ILIKE $${params.length} OR email::text ILIKE $${params.length})`);
      }
      if (q.account && (ACCOUNT_STATES as readonly string[]).includes(q.account)) {
        params.push(q.account);
        where.push(`account_state = $${params.length}`);
      }
      if (q.registration === 'registered') where.push('registered');
      if (q.registration === 'unregistered') where.push('NOT registered');
      if (q.line === 'bound') where.push('line_bound_at IS NOT NULL');
      if (q.line === 'unbound') where.push('line_bound_at IS NULL');
      const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { rows } = await tx.query(
        `SELECT *, count(*) OVER()::int AS total_count FROM (${ROSTER_SQL}) x ${filter} ORDER BY employee_no LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
        params,
      );
      const { rows: counts } = await tx.query(`SELECT account_state, count(*)::int AS n FROM (${ROSTER_SQL}) x GROUP BY account_state`, [eventId]);
      const { rows: bound } = await tx.query(`SELECT count(*)::int AS n FROM event_employees WHERE event_id = $1 AND status = 'active' AND line_bound_at IS NOT NULL`, [eventId]);
      const summary = Object.fromEntries(ACCOUNT_STATES.map((s) => [s, counts.find((c) => c.account_state === s)?.n ?? 0]));
      return {
        rows: rows.map(employeeRow),
        total: rows[0]?.total_count ?? 0,
        page,
        pageSize: PAGE_SIZE,
        summary,
        rosterTotal: counts.reduce((sum, c) => sum + c.n, 0),
        defaults: { subsidyAmount: event.default_subsidy_amount, dependentLimit: event.default_dependent_limit },
        line: this.lineInfo(event, bound[0].n),
      };
    });
  }

  // ===== 新增、修改、移除 =====

  create(ctx: RosterContext, eventId: string, input: EmployeeInput) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertEvent(tx, eventId, true);
      const { rows: found } = await tx.query(`SELECT id, status FROM event_employees WHERE event_id = $1 AND employee_no = $2`, [eventId, input.employeeNo]);
      if (found[0]?.status === 'active') throw new DomainError('DUPLICATE_EMPLOYEE_NO');
      // 移除過的員工重新加入時沿用同一筆，原本的帳號不會復活。
      const { rows } = found[0]
        ? await tx.query(
          `UPDATE event_employees SET name = $2, email = $3, department = $4, subsidy_amount = $5, dependent_limit = $6, status = 'active',
                  password_hash = NULL, password_set_at = NULL, failed_login_count = 0, locked_until = NULL,
                  line_user_hash = NULL, line_bound_at = NULL, updated_at = now()
            WHERE id = $1 RETURNING id`,
          [found[0].id, input.name, input.email, input.department, input.subsidyAmount, input.dependentLimit],
        )
        : await tx.query(
          `INSERT INTO event_employees (agency_id, event_id, employee_no, name, email, department, subsidy_amount, dependent_limit)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [ctx.agencyId, eventId, input.employeeNo, input.name, input.email, input.department, input.subsidyAmount, input.dependentLimit],
        );
      return { id: rows[0].id as string };
    });
  }

  async update(ctx: RosterContext, eventId: string, employeeId: string, input: EmployeeInput) {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      const event = await this.assertEvent(tx, eventId, true);
      const current = await this.lockEmployee(tx, eventId, employeeId);
      if (input.employeeNo !== current.employee_no) {
        // 員工編號是登入帳號：開通或報名後不能改。
        if (current.password_set_at || current.has_registration) throw new DomainError('EMPLOYEE_NO_LOCKED');
        const { rowCount } = await tx.query(`SELECT 1 FROM event_employees WHERE event_id = $1 AND employee_no = $2 AND id <> $3`, [eventId, input.employeeNo, employeeId]);
        if (rowCount) throw new DomainError('DUPLICATE_EMPLOYEE_NO');
      }
      await tx.query(
        `UPDATE event_employees SET employee_no = $2, name = $3, email = $4, department = $5, subsidy_amount = $6, dependent_limit = $7, updated_at = now() WHERE id = $1`,
        [employeeId, input.employeeNo, input.name, input.email, input.department, input.subsidyAmount, input.dependentLimit],
      );
      await this.auditSubsidy(tx, ctx, event, [{ id: employeeId, from: current.subsidy_amount, to: input.subsidyAmount }]);
    });
  }

  /** 已報名的員工不能移除；移除後立即不能登入，舊連結失效。 */
  async remove(ctx: RosterContext, eventId: string, employeeId: string) {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertEvent(tx, eventId, true);
      const current = await this.lockEmployee(tx, eventId, employeeId);
      if (current.has_registration) throw new DomainError('EMPLOYEE_HAS_REGISTRATION');
      if (current.has_active_hold) throw new DomainError('EMPLOYEE_HAS_REGISTRATION');
      await tx.query(`UPDATE employee_password_links SET revoked_at = now() WHERE event_employee_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [employeeId]);
      await tx.query(`DELETE FROM employee_sessions WHERE event_employee_id = $1`, [employeeId]);
      // 移除後 LINE 綁定一併刪除。
      await tx.query(`UPDATE event_employees SET status = 'removed', line_user_hash = NULL, line_bound_at = NULL, updated_at = now() WHERE id = $1`, [employeeId]);
      await tx.query(
        `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id) VALUES ($1, '${ctx.actorType ?? 'agency_user'}', $2, 'employee.removed', 'event_employee', $3)`,
        [ctx.agencyId, ctx.user.id, employeeId],
      );
    });
  }

  /** 旅行社設定 LINE、且活動開啟 LINE 入口時才提供連結；未開啟時名單仍顯示既有的綁定，方便解除。 */
  private lineInfo(event: any, boundCount: number) {
    const available = event.line_liff_id !== null && event.line_enabled;
    return { available, url: available ? lineUrl(event.line_liff_id, event.slug) : null, boundCount };
  }

  /** 旅行社人員與企業窗口都可以解除，例如員工的 LINE 被別人綁走時。 */
  async unbindLine(ctx: RosterContext, eventId: string, employeeId: string) {
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertEvent(tx, eventId);
      await this.lockEmployee(tx, eventId, employeeId);
      const { rowCount } = await tx.query(
        `UPDATE event_employees SET line_user_hash = NULL, line_bound_at = NULL, updated_at = now() WHERE id = $1 AND line_user_hash IS NOT NULL`,
        [employeeId],
      );
      if (!rowCount) return;
      await tx.query(
        `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id) VALUES ($1, $2, $3, 'employee.line_unbound', 'event_employee', $4)`,
        [ctx.agencyId, ctx.actorType ?? 'agency_user', ctx.user.id, employeeId],
      );
    });
  }

  private async lockEmployee(tx: Tx, eventId: string, employeeId: string) {
    if (!UUID.test(employeeId)) throw new DomainError('NOT_FOUND');
    const { rows } = await tx.query(
      `SELECT m.employee_no, m.subsidy_amount, m.password_set_at,
              EXISTS (SELECT 1 FROM registrations r WHERE r.event_employee_id = m.id AND r.status <> 'cancelled') AS has_registration,
              EXISTS (SELECT 1 FROM seat_holds h WHERE h.event_employee_id = m.id AND h.status = 'active' AND h.expires_at > now()) AS has_active_hold
         FROM event_employees m WHERE m.id = $1 AND m.event_id = $2 AND m.status = 'active' FOR UPDATE`,
      [employeeId, eventId],
    );
    if (!rows[0]) throw new DomainError('NOT_FOUND');
    return rows[0];
  }

  /** 報名開始後修改補助金額要留下修改人與時間。 */
  private async auditSubsidy(tx: Tx, ctx: RosterContext, event: any, changes: { id: string; from: number | null; to: number | null }[]) {
    if (!event.registration_opens_at || new Date(event.registration_opens_at) > new Date()) return;
    for (const c of changes) {
      if (c.from === c.to) continue;
      await tx.query(
        `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id, metadata)
         VALUES ($1, '${ctx.actorType ?? 'agency_user'}', $2, 'employee.subsidy_changed', 'event_employee', $3, $4)`,
        [ctx.agencyId, ctx.user.id, c.id, JSON.stringify({ from: c.from, to: c.to })],
      );
    }
  }

  // ===== CSV 匯入 =====

  previewImport(ctx: RosterContext, eventId: string, content: unknown) {
    const parsed = parseRoster(content);
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertEvent(tx, eventId);
      const { rows } = await tx.query(`SELECT employee_no FROM event_employees WHERE event_id = $1 AND status = 'active'`, [eventId]);
      const existing = new Set(rows.map((r) => r.employee_no as string));
      const updates = parsed.rows.filter((r) => existing.has(r.employeeNo)).length;
      return {
        newCount: parsed.rows.length - updates,
        updateCount: updates,
        errorCount: parsed.errors,
        duplicateCount: parsed.duplicates,
        issues: parsed.issues.slice(0, MAX_ISSUES),
        issuesTruncated: parsed.issues.length > MAX_ISSUES,
      };
    });
  }

  /** 檔案沒有的欄位不動；留空的補助與眷屬上限改回套用活動預設。帳號信不會自動寄出。 */
  import(ctx: RosterContext, eventId: string, content: unknown) {
    const parsed = parseRoster(content);
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const event = await this.assertEvent(tx, eventId, true);
      const { rows: current } = await tx.query(`SELECT id, employee_no, status, subsidy_amount, email, department, password_set_at FROM event_employees WHERE event_id = $1`, [eventId]);
      const byNo = new Map(current.map((r) => [r.employee_no as string, r]));
      const changes: { id: string; from: number | null; to: number | null }[] = [];
      let created = 0;
      let updated = 0;
      for (const r of parsed.rows) {
        const found = byNo.get(r.employeeNo);
        if (!found) {
          await tx.query(
            `INSERT INTO event_employees (agency_id, event_id, employee_no, name, email, department, subsidy_amount, dependent_limit)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [ctx.agencyId, eventId, r.employeeNo, r.name, r.email, r.department, r.subsidyAmount, r.dependentLimit],
          );
          created += 1;
          continue;
        }
        const revive = found.status !== 'active';
        await tx.query(
          `UPDATE event_employees SET name = $2, email = $3, department = $4, subsidy_amount = $5, dependent_limit = $6, status = 'active', updated_at = now(),
                  password_hash = CASE WHEN $7 THEN NULL ELSE password_hash END,
                  password_set_at = CASE WHEN $7 THEN NULL ELSE password_set_at END
            WHERE id = $1`,
          [found.id, r.name, parsed.hasEmailColumn ? r.email : found.email, parsed.hasDepartmentColumn ? r.department : found.department, r.subsidyAmount, r.dependentLimit, revive],
        );
        if (revive) {
          created += 1;
        } else {
          updated += 1;
          changes.push({ id: found.id, from: found.subsidy_amount, to: r.subsidyAmount });
        }
      }
      await this.auditSubsidy(tx, ctx, event, changes);
      await tx.query(
        `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id, metadata)
         VALUES ($1, '${ctx.actorType ?? 'agency_user'}', $2, 'employee.imported', 'event', $3, $4)`,
        [ctx.agencyId, ctx.user.id, eventId, JSON.stringify({ created, updated, errors: parsed.errors, duplicates: parsed.duplicates })],
      );
      return { created, updated, errorCount: parsed.errors, duplicateCount: parsed.duplicates };
    });
  }

  // ===== 從其他活動複製 =====

  /** 只能從同一家企業的活動複製，避免名單跨企業。 */
  copySources(ctx: RosterContext, eventId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const event = await this.assertEvent(tx, eventId);
      const { rows } = await tx.query(
        `SELECT e.id, e.name, (SELECT count(*)::int FROM event_employees m WHERE m.event_id = e.id AND m.status = 'active') AS employees
           FROM events e WHERE e.company_id = $1 AND e.id <> $2 ORDER BY e.created_at DESC`,
        [event.company_id, eventId],
      );
      return rows.filter((r) => r.employees > 0);
    });
  }

  /** 已在名單內的員工編號不動；密碼不帶過去，帳號不跨活動共用。 */
  copyFrom(ctx: RosterContext, eventId: string, fromEventId: string) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const event = await this.assertEvent(tx, eventId, true);
      const { rows: sources } = await tx.query(`SELECT id FROM events WHERE id = $1 AND company_id = $2 AND id <> $3`, [fromEventId, event.company_id, eventId]);
      if (!sources[0]) throw new DomainError('NOT_FOUND');
      const { rowCount } = await tx.query(
        `INSERT INTO event_employees (agency_id, event_id, employee_no, name, email, department, subsidy_amount, dependent_limit)
         SELECT agency_id, $1, employee_no, name, email, department, subsidy_amount, dependent_limit
           FROM event_employees WHERE event_id = $2 AND status = 'active'
         ON CONFLICT (event_id, employee_no) DO NOTHING`,
        [eventId, fromEventId],
      );
      const { rows } = await tx.query(`SELECT count(*)::int AS n FROM event_employees WHERE event_id = $1 AND status = 'active'`, [fromEventId]);
      return { added: rowCount ?? 0, skipped: rows[0].n - (rowCount ?? 0) };
    });
  }

  // ===== 帳號信與連結 =====

  /** 產生後舊連結立即失效；有信箱的員工會收到通知，信中不含連結。 */
  async issueLink(ctx: RosterContext, eventId: string, employeeId: string) {
    const r = await this.db.withTenant(ctx.agencyId, async (tx) => {
      const event = await this.assertEvent(tx, eventId);
      await this.lockEmployee(tx, eventId, employeeId);
      const { rows } = await tx.query(`SELECT name, email FROM event_employees WHERE id = $1`, [employeeId]);
      return { event, employee: rows[0] };
    });
    const { token, expiresAt } = await this.accounts.issuePasswordLink(ctx.agencyId, employeeId, { type: ctx.actorType ?? 'agency_user', id: ctx.user.id }, 'manual');
    const notified = r.employee.email !== null;
    if (notified) {
      void this.notifications.deliver(ctx.agencyId, eventId, r.event, { id: employeeId, name: r.employee.name, email: r.employee.email }, { key: 'link_notice' });
    }
    return { token, slug: r.event.slug as string, expiresAt, notified, issuedBy: ctx.user.name };
  }

  /**
   * 先記錄「寄送中」再回應，實際寄送在背景進行，上千封也不會讓畫面等待。
   * 連結只存在記憶體，所以系統中途重啟時，沒寄出的員工會顯示寄送失敗，可以重寄。
   */
  async sendAccountEmails(ctx: RosterContext, eventId: string, input: { employeeIds?: string[]; allPending?: boolean }) {
    const { event, recipients, skipped } = await this.db.withTenant(ctx.agencyId, async (tx) => {
      const event = await this.assertEvent(tx, eventId);
      const states = input.allPending ? ['none', 'failed', 'expired'] : null;
      const { rows } = await tx.query(
        `SELECT id, name, email, account_state FROM (${ROSTER_SQL}) x
          WHERE ${states ? `account_state = ANY($2::text[])` : `id = ANY($2::uuid[])`}`,
        [eventId, states ?? input.employeeIds ?? []],
      );
      const recipients = rows.filter((r) => r.email !== null && r.account_state !== 'sending');
      for (const r of recipients) {
        await tx.query(
          `INSERT INTO email_messages (agency_id, event_id, event_employee_id, recipient_email, template_key, idempotency_key)
           VALUES ($1, $2, $3, $4, 'account', $5)`,
          [ctx.agencyId, eventId, r.id, r.email, randomUUID()],
        );
      }
      return { event, recipients, skipped: rows.length - recipients.length };
    });
    void this.sendInBackground(ctx, eventId, event, recipients);
    return { queued: recipients.length, skipped };
  }

  private async sendInBackground(ctx: RosterContext, eventId: string, event: any, recipients: any[]) {
    const queue = [...recipients];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        try {
          const { token } = await this.accounts.issuePasswordLink(ctx.agencyId, r.id, { type: ctx.actorType ?? 'agency_user', id: ctx.user.id }, 'email');
          await this.notifications.deliver(ctx.agencyId, eventId, event, r, { key: 'account', token }, true);
        } catch (err) {
          this.logger.error(`帳號信處理失敗：${(err as Error).message}`);
          await this.notifications.markLatest(ctx.agencyId, r.id, 'account', 'failed', (err as Error).message.slice(0, 500));
        }
      }
    };
    await Promise.all(Array.from({ length: SEND_CONCURRENCY }, worker));
  }
}
