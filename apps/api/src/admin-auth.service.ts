import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { generateToken, hashPassword, verifyPassword } from '@bigtours/shared/crypto';
import type { Request } from 'express';
import { AccessService } from './access.service.ts';
import { DatabaseService, type Tx } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { DomainError } from './errors.ts';

export const SESSION_COOKIE = 'bt_admin';
const SESSION_HOURS = 12;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

export interface AdminContext {
  agencyId: string;
  agencyCode: string;
  agencyName: string;
  primaryColor: string | null;
  user: { id: string; name: string; email: string; role: 'admin' | 'operator' };
}

export type AdminRequest = Request & { admin: AdminContext };

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

export function requestHost(req: Request): string | undefined {
  return (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
}

@Injectable()
export class AdminAuthService {
  // 帳號不存在時也做一次雜湊，回應時間不透露帳號是否存在
  private readonly dummyHash = hashPassword('not-a-real-password');

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  private async agencyFromHost(host: string | undefined) {
    const code = this.access.agencyCodeFromHost(host);
    const { rows } = await this.db.pool.query(
      `SELECT id, code, name, primary_color FROM agencies WHERE code = $1 AND status = 'active'`,
      [code],
    );
    if (!rows[0]) throw new DomainError('NOT_FOUND');
    return rows[0] as { id: string; code: string; name: string; primary_color: string | null };
  }

  async login(host: string | undefined, email: string, password: string, ip: string | undefined) {
    const agency = await this.agencyFromHost(host);
    const found = await this.db.withTenant(agency.id, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, password_hash, status, locked_until FROM agency_users WHERE email = $1`,
        [email],
      );
      return rows[0] as { id: string; password_hash: string; status: string; locked_until: Date | null } | undefined;
    });

    const valid = await verifyPassword(password, found?.password_hash ?? (await this.dummyHash));
    if (found?.locked_until && found.locked_until.getTime() > Date.now()) throw new DomainError('ACCOUNT_LOCKED');

    if (!found || !valid || found.status !== 'active') {
      if (found) {
        await this.db.withTenant(agency.id, async (tx) => {
          await tx.query(
            `UPDATE agency_users
                SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
                    locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
              WHERE id = $1`,
            [found.id, MAX_FAILURES, LOCK_MINUTES],
          );
          await this.audit(tx, agency.id, found.id, 'admin.login_failed', 'agency_user', found.id, {}, ip);
        });
      }
      throw new DomainError('INVALID_CREDENTIALS');
    }

    const token = generateToken();
    await this.db.withTenant(agency.id, async (tx) => {
      await tx.query(`UPDATE agency_users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [found.id]);
      await tx.query(`DELETE FROM admin_sessions WHERE expires_at <= now()`);
      await tx.query(
        `INSERT INTO admin_sessions (agency_id, actor_type, actor_id, token_hash, expires_at)
         VALUES ($1, 'agency_user', $2, $3, now() + make_interval(hours => $4))`,
        [agency.id, found.id, this.encryption.hashToken(token), SESSION_HOURS],
      );
      await this.audit(tx, agency.id, found.id, 'admin.login', 'agency_user', found.id, {}, ip);
    });
    return { token, maxAgeMs: SESSION_HOURS * 3_600_000 };
  }

  async logout(host: string | undefined, token: string | undefined) {
    if (!token) return;
    const agency = await this.agencyFromHost(host);
    await this.db.withTenant(agency.id, (tx) =>
      tx.query(`DELETE FROM admin_sessions WHERE token_hash = $1`, [this.encryption.hashToken(token)]),
    );
  }

  async resolve(host: string | undefined, token: string | undefined): Promise<AdminContext> {
    if (!token) throw new DomainError('UNAUTHORIZED');
    const agency = await this.agencyFromHost(host);
    return this.db.withTenant(agency.id, async (tx) => {
      const { rows } = await tx.query(
        `SELECT u.id, u.name, u.email, u.role FROM admin_sessions s
           JOIN agency_users u ON u.id = s.actor_id AND s.actor_type = 'agency_user'
          WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`,
        [this.encryption.hashToken(token)],
      );
      if (!rows[0]) throw new DomainError('UNAUTHORIZED');
      return {
        agencyId: agency.id,
        agencyCode: agency.code,
        agencyName: agency.name,
        primaryColor: agency.primary_color,
        user: rows[0],
      };
    });
  }

  audit(tx: Tx, agencyId: string, actorId: string | null, action: string, targetType: string | null, targetId: string | null, metadata: object, ip?: string) {
    return tx.query(
      `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id, metadata, ip_address)
       VALUES ($1, 'agency_user', $2, $3, $4, $5, $6, $7)`,
      [agencyId, actorId, action, targetType, targetId, JSON.stringify(metadata), ip ?? null],
    );
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(AdminAuthService) private readonly auth: AdminAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    assertSameOrigin(req);
    req.admin = await this.auth.resolve(requestHost(req), readCookie(req, SESSION_COOKIE));
    return true;
  }
}

/** 各旅行社的子網域彼此算同站，SameSite 擋不住，所以寫入操作要再檢查 Origin。 */
export function assertSameOrigin(req: Request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (!origin) return; // 瀏覽器的跨站寫入一定會帶 Origin
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    throw new DomainError('FORBIDDEN');
  }
  if (host !== requestHost(req)?.split(',')[0]?.trim()) throw new DomainError('FORBIDDEN');
}

export { readCookie };
