import { Inject, Injectable } from '@nestjs/common';
import { pageState } from '@bigtours/shared';
import { AccessService, type AgencyInfo, type EmployeeContext } from './access.service.ts';
import { AccountService } from './account.service.ts';
import { DatabaseService } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { DomainError } from './errors.ts';

const VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';

/**
 * 向 LINE 驗證 LIFF 的 ID Token，取得 LINE 帳號識別碼。
 * 不信任前端傳來的識別碼；client_id 指定旅行社自己的 Channel，其他 Channel 簽發的 Token 會被拒絕。
 */
@Injectable()
export class LineVerifier {
  /** 測試用：取代呼叫 LINE，回傳 null 表示 Token 無效。 */
  stub: ((channelId: string, idToken: string) => string | null) | null = null;

  async verify(channelId: string, idToken: string): Promise<string> {
    if (this.stub) {
      const sub = this.stub(channelId, idToken);
      if (!sub) throw new DomainError('LINE_TOKEN_INVALID');
      return sub;
    }
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
      signal: AbortSignal.timeout(5000),
    });
    // 4xx 是 Token 無效或過期；其他狀況當作系統錯誤，不讓員工以為是自己的問題。
    if (res.status >= 400 && res.status < 500) throw new DomainError('LINE_TOKEN_INVALID');
    if (!res.ok) throw new Error(`LINE verify failed: ${res.status}`);
    const body = (await res.json()) as { sub?: unknown; aud?: unknown };
    if (typeof body.sub !== 'string' || !body.sub || body.aud !== channelId) throw new DomainError('LINE_TOKEN_INVALID');
    return body.sub;
  }
}

/** LINE 登入：員工在 LINE 裡以員工編號＋密碼綁定一次，之後自動登入。 */
@Injectable()
export class LineService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AccountService) private readonly accounts: AccountService,
    @Inject(LineVerifier) private readonly verifier: LineVerifier,
  ) {}

  /** 只存雜湊。帶入 Channel ID，換 Channel 後舊的綁定不會被誤認。 */
  private hash(agency: AgencyInfo & { line: NonNullable<AgencyInfo['line']> }, sub: string) {
    return this.encryption.hashToken(`line:${agency.line.channelId}:${sub}`);
  }

  private async lineAgency(host: string | undefined) {
    const agency = await this.access.findAgency(host);
    if (!agency.line) throw new DomainError('LINE_NOT_AVAILABLE');
    return agency as AgencyInfo & { line: NonNullable<AgencyInfo['line']> };
  }

  /** 活動要開啟 LINE 入口；活動頁關閉時與一般登入一樣不能進入。 */
  private async lineEvent(host: string | undefined, slug: string) {
    const agency = await this.lineAgency(host);
    const event = await this.access.findEvent(agency.id, slug);
    if (!event.lineEnabled) throw new DomainError('LINE_NOT_AVAILABLE');
    if (event.pageState !== 'open') throw new DomainError('PAGE_CLOSED', { pageState: event.pageState });
    return { agency, event };
  }

  /** LIFF 頁面初始化用，不需登入。 */
  async config(host: string | undefined) {
    const agency = await this.lineAgency(host);
    return { liffId: agency.line.liffId, agencyName: agency.name };
  }

  /** 旅行社共用連結：列出這個 LINE 帳號已綁定、且活動頁開啟中的活動。 */
  async boundEvents(host: string | undefined, idToken: string) {
    const agency = await this.lineAgency(host);
    const sub = await this.verifier.verify(agency.line.channelId, idToken);
    const rows = await this.db.withTenant(agency.id, async (tx) => (await tx.query(
      `SELECT e.slug, e.name, e.page_mode, e.page_is_open, e.page_opens_at, e.page_closes_at, c.name AS company_name
         FROM event_employees m JOIN events e ON e.id = m.event_id JOIN companies c ON c.id = e.company_id
        WHERE m.line_user_hash = $1 AND m.status = 'active' AND e.status IN ('published', 'closed') AND e.line_enabled
        ORDER BY e.registration_opens_at DESC NULLS LAST, e.name`,
      [this.hash(agency, sub)],
    )).rows);
    return rows
      .filter((r) => pageState({ mode: r.page_mode, isOpen: r.page_is_open, opensAt: r.page_opens_at, closesAt: r.page_closes_at }) === 'open')
      .map((r) => ({ slug: r.slug as string, name: r.name as string, companyName: r.company_name as string }));
  }

  /** 已綁定時直接登入；沒綁定時回傳 LINE_NOT_BOUND，由前台改顯示綁定表單。 */
  async login(host: string | undefined, slug: string, idToken: string) {
    const { agency, event } = await this.lineEvent(host, slug);
    const sub = await this.verifier.verify(agency.line.channelId, idToken);
    const employeeId = await this.db.withTenant(agency.id, async (tx) => (await tx.query(
      `SELECT id FROM event_employees WHERE event_id = $1 AND line_user_hash = $2 AND status = 'active'`,
      [event.id, this.hash(agency, sub)],
    )).rows[0]?.id as string | undefined);
    if (!employeeId) throw new DomainError('LINE_NOT_BOUND');
    return this.accounts.createSession(agency.id, employeeId);
  }

  /**
   * 以員工編號＋密碼綁定並登入。先驗證密碼，密碼正確才說明綁定衝突，避免透露其他員工的綁定狀態。
   * 一對一：同一活動中一個 LINE 帳號只綁一位員工，一位員工只綁一個 LINE 帳號。
   */
  async bind(host: string | undefined, slug: string, idToken: string, employeeNo: string, password: string) {
    const { agency, event } = await this.lineEvent(host, slug);
    const sub = await this.verifier.verify(agency.line.channelId, idToken);
    const employeeId = await this.accounts.authenticate(agency.id, event.id, employeeNo, password);
    const hash = this.hash(agency, sub);
    await this.db.withTenant(agency.id, async (tx) => {
      const { rows } = await tx.query(`SELECT line_user_hash FROM event_employees WHERE id = $1 FOR UPDATE`, [employeeId]);
      const current = rows[0]?.line_user_hash as Buffer | null;
      if (current?.equals(hash)) return;
      if (current) throw new DomainError('EMPLOYEE_LINE_BOUND');
      const taken = await tx.query(`SELECT 1 FROM event_employees WHERE event_id = $1 AND line_user_hash = $2 AND id <> $3`, [event.id, hash, employeeId]);
      if (taken.rowCount) throw new DomainError('LINE_ACCOUNT_IN_USE');
      await tx.query(`UPDATE event_employees SET line_user_hash = $2, line_bound_at = now(), updated_at = now() WHERE id = $1`, [employeeId, hash]);
      await tx.query(
        `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'employee', $2, 'employee.line_bound', 'event_employee', $2)`,
        [agency.id, employeeId],
      );
    }).catch((e) => {
      // 兩位員工同時用同一個 LINE 綁定時，由唯一索引擋下。
      if ((e as { constraint?: string }).constraint === 'event_employees_line_user_unique') throw new DomainError('LINE_ACCOUNT_IN_USE');
      throw e;
    });
    return this.accounts.createSession(agency.id, employeeId);
  }

  /** 我的報名顯示綁定狀態。 */
  async status(ctx: EmployeeContext) {
    const available = ctx.agency.line !== null && ctx.event.lineEnabled;
    const boundAt = await this.db.withTenant(ctx.agency.id, async (tx) => (await tx.query(
      `SELECT line_bound_at FROM event_employees WHERE id = $1`, [ctx.employee.id],
    )).rows[0]?.line_bound_at as Date | null);
    return { available, bound: boundAt !== null, boundAt };
  }

  /** 員工自行解除。解除後下次在 LINE 開啟要重新綁定，目前的登入狀態不受影響。 */
  async unbindSelf(ctx: EmployeeContext) {
    await this.db.withTenant(ctx.agency.id, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE event_employees SET line_user_hash = NULL, line_bound_at = NULL, updated_at = now() WHERE id = $1 AND line_user_hash IS NOT NULL`,
        [ctx.employee.id],
      );
      if (!rowCount) return;
      await tx.query(
        `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'employee', $2, 'employee.line_unbound', 'event_employee', $2)`,
        [ctx.agency.id, ctx.employee.id],
      );
    });
  }
}
