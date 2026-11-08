import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DEMO_AGENCY_CODE } from '@bigtours/shared';
import { generateToken } from '@bigtours/shared/crypto';
import { randomInt } from 'node:crypto';
import { AccessService } from './access.service.ts';
import { DatabaseService } from './database.service.ts';
import { AGENCY_TABLES, buildDemoEvent } from './demo-event.ts';
import { EncryptionService } from './encryption.service.ts';
import { DomainError } from './errors.ts';
import { RateLimiter } from './rate-limit.ts';

export const DEMO_SLUG = 'okinawa-2027';
const FIRST_SESSION_CAPACITY = 1000;
const SESSION_HOURS = 12;
/** 每天台灣時間 04:00 重設，名額與報名全部清空。 */
const RESET_HOUR_TAIPEI = 4;
const CHECK_INTERVAL = 10 * 60 * 1000;
const DAILY_VISITOR_LIMIT = 3000;

/** 最近一次（含現在）台灣時間 04:00 的時間點。 */
export function lastResetAt(now: Date): Date {
  const utcHour = (RESET_HOUR_TAIPEI - 8 + 24) % 24;
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour));
  return t.getTime() > now.getTime() ? new Date(t.getTime() - 86_400_000) : t;
}

/**
 * 官網的公開試玩：demo.平台網域 是一間示範旅行社，每位訪客按「開始試玩」就得到一個新的員工身分，
 * 不用帳號密碼。整間示範旅行社每天重建一次，所以試玩的資料最多留到隔天清晨。
 */
@Injectable()
export class DemoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DemoService.name);
  private readonly limiter = new RateLimiter(10, 10 * 60 * 1000);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  onModuleInit() {
    if (process.env.DEMO_ENABLED !== 'true') return;
    const run = () => void this.ensureFresh().catch((e) => this.logger.error(`重設試玩資料失敗：${(e as Error).message}`));
    run();
    this.timer = setInterval(run, CHECK_INTERVAL);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** 沒有示範旅行社，或建立時間早於最近一次重設時間時，重建整間示範旅行社。回傳是否有重建。 */
  async ensureFresh(now = new Date()): Promise<boolean> {
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      // 多台 API 同時檢查時只有一台會重建
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('demo-reset'))`);
      const { rows } = await client.query(`SELECT id, created_at FROM agencies WHERE code = $1`, [DEMO_AGENCY_CODE]);
      const old = rows[0] as { id: string; created_at: Date } | undefined;
      if (old && old.created_at.getTime() >= lastResetAt(now).getTime()) {
        await client.query('COMMIT');
        return false;
      }
      if (old) {
        await client.query(`SELECT set_config('app.agency_id', $1, true)`, [old.id]);
        for (const t of AGENCY_TABLES) await client.query(`DELETE FROM ${t} WHERE agency_id = $1`, [old.id]);
        await client.query(`DELETE FROM agencies WHERE id = $1`, [old.id]);
      }
      const agency: string = (await client.query(
        `INSERT INTO agencies (code, name, plan_note) VALUES ($1, '官網試玩', '官網公開試玩，每天自動重建') RETURNING id`,
        [DEMO_AGENCY_CODE],
      )).rows[0].id;
      await client.query(`SELECT set_config('app.agency_id', $1, true)`, [agency]);
      const tier = (await client.query(
        `SELECT id FROM pricing_tiers WHERE is_active AND max_travelers >= $1 ORDER BY max_travelers LIMIT 1`,
        [FIRST_SESSION_CAPACITY + 3],
      )).rows[0];
      if (!tier) throw new Error('沒有足夠大的人數級距可建立試玩活動');
      const company: string = (await client.query(`INSERT INTO companies (agency_id, name) VALUES ($1, '艾克米科技') RETURNING id`, [agency])).rows[0].id;
      const { eventId } = await buildDemoEvent((sql, params) => client.query(sql, params), agency, company, tier.id, {
        slug: DEMO_SLUG,
        firstSessionCapacity: FIRST_SESSION_CAPACITY,
        aquariumCapacity: 500,
        dinnerCapacity: 200,
      });
      await client.query(
        `INSERT INTO agency_quota_ledger (agency_id, pricing_tier_id, change, reason, note) VALUES ($1, $2, 1, 'grant', '官網試玩'), ($1, $2, -1, 'event_created', '官網試玩')`,
        [agency, tier.id],
      );
      await client.query('COMMIT');
      this.logger.log(`已重建試玩活動 ${eventId}`);
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** 每位訪客一個新的員工身分與登入狀態；只在 demo.平台網域 提供。 */
  async start(host: string | undefined, ip: string | null) {
    const agency = await this.access.findAgency(host);
    if (agency.code !== DEMO_AGENCY_CODE) throw new DomainError('NOT_FOUND');
    this.limiter.hit(ip ?? 'unknown');
    const event = await this.access.findEvent(agency.id, DEMO_SLUG).catch(() => {
      throw new DomainError('DEMO_UNAVAILABLE');
    });

    const token = generateToken();
    await this.db.withTenant(agency.id, async (tx) => {
      const count = await tx.query(`SELECT count(*)::int AS n FROM event_employees WHERE event_id = $1`, [event.id]);
      if (count.rows[0].n >= DAILY_VISITOR_LIMIT) throw new DomainError('DEMO_UNAVAILABLE');
      let employeeId: string | null = null;
      for (let attempt = 0; attempt < 5 && !employeeId; attempt += 1) {
        const employeeNo = `D${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
        const r = await tx.query(
          `INSERT INTO event_employees (agency_id, event_id, employee_no, name) VALUES ($1, $2, $3, '試玩旅客')
           ON CONFLICT DO NOTHING RETURNING id`,
          [agency.id, event.id, employeeNo],
        );
        employeeId = r.rows[0]?.id ?? null;
      }
      if (!employeeId) throw new DomainError('DEMO_UNAVAILABLE');
      await tx.query(
        `INSERT INTO employee_sessions (agency_id, event_employee_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
        [agency.id, employeeId, this.encryption.hashToken(token), SESSION_HOURS],
      );
    });
    return { slug: DEMO_SLUG, token, maxAgeMs: SESSION_HOURS * 3_600_000 };
  }
}
