import { type CanActivate, type ExecutionContext, Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { TRIAL_LIMITS } from '@bigtours/shared';
import type { Request } from 'express';
import { AGENCY_HEADER } from './agency-path.ts';
import { DatabaseService } from './database.service.ts';
import { AGENCY_TABLES } from './demo-event.ts';
import { DomainError } from './errors.ts';
import { MailService } from './mail.service.ts';
import { StorageService } from './storage.service.ts';

const BRAND = 'Bookdex 大團報名';
const TODAY = `(now() AT TIME ZONE 'Asia/Taipei')::date`;
const CHECK_INTERVAL = 60 * 60 * 1000;

export interface TrialStatus {
  endsOn: string;
  expired: boolean;
  /** 含今天，到期當天為 1；已到期為 0 */
  daysLeft: number;
  deletesOn: string;
  mail: { total: number; today: number; totalLimit: number; dailyLimit: number };
  limits: { events: number; maxTravelers: number };
}

const siteBase = () => (process.env.WEB_BASE_URL ?? 'http://localhost:3000/{agency}').replace(/\/?\{agency\}.*$/, '');

/**
 * 試用旅行社的限制（PRD 15.3）：寄信數量、到期後唯讀、到期提醒與到期後刪除。
 * 一般旅行社（is_trial = false）不受影響。
 */
@Injectable()
export class TrialLimitsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrialLimitsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  onModuleInit() {
    if (process.env.TRIAL_JOBS_ENABLED !== 'true') return;
    const run = () => void this.runJobs().catch((e) => this.logger.error(`試用到期處理失敗：${(e as Error).message}`));
    run();
    this.timer = setInterval(run, CHECK_INTERVAL);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** 試用中才回傳狀態，一般旅行社回傳 null。 */
  async status(agencyId: string): Promise<TrialStatus | null> {
    return this.db.withTenant(agencyId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT to_char(contract_ends_on, 'YYYY-MM-DD') AS ends_on, to_char(contract_ends_on + $2::int, 'YYYY-MM-DD') AS deletes_on,
                contract_ends_on < ${TODAY} AS expired, GREATEST(contract_ends_on - ${TODAY} + 1, 0) AS days_left,
                (SELECT COALESCE(sum(sent), 0)::int FROM agency_mail_usage) AS total,
                (SELECT COALESCE(sum(sent), 0)::int FROM agency_mail_usage WHERE day = ${TODAY}) AS today
           FROM agencies WHERE id = $1 AND is_trial`,
        [agencyId, TRIAL_LIMITS.retainDays],
      );
      const r = rows[0];
      if (!r) return null;
      return {
        endsOn: r.ends_on, expired: r.expired, daysLeft: r.days_left, deletesOn: r.deletes_on,
        mail: { total: r.total, today: r.today, totalLimit: TRIAL_LIMITS.mailTotal, dailyLimit: TRIAL_LIMITS.mailPerDay },
        limits: { events: TRIAL_LIMITS.events, maxTravelers: TRIAL_LIMITS.maxTravelers },
      };
    });
  }

  /**
   * 旅行社寄出一封信之前呼叫；試用旅行社超過上限時丟出 TRIAL_MAIL_LIMIT，不寄。
   * 鎖住旅行社那一列，同時寄送的信依序計數，不會超寄。
   */
  async consumeMail(agencyId: string) {
    await this.db.withTenant(agencyId, async (tx) => {
      const { rows } = await tx.query(`SELECT is_trial FROM agencies WHERE id = $1 FOR UPDATE`, [agencyId]);
      if (!rows[0]?.is_trial) return;
      const used = await tx.query(
        `SELECT COALESCE(sum(sent), 0)::int AS total, COALESCE(sum(sent) FILTER (WHERE day = ${TODAY}), 0)::int AS today FROM agency_mail_usage`,
      );
      const { total, today } = used.rows[0];
      if (total >= TRIAL_LIMITS.mailTotal || today >= TRIAL_LIMITS.mailPerDay) {
        throw new DomainError('TRIAL_MAIL_LIMIT', { total, today, totalLimit: TRIAL_LIMITS.mailTotal, dailyLimit: TRIAL_LIMITS.mailPerDay });
      }
      await tx.query(
        `INSERT INTO agency_mail_usage (agency_id, day, sent) VALUES ($1, ${TODAY}, 1)
         ON CONFLICT (agency_id, day) DO UPDATE SET sent = agency_mail_usage.sent + 1`,
        [agencyId],
      );
    });
  }

  /** 試用已到期的旅行社（依網址代號）。 */
  async isExpiredTrial(agencyCode: string): Promise<boolean> {
    const { rows } = await this.db.pool.query(
      `SELECT is_trial AND contract_ends_on < ${TODAY} AS expired FROM agencies WHERE code = $1`,
      [agencyCode.toLowerCase()],
    );
    return !!rows[0]?.expired;
  }

  // ===== 每小時執行：到期提醒、到期通知、刪除 =====

  async runJobs() {
    await this.sendNotices();
    await this.purgeExpired();
  }

  /** 到期前 7 天、前 1 天與到期後各通知一次管理員。 */
  async sendNotices() {
    const { rows } = await this.db.pool.query(
      `SELECT id, code, name, to_char(contract_ends_on, 'YYYY-MM-DD') AS ends_on, to_char(contract_ends_on + $1::int, 'YYYY-MM-DD') AS deletes_on,
              contract_ends_on - ${TODAY} + 1 AS days_left, trial_notice_level
         FROM agencies WHERE is_trial AND status = 'active' AND contract_ends_on IS NOT NULL AND trial_notice_level < 3`,
      [TRIAL_LIMITS.retainDays],
    );
    for (const a of rows) {
      const level = a.days_left <= 0 ? 3 : a.days_left <= 1 ? 2 : a.days_left <= 7 ? 1 : 0;
      if (level <= a.trial_notice_level) continue;
      // 先標記再寄：寄信失敗不重寄，避免每小時重複寄
      const claimed = await this.db.withTenant(a.id, (tx) =>
        tx.query(`UPDATE agencies SET trial_notice_level = $2 WHERE id = $1 AND trial_notice_level < $2`, [a.id, level]));
      if (!claimed.rowCount) continue;
      await this.noticeAdmins(a, level).catch((e) => this.logger.error(`試用到期通知寄送失敗：${(e as Error).message}`));
    }
  }

  private async noticeAdmins(a: { id: string; code: string; name: string; ends_on: string; deletes_on: string; days_left: number }, level: number) {
    const admins = await this.db.withTenant(a.id, (tx) =>
      tx.query(`SELECT name, email FROM agency_users WHERE role = 'admin' AND status = 'active' AND password_hash IS NOT NULL`));
    const url = `${siteBase()}/${a.code}/admin`;
    const subject = level === 3 ? `【${BRAND}】${a.name} 的免費試用已到期` : `【${BRAND}】${a.name} 的免費試用將於 ${a.ends_on} 到期`;
    for (const u of admins.rows) {
      const lines = [
        `${u.name} 您好：`,
        level === 3
          ? `${a.name} 的免費試用已在 ${a.ends_on} 到期。後台只能查看與匯出，員工報名頁已關閉。資料會保留到 ${a.deletes_on}，之後會全部刪除。`
          : `${a.name} 的免費試用將於 ${a.ends_on} 到期（剩 ${a.days_left} 天）。到期後後台只能查看與匯出，員工報名頁會關閉，資料保留 ${TRIAL_LIMITS.retainDays} 天後刪除。`,
        '想繼續使用或轉為正式方案，請直接回覆這封信或聯絡我們。',
        url,
      ];
      await this.mail.send({
        to: u.email, fromName: BRAND, subject,
        text: lines.join('\n\n'),
        html: lines.map((l) => (l === url ? `<p><a href="${url}">${url}</a></p>` : `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`)).join(''),
      });
    }
  }

  /** 到期超過保留天數、仍是試用的旅行社整間刪除（含上傳的檔案）。試用申請紀錄保留，統編不能再申請。 */
  async purgeExpired(): Promise<string[]> {
    const { rows } = await this.db.pool.query(
      `SELECT id, code FROM agencies WHERE is_trial AND contract_ends_on + $1::int < ${TODAY}`,
      [TRIAL_LIMITS.retainDays],
    );
    const purged: string[] = [];
    for (const a of rows) {
      await this.db.withTenant(a.id, async (tx) => {
        // 再確認一次：刪除前若已轉正式或延長就跳過
        const still = await tx.query(`SELECT 1 FROM agencies WHERE id = $1 AND is_trial AND contract_ends_on + $2::int < ${TODAY} FOR UPDATE`, [a.id, TRIAL_LIMITS.retainDays]);
        if (!still.rowCount) return;
        for (const t of AGENCY_TABLES) await tx.query(`DELETE FROM ${t} WHERE agency_id = $1`, [a.id]);
        await tx.query(`DELETE FROM agencies WHERE id = $1`, [a.id]);
        purged.push(a.id);
      });
      if (purged.includes(a.id)) {
        await this.storage.removeAgency(a.id).catch((e) => this.logger.error(`刪除試用旅行社檔案失敗：${(e as Error).message}`));
        this.logger.log(`已刪除到期的試用旅行社 ${a.code}`);
      }
    }
    return purged;
  }
}

/** 試用到期後，旅行社後台與企業窗口只能查看：擋下修改，只留登入、登出、設定密碼與匯出。 */
const AGENCY_WRITE = /^\/api\/v1\/(agency|company)\//;
const STILL_ALLOWED = [
  /^\/api\/v1\/(agency|company)\/session(?:[/?]|$)/,
  /^\/api\/v1\/(agency|company)\/password-links\//,
  /^\/api\/v1\/agency\/me\/pinned-nav(?:[/?]|$)/,
  /^\/api\/v1\/agency\/events\/[^/]+\/exports(?:[/?]|$)/,
];

@Injectable()
export class TrialReadOnlyGuard implements CanActivate {
  constructor(@Inject(TrialLimitsService) private readonly trials: TrialLimitsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.method === 'GET' || req.method === 'HEAD') return true;
    const path = req.url.split('?')[0]!;
    if (!AGENCY_WRITE.test(path) || STILL_ALLOWED.some((r) => r.test(path))) return true;
    const code = req.headers[AGENCY_HEADER];
    if (typeof code !== 'string' || !code) return true;
    if (await this.trials.isExpiredTrial(code)) throw new DomainError('TRIAL_EXPIRED');
    return true;
  }
}
