import { Inject, Injectable, Logger } from '@nestjs/common';
import { agencyCodeFormat, type CodeCheck, type TrialApplicationInput } from '@bigtours/shared';
import { DatabaseService } from './database.service.ts';
import { DomainError } from './errors.ts';
import { MailService } from './mail.service.ts';
import { RateLimiter } from './rate-limit.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PER_IP_PER_HOUR = 5;
const BRAND = 'Bookdex 大團報名';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface TrialApplicationRow {
  id: string;
  agencyName: string;
  code: string;
  contactName: string;
  phone: string;
  email: string;
  expectedSize: string;
  note: string | null;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: Date;
  handledAt: Date | null;
  handledByName: string | null;
  codeTaken: boolean;
}

/** 官網（平台網域本身）：試用申請。申請屬於平台，不屬於任何旅行社。 */
@Injectable()
export class SiteService {
  private readonly logger = new Logger(SiteService.name);
  private readonly checkLimiter = new RateLimiter(60, 60_000);

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  async checkCode(code: string, ip: string | null): Promise<CodeCheck> {
    this.checkLimiter.hit(ip ?? 'unknown');
    const format = agencyCodeFormat(code);
    if (!format.available) return format;
    const { rows } = await this.db.pool.query(
      `SELECT EXISTS (SELECT 1 FROM agencies WHERE code = $1) OR EXISTS (SELECT 1 FROM trial_applications WHERE code = $1 AND status = 'pending') AS taken`,
      [code],
    );
    return rows[0].taken ? { available: false, reason: 'taken' } : { available: true };
  }

  /** 機器人填了陷阱欄位時假裝成功，不寫入也不寄信。 */
  async apply(input: TrialApplicationInput, ip: string | null) {
    if (input.website) return;
    const recent = await this.db.pool.query(
      `SELECT count(*)::int AS n FROM trial_applications WHERE ip_address = $1 AND created_at > now() - interval '1 hour'`,
      [ip],
    );
    if (ip && recent.rows[0].n >= PER_IP_PER_HOUR) throw new DomainError('TOO_MANY_REQUESTS');

    const taken = await this.db.pool.query(`SELECT 1 FROM agencies WHERE code = $1`, [input.code]);
    if (taken.rowCount) throw new DomainError('CODE_UNAVAILABLE');
    try {
      await this.db.pool.query(
        `INSERT INTO trial_applications (agency_name, code, contact_name, phone, email, expected_size, note, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [input.agencyName, input.code, input.contactName, input.phone, input.email, input.expectedSize, input.note || null, ip],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new DomainError('CODE_UNAVAILABLE');
      throw err;
    }
    // 申請已存下，寄信失敗只記錄，不影響申請結果
    await this.notify(input).catch((e) => this.logger.error(`試用申請通知寄送失敗：${(e as Error).message}`));
  }

  private async notify(input: TrialApplicationInput) {
    const url = `${process.env.PLATFORM_DOMAIN}/${input.code}`;
    const lines = [
      `旅行社名稱：${input.agencyName}`,
      `想要的網址：${url}`,
      `聯絡人：${input.contactName}`,
      `手機：${input.phone}`,
      `Email：${input.email}`,
      `預計活動人數：${input.expectedSize}`,
      `想先了解的事：${input.note || '（未填）'}`,
    ];
    const notifyTo = process.env.TRIAL_NOTIFY_EMAIL;
    if (notifyTo) {
      await this.mail.send({
        to: notifyTo,
        fromName: BRAND,
        subject: `新的試用申請：${input.agencyName}`,
        text: `${lines.join('\n')}\n\n請到平台後台的「試用申請」處理。`,
        html: `<p>${lines.map(escapeHtml).join('<br>')}</p><p>請到平台後台的「試用申請」處理。</p>`,
      });
    }
    const body = [
      `${input.contactName} 您好，`,
      '',
      `我們已收到「${input.agencyName}」的 ${BRAND} 試用申請。`,
      `確認資料後會為您開通 ${url}，並用 Email 寄送登入方式。`,
      '',
      '試用 30 天，可建立一場活動，最多 100 位旅客。',
    ];
    await this.mail.send({
      to: input.email,
      fromName: BRAND,
      subject: `已收到您的 ${BRAND} 試用申請`,
      text: body.join('\n'),
      html: `<p>${body.map(escapeHtml).join('<br>')}</p>`,
    });
  }

  // ===== 平台後台 =====

  async listApplications(status: string | undefined): Promise<TrialApplicationRow[]> {
    const filter = status === 'pending' || status === 'approved' || status === 'rejected' ? status : null;
    const { rows } = await this.db.pool.query(
      `SELECT a.*, u.name AS handled_by_name, EXISTS (SELECT 1 FROM agencies g WHERE g.code = a.code) AS code_taken
         FROM trial_applications a LEFT JOIN platform_users u ON u.id = a.handled_by
        WHERE $1::text IS NULL OR a.status = $1
        ORDER BY (a.status = 'pending') DESC, a.created_at DESC LIMIT 500`,
      [filter],
    );
    return rows.map((r) => ({
      id: r.id,
      agencyName: r.agency_name,
      code: r.code,
      contactName: r.contact_name,
      phone: r.phone,
      email: r.email,
      expectedSize: r.expected_size,
      note: r.note,
      status: r.status,
      createdAt: r.created_at,
      handledAt: r.handled_at,
      handledByName: r.handled_by_name,
      codeTaken: r.code_taken,
    }));
  }

  async setStatus(actorId: string, id: string, status: 'pending' | 'approved' | 'rejected') {
    if (!UUID.test(id)) throw new DomainError('NOT_FOUND');
    try {
      const { rowCount } = await this.db.pool.query(
        `UPDATE trial_applications SET status = $2,
                handled_by = CASE WHEN $2 = 'pending' THEN NULL ELSE $3::uuid END,
                handled_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END
          WHERE id = $1`,
        [id, status, actorId],
      );
      if (!rowCount) throw new DomainError('NOT_FOUND');
    } catch (err) {
      // 改回待處理時，同一個網址已有另一筆待處理的申請
      if ((err as { code?: string }).code === '23505') throw new DomainError('CODE_UNAVAILABLE');
      throw err;
    }
  }
}
