import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { hashPassword } from '@bigtours/shared/crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApp } from '../src/agency-path.ts';
import { AppModule } from '../src/app.module.ts';
import { AGENCY_TABLES } from '../src/demo-event.ts';
import { DEMO_SLUG, DemoService, lastResetAt } from '../src/demo.service.ts';
import { MailService } from '../src/mail.service.ts';

let app: INestApplication;
let admin: pg.Client;
let mail: MailService;
let demo: DemoService;

const SITE = 'lvh.me';
const DEMO_API = `/api/v1/a/demo/public/events/${DEMO_SLUG}`;
const http = () => request(app.getHttpServer());
const q1 = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0];

let ipSeq = 0;
const ipBase = Math.floor(Math.random() * 250);
/** 每次執行、每個測試用不同的來源位址，避免互相觸發限流（申請紀錄會留在資料庫）。 */
const nextIp = () => `10.${ipBase}.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

const application = (over: Record<string, unknown> = {}) => ({
  agencyName: '晴天旅行社',
  code: `t${randomUUID().slice(0, 8)}`,
  contactName: '陳小姐',
  phone: '0912-345-678',
  email: `${randomUUID().slice(0, 8)}@example.com`,
  expectedSize: '100～500 人',
  note: '想先試一場員工旅遊',
  consent: true,
  ...over,
});

const apply = (body: object, ip = nextIp(), host = SITE) =>
  http().post('/api/v1/site/trial-applications').set('x-forwarded-host', host).set('x-forwarded-for', ip).send(body);

async function platformCookie() {
  const email = `p-${randomUUID().slice(0, 8)}@example.com`;
  await admin.query(`INSERT INTO platform_users (email, password_hash, name) VALUES ($1, $2, '王平台')`, [email, await hashPassword('platform123')]);
  const res = await http().post('/api/v1/platform/session').send({ email, password: 'platform123' }).expect(204);
  return (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  app = configureApp(await NestFactory.create(AppModule, { logger: false }));
  await app.init();
  mail = app.get(MailService);
  demo = app.get(DemoService);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('健康檢查', () => {
  it('回報服務正常，不需要網址或登入', async () => {
    expect((await http().get('/api/v1/health').expect(200)).body.ok).toBe(true);
  });
});

describe('公開試玩', () => {
  it('重設時間是台灣時間清晨 4 點', () => {
    expect(lastResetAt(new Date('2026-11-08T21:00:00Z')).toISOString()).toBe('2026-11-08T20:00:00.000Z');
    expect(lastResetAt(new Date('2026-11-08T19:59:00Z')).toISOString()).toBe('2026-11-07T20:00:00.000Z');
  });

  it('每位訪客取得新的員工身分，可以直接報名', async () => {
    await demo.ensureFresh();
    const start = await http().post('/api/v1/public/demo/start').set('x-forwarded-for', nextIp()).expect(201);
    expect(start.body).toEqual({ agency: 'demo', slug: DEMO_SLUG });
    const cookie = (start.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toContain(`Path=${DEMO_API}`);
    expect(cookie).toContain('HttpOnly');

    const state = await http().get(DEMO_API).set('cookie', cookie.split(';')[0]!).expect(200);
    expect(state.body.employee.name).toBe('試玩旅客');

    const other = await http().post('/api/v1/public/demo/start').set('x-forwarded-for', nextIp()).expect(201);
    expect((other.headers['set-cookie'] as unknown as string[])[0]).not.toBe(cookie);
  });

  it('同一來源有次數上限', async () => {
    await demo.ensureFresh();
    const ip = nextIp();
    for (let i = 0; i < 10; i += 1) await http().post('/api/v1/public/demo/start').set('x-forwarded-for', ip).expect(201);
    await http().post('/api/v1/public/demo/start').set('x-forwarded-for', ip).expect(429);
  });

  it('過了重設時間會整個重建，試玩資料清空；沒過就不動', async () => {
    await demo.ensureFresh();
    await http().post('/api/v1/public/demo/start').set('x-forwarded-for', nextIp()).expect(201);
    const before = await q1(`SELECT id FROM agencies WHERE code = 'demo'`);
    expect(await demo.ensureFresh()).toBe(false);

    await admin.query(`UPDATE agencies SET created_at = now() - interval '2 days' WHERE id = $1`, [before.id]);
    expect(await demo.ensureFresh()).toBe(true);
    const after = await q1(`SELECT id FROM agencies WHERE code = 'demo'`);
    expect(after.id).not.toBe(before.id);
    expect((await q1(`SELECT count(*)::int AS n FROM event_employees WHERE agency_id = $1`, [after.id])).n).toBe(0);
    expect((await q1(`SELECT count(*)::int AS n FROM event_employees WHERE agency_id = $1`, [before.id])).n).toBe(0);
    expect((await q1(`SELECT count(*)::int AS n FROM events WHERE agency_id = $1 AND slug = $2 AND status = 'published'`, [after.id, DEMO_SLUG])).n).toBe(1);
  });

  it('刪除旅行社的資料表清單涵蓋所有帶 agency_id 的資料表', async () => {
    const { rows } = await admin.query(
      `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE c.table_schema = 'public' AND c.column_name = 'agency_id' AND t.table_type = 'BASE TABLE'`,
    );
    const missing = rows.map((r) => r.table_name as string).filter((t) => !(AGENCY_TABLES as readonly string[]).includes(t) && t !== 'agency_quota_ledger');
    expect(missing).toEqual([]);
  });
});
