import { Inject, Injectable } from '@nestjs/common';
import { generateToken, hashPassword, verifyPassword } from '@bigtours/shared/crypto';
import { AccessService } from './access.service.ts';
import { DatabaseService } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { DomainError } from './errors.ts';
import { imageContentType, isImageKind, publicImages, StorageService } from './storage.service.ts';

const LINK_DAYS = 14;
const SESSION_HOURS = 12;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

// 查無帳號時也做一次相同的比對，回應時間不透露帳號是否存在
const DUMMY_HASH = hashPassword('not-a-real-password-0');

export type LinkActor = { type: 'agency_user' | 'company_contact' | 'system'; id: string | null };

@Injectable()
export class AccountService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  /** 登入頁使用，不需登入。 */
  async landing(host: string | undefined, slug: string) {
    const agency = await this.access.findAgency(host);
    const event = await this.access.findEvent(agency.id, slug);
    return {
      agency: { name: agency.name },
      event: {
        slug: event.slug,
        name: event.name,
        themeColor: event.themeColor,
        registrationOpensAt: event.registrationOpensAt,
        registrationClosesAt: event.registrationClosesAt,
        pageState: event.pageState,
        pageOpensAt: event.pageOpensAt,
        images: publicImages(event.slug, event.images),
      },
    };
  }

  async readImage(host: string | undefined, slug: string, kind: string) {
    const agency = await this.access.findAgency(host);
    const event = await this.access.findEvent(agency.id, slug);
    const key = isImageKind(kind) ? event.images[kind] : null;
    if (!key) throw new DomainError('NOT_FOUND');
    return { contentType: imageContentType(key), content: await this.storage.get(key) };
  }

  async readCompanyLogo(host: string | undefined, slug: string) {
    const agency = await this.access.findAgency(host);
    const event = await this.access.findEvent(agency.id, slug);
    if (!event.companyLogoKey) throw new DomainError('NOT_FOUND');
    return { contentType: imageContentType(event.companyLogoKey), content: await this.storage.get(event.companyLogoKey) };
  }

  /** 帳號不存在、密碼錯誤與鎖定中都回傳相同錯誤。 */
  async login(host: string | undefined, slug: string, employeeNo: string, password: string) {
    const agency = await this.access.findAgency(host);
    const event = await this.access.findEvent(agency.id, slug);
    if (event.pageState !== 'open') throw new DomainError('PAGE_CLOSED', { pageState: event.pageState });

    const employee = await this.db.withTenant(agency.id, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, password_hash, locked_until > now() AS locked FROM event_employees
          WHERE event_id = $1 AND employee_no = $2 AND status = 'active'`,
        [event.id, employeeNo],
      );
      return rows[0] as { id: string; password_hash: string | null; locked: boolean | null } | undefined;
    });

    const matched = await verifyPassword(password, employee?.password_hash ?? (await DUMMY_HASH));
    if (!employee?.password_hash || employee.locked) throw new DomainError('INVALID_CREDENTIALS');
    if (!matched) {
      await this.db.withTenant(agency.id, (tx) =>
        tx.query(
          `UPDATE event_employees
              SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
                  locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
            WHERE id = $1`,
          [employee.id, MAX_FAILED_LOGINS, LOCK_MINUTES],
        ),
      );
      throw new DomainError('INVALID_CREDENTIALS');
    }

    const token = generateToken();
    await this.db.withTenant(agency.id, async (tx) => {
      await tx.query(`UPDATE event_employees SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [employee.id]);
      await tx.query(`DELETE FROM employee_sessions WHERE event_employee_id = $1 AND expires_at <= now()`, [employee.id]);
      await tx.query(
        `INSERT INTO employee_sessions (agency_id, event_employee_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
        [agency.id, employee.id, this.encryption.hashToken(token), SESSION_HOURS],
      );
    });
    return { token, maxAgeMs: SESSION_HOURS * 3_600_000 };
  }

  async logout(host: string | undefined, token: string | undefined) {
    if (!token) return;
    const agency = await this.access.findAgency(host);
    await this.db.withTenant(agency.id, (tx) =>
      tx.query(`UPDATE employee_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [
        this.encryption.hashToken(token),
      ]),
    );
  }

  /** 開啟設定密碼頁時確認連結可用。活動頁關閉時連結仍可使用。 */
  async lookupPasswordLink(host: string | undefined, slug: string, token: string) {
    const agency = await this.access.findAgency(host);
    const event = await this.access.findEvent(agency.id, slug);
    const employee = await this.findLinkEmployee(agency.id, event.id, token);
    return {
      agency: { name: agency.name },
      event: { name: event.name, themeColor: event.themeColor },
      employee: { name: employee.name },
    };
  }

  async setPassword(host: string | undefined, slug: string, token: string, password: string) {
    const agency = await this.access.findAgency(host);
    const event = await this.access.findEvent(agency.id, slug);
    await this.findLinkEmployee(agency.id, event.id, token);
    const passwordHash = await hashPassword(password);

    return this.db.withTenant(agency.id, async (tx) => {
      // 同一筆更新同時確認與標記，連結只能成功使用一次
      const used = await tx.query(
        `UPDATE employee_password_links l SET used_at = now()
           FROM event_employees m
          WHERE l.token_hash = $1 AND l.used_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > now()
            AND m.id = l.event_employee_id AND m.event_id = $2 AND m.status = 'active'
        RETURNING m.id, m.employee_no`,
        [this.encryption.hashToken(token), event.id],
      );
      const employee = used.rows[0];
      if (!employee) throw new DomainError('LINK_INVALID');

      await tx.query(
        `UPDATE event_employees
            SET password_hash = $1, password_set_at = now(), failed_login_count = 0, locked_until = NULL, updated_at = now()
          WHERE id = $2`,
        [passwordHash, employee.id],
      );
      await tx.query(`UPDATE employee_sessions SET revoked_at = now() WHERE event_employee_id = $1 AND revoked_at IS NULL`, [
        employee.id,
      ]);
      await tx.query(
        `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'employee', $2, 'employee.password_set', 'event_employee', $2)`,
        [agency.id, employee.id],
      );
      return { employeeNo: employee.employee_no as string };
    });
  }

  /**
   * 產生設定密碼連結，舊連結立即失效，並記錄產生人與時間。
   * 回傳的連結只有這一次可取得。後台權限完成後再開放 HTTP 介面。
   */
  async issuePasswordLink(agencyId: string, employeeId: string, actor: LinkActor, delivery: 'email' | 'manual') {
    const token = generateToken();
    const expiresAt = await this.db.withTenant(agencyId, async (tx) => {
      const employee = await tx.query(`SELECT id FROM event_employees WHERE id = $1 AND status = 'active' FOR UPDATE`, [employeeId]);
      if (!employee.rowCount) throw new DomainError('NOT_FOUND');
      await tx.query(
        `UPDATE employee_password_links SET revoked_at = now()
          WHERE event_employee_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
        [employeeId],
      );
      const { rows } = await tx.query(
        `INSERT INTO employee_password_links (agency_id, event_employee_id, token_hash, delivery, created_by_type, created_by_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7)) RETURNING expires_at`,
        [agencyId, employeeId, this.encryption.hashToken(token), delivery, actor.type, actor.id, LINK_DAYS],
      );
      await tx.query(
        `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id, metadata)
         VALUES ($1, $2, $3, 'employee.password_link_issued', 'event_employee', $4, $5)`,
        [agencyId, actor.type, actor.id, employeeId, JSON.stringify({ delivery })],
      );
      return rows[0].expires_at as Date;
    });
    return { token, expiresAt };
  }

  private async findLinkEmployee(agencyId: string, eventId: string, token: string) {
    const employee = await this.db.withTenant(agencyId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT m.id, m.name FROM employee_password_links l JOIN event_employees m ON m.id = l.event_employee_id
          WHERE l.token_hash = $1 AND l.used_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > now()
            AND m.event_id = $2 AND m.status = 'active'`,
        [this.encryption.hashToken(token), eventId],
      );
      return rows[0] as { id: string; name: string } | undefined;
    });
    if (!employee) throw new DomainError('LINK_INVALID');
    return employee;
  }
}
