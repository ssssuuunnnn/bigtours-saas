import { agencyApiPrefix } from './agency-path.ts';
import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { generateToken, hashPassword } from '@bigtours/shared/crypto';
import { AccessService } from './access.service.ts';
import type { AgencyUserContext } from './agency-admin.service.ts';
import { DatabaseService, type Tx } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { DomainError } from './errors.ts';
import { MailService } from './mail.service.ts';
import { imageContentType, imageExtension, StorageService } from './storage.service.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINK_DAYS = 14;
const siteBase = (code: string) => (process.env.WEB_BASE_URL ?? 'http://localhost:3000/{agency}').replace('{agency}', code);
const ROLE_NAME: Record<string, string> = { admin: '管理員', event_operator: '活動操作員', operations: '營運人員' };

/** 平台開第一位管理員時也走這裡，actorId 是 null。 */
export interface StaffInvite { agencyId: string; userId: string; actorId: string | null }

@Injectable()
export class StaffService {
  private readonly logger = new Logger(StaffService.name);

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  list(ctx: AgencyUserContext) {
    return this.db.withTenant(ctx.agencyId, async (tx) => {
      const { rows } = await tx.query(`SELECT id, name, email, role, status, password_hash IS NOT NULL AS activated, last_login_at FROM agency_users ORDER BY created_at`);
      return rows.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, activated: u.activated, lastLoginAt: u.last_login_at, isSelf: u.id === ctx.user.id }));
    });
  }

  /** 同一個 Email 不能同時是旅行社人員和窗口，登入時才判斷得出身分。 */
  async create(ctx: AgencyUserContext, input: { name: string; email: string; role: string }) {
    const id = await this.db.withTenant(ctx.agencyId, async (tx) => this.insertUser(tx, ctx.agencyId, input)).catch(this.emailTaken);
    await this.sendLink({ agencyId: ctx.agencyId, userId: id, actorId: ctx.user.id });
    return { id };
  }

  async insertUser(tx: Tx, agencyId: string, input: { name: string; email: string; role: string }) {
    const contact = await tx.query(`SELECT 1 FROM company_contacts WHERE email = $1`, [input.email]);
    if (contact.rowCount) throw new DomainError('EMAIL_TAKEN');
    const { rows } = await tx.query(`INSERT INTO agency_users (agency_id, email, name, role) VALUES ($1, $2, $3, $4) RETURNING id`, [agencyId, input.email, input.name, input.role]);
    return rows[0].id as string;
  }

  emailTaken = (e: unknown): never => {
    if ((e as { code?: string }).code === '23505') throw new DomainError('EMAIL_TAKEN');
    throw e;
  };

  /** 邀請或重設連結，舊連結立即失效。寄信失敗要讓操作者知道，所以等寄完才回應。 */
  async sendLink({ agencyId, userId, actorId }: StaffInvite) {
    if (!UUID.test(userId)) throw new DomainError('NOT_FOUND');
    const token = generateToken();
    const u = await this.db.withTenant(agencyId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT u.name, u.email, u.role, u.password_hash IS NOT NULL AS activated, a.code, a.name AS agency_name
           FROM agency_users u JOIN agencies a ON a.id = u.agency_id WHERE u.id = $1 AND u.status = 'active' FOR UPDATE OF u`,
        [userId],
      );
      if (!rows[0]) throw new DomainError('NOT_FOUND');
      await tx.query(`UPDATE agency_user_links SET revoked_at = now() WHERE agency_user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [userId]);
      await tx.query(
        `INSERT INTO agency_user_links (agency_id, agency_user_id, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
        [agencyId, userId, this.encryption.hashToken(token), actorId, LINK_DAYS],
      );
      await tx.query(
        `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id) VALUES ($1, $2, $3, 'staff.link_sent', 'agency_user', $4)`,
        [agencyId, actorId ? 'agency_user' : 'platform_user', actorId, userId],
      );
      return rows[0];
    });
    const url = `${siteBase(u.code)}/admin/set-password/${token}`;
    const lines = [
      `${u.name} 您好：`,
      u.activated ? `${u.agency_name} 的管理員為您發送了重設密碼連結，請點下方連結設定新密碼。` : `您已受邀加入 ${u.agency_name} 的後台，角色是${ROLE_NAME[u.role] ?? u.role}，請點下方連結設定密碼。`,
      url,
      `連結 ${LINK_DAYS} 天內有效，只能使用一次。`,
    ];
    try {
      await this.mail.send({
        to: u.email, fromName: u.agency_name,
        subject: u.activated ? `【${u.agency_name}】重設後台密碼` : `【${u.agency_name}】後台帳號邀請`,
        text: lines.join('\n\n'),
        html: lines.map((l) => (l === url ? `<p><a href="${url}">${url}</a></p>` : `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`)).join(''),
      });
    } catch (err) {
      this.logger.error(`人員邀請信失敗：${(err as Error).message}`);
      throw new DomainError('MAIL_FAILED');
    }
  }

  /** 鎖住所有啟用中的管理員，兩個管理員同時互相降級時也不會一個都不剩。 */
  private async assertKeepsAdmin(tx: Tx, userId: string) {
    const { rows } = await tx.query(`SELECT id FROM agency_users WHERE role = 'admin' AND status = 'active' AND password_hash IS NOT NULL ORDER BY id FOR UPDATE`);
    if (!rows.some((r) => r.id !== userId)) throw new DomainError('LAST_ADMIN');
  }

  private assertOther(ctx: AgencyUserContext, userId: string) {
    if (!UUID.test(userId)) throw new DomainError('NOT_FOUND');
    // 不能改自己，避免誤把自己鎖在外面。
    if (userId === ctx.user.id) throw new DomainError('CANNOT_CHANGE_SELF');
  }

  async changeRole(ctx: AgencyUserContext, userId: string, role: string) {
    this.assertOther(ctx, userId);
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      await this.assertKeepsAdmin(tx, role === 'admin' ? '' : userId);
      const { rows } = await tx.query(`SELECT role FROM agency_users WHERE id = $1 FOR UPDATE`, [userId]);
      if (!rows[0]) throw new DomainError('NOT_FOUND');
      await tx.query(`UPDATE agency_users SET role = $2 WHERE id = $1`, [userId, role]);
      await tx.query(
        `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id, metadata) VALUES ($1, 'agency_user', $2, 'staff.role_changed', 'agency_user', $3, $4)`,
        [ctx.agencyId, ctx.user.id, userId, JSON.stringify({ from: rows[0].role, to: role })],
      );
    });
  }

  /** 停用時立即登出，未使用的連結也失效。 */
  async setStatus(ctx: AgencyUserContext, userId: string, status: 'active' | 'disabled') {
    this.assertOther(ctx, userId);
    await this.db.withTenant(ctx.agencyId, async (tx) => {
      if (status === 'disabled') await this.assertKeepsAdmin(tx, userId);
      const { rowCount } = await tx.query(`UPDATE agency_users SET status = $2 WHERE id = $1`, [userId, status]);
      if (!rowCount) throw new DomainError('NOT_FOUND');
      if (status === 'disabled') {
        await tx.query(`UPDATE agency_user_sessions SET revoked_at = now() WHERE agency_user_id = $1 AND revoked_at IS NULL`, [userId]);
        await tx.query(`UPDATE agency_user_links SET revoked_at = now() WHERE agency_user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [userId]);
      }
      await tx.query(
        `INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id, metadata) VALUES ($1, 'agency_user', $2, 'staff.status_changed', 'agency_user', $3, $4)`,
        [ctx.agencyId, ctx.user.id, userId, JSON.stringify({ status })],
      );
    });
  }

  // ===== 設定密碼 =====

  async lookupLink(agencyCode: string | undefined, token: string) {
    const agency = await this.access.findAgency(agencyCode);
    const row = await this.db.withTenant(agency.id, async (tx) => (await tx.query(
      `SELECT u.name FROM agency_user_links l JOIN agency_users u ON u.id = l.agency_user_id
        WHERE l.token_hash = $1 AND l.used_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > now() AND u.status = 'active'`,
      [this.encryption.hashToken(token)],
    )).rows[0]);
    if (!row) throw new DomainError('LINK_INVALID');
    return { name: row.name as string, agencyName: agency.name };
  }

  async setPassword(agencyCode: string | undefined, token: string, password: string) {
    const agency = await this.access.findAgency(agencyCode);
    const passwordHash = await hashPassword(password);
    await this.db.withTenant(agency.id, async (tx) => {
      const used = await tx.query(
        `UPDATE agency_user_links l SET used_at = now() FROM agency_users u
          WHERE l.token_hash = $1 AND l.used_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > now() AND u.id = l.agency_user_id AND u.status = 'active'
        RETURNING u.id`,
        [this.encryption.hashToken(token)],
      );
      const id = used.rows[0]?.id;
      if (!id) throw new DomainError('LINK_INVALID');
      await tx.query(`UPDATE agency_users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1`, [id, passwordHash]);
      await tx.query(`UPDATE agency_user_sessions SET revoked_at = now() WHERE agency_user_id = $1 AND revoked_at IS NULL`, [id]);
      await tx.query(`INSERT INTO audit_logs (agency_id, actor_type, actor_id, action, target_type, target_id) VALUES ($1, 'agency_user', $2, 'staff.password_set', 'agency_user', $2)`, [agency.id, id]);
    });
  }

  // ===== 旅行社設定 =====

  async settings(agencyCode: string | undefined) {
    const agency = await this.access.findAgency(agencyCode);
    return { name: agency.name, code: agency.code, logoUrl: agency.logoObjectKey ? `${agencyApiPrefix(agency.code)}/agency/branding/logo?v=${agency.logoObjectKey.split('/').pop()}` : null };
  }

  async updateName(ctx: AgencyUserContext, name: string) {
    await this.db.pool.query(`UPDATE agencies SET name = $2, updated_at = now() WHERE id = $1`, [ctx.agencyId, name]);
  }

  async uploadLogo(ctx: AgencyUserContext, content: unknown) {
    const ext = Buffer.isBuffer(content) ? imageExtension(content) : null;
    if (!ext) throw new DomainError('INVALID_FILE');
    const key = `${ctx.agencyId}/logo-${randomBytes(6).toString('hex')}.${ext}`;
    await this.storage.put(key, content as Buffer);
    await this.db.pool.query(`UPDATE agencies SET logo_object_key = $2, updated_at = now() WHERE id = $1`, [ctx.agencyId, key]);
    return { ok: true };
  }

  async removeLogo(ctx: AgencyUserContext) {
    await this.db.pool.query(`UPDATE agencies SET logo_object_key = NULL, updated_at = now() WHERE id = $1`, [ctx.agencyId]);
  }

  /** 登入頁在登入前就要顯示。 */
  async branding(agencyCode: string | undefined) {
    const agency = await this.access.findAgency(agencyCode);
    return { name: agency.name, logoUrl: agency.logoObjectKey ? `${agencyApiPrefix(agency.code)}/agency/branding/logo?v=${agency.logoObjectKey.split('/').pop()}` : null };
  }

  async readLogo(agencyCode: string | undefined) {
    const agency = await this.access.findAgency(agencyCode);
    if (!agency.logoObjectKey) throw new DomainError('NOT_FOUND');
    return { contentType: imageContentType(agency.logoObjectKey), content: await this.storage.get(agency.logoObjectKey) };
  }
}
