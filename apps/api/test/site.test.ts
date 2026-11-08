import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { hashPassword } from '@bigtours/shared/crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { AGENCY_TABLES } from '../src/demo-event.ts';
import { DEMO_SLUG, DemoService, lastResetAt } from '../src/demo.service.ts';
import { MailService } from '../src/mail.service.ts';

let app: INestApplication;
let admin: pg.Client;
let mail: MailService;
let demo: DemoService;

const SITE = 'lvh.me';
const DEMO = 'demo.lvh.me';
const PLATFORM = 'platform.lvh.me';
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
  const res = await http().post('/api/v1/platform/session').set('x-forwarded-host', PLATFORM).send({ email, password: 'platform123' }).expect(204);
  return (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  mail = app.get(MailService);
  demo = app.get(DemoService);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('試用申請', () => {
  it('存下申請，並寄確認信給申請人', async () => {
    const body = application();
    const before = mail.sent.length;
    await apply(body).expect(204);
    const row = await q1(`SELECT * FROM trial_applications WHERE code = $1`, [body.code]);
    expect(row).toMatchObject({ agency_name: '晴天旅行社', status: 'pending', expected_size: '100～500 人' });
    if (!process.env.SMTP_URL) {
      const sent = mail.sent.slice(before).map((m) => m.to);
      expect(sent).toContain(body.email);
    }
  });

  it('只接受官網網址', async () => {
    await apply(application(), nextIp(), 'abc.lvh.me').expect(404);
    await apply(application(), nextIp(), PLATFORM).expect(404);
    await apply(application(), nextIp(), 'www.lvh.me').expect(204);
  });

  it('欄位錯誤時回報欄位名稱；沒同意不能送出', async () => {
    const r = await apply(application({ email: 'not-an-email', phone: 'abc', consent: false })).expect(422);
    expect(r.body.detail.fields).toEqual(expect.arrayContaining(['email', 'phone', 'consent']));
    await apply(application({ code: 'demo' })).expect(422);
    await apply(application({ code: 'A_B' })).expect(422);
  });

  it('網址已被使用或已有人申請時不能再申請', async () => {
    const taken = `t${randomUUID().slice(0, 8)}`;
    await q1(`INSERT INTO agencies (code, name) VALUES ($1, 'X') RETURNING id`, [taken]);
    expect((await apply(application({ code: taken })).expect(409)).body.code).toBe('CODE_UNAVAILABLE');
    const body = application();
    await apply(body).expect(204);
    expect((await apply(application({ code: body.code })).expect(409)).body.code).toBe('CODE_UNAVAILABLE');
  });

  it('網址檢查', async () => {
    const check = (code: string) => http().get(`/api/v1/site/code-check?code=${code}`).set('x-forwarded-host', SITE).set('x-forwarded-for', nextIp());
    expect((await check(`t${randomUUID().slice(0, 8)}`)).body).toEqual({ available: true });
    expect((await check('www')).body).toEqual({ available: false, reason: 'reserved' });
    expect((await check('a')).body).toEqual({ available: false, reason: 'format' });
    const body = application();
    await apply(body).expect(204);
    expect((await check(body.code)).body).toEqual({ available: false, reason: 'taken' });
  });

  it('陷阱欄位有值時假裝成功但不寫入', async () => {
    const body = application({ website: 'http://spam.example' });
    await apply(body).expect(204);
    expect(await q1(`SELECT 1 AS x FROM trial_applications WHERE code = $1`, [body.code])).toBeUndefined();
  });

  it('同一個來源一小時最多 5 筆', async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i += 1) await apply(application(), ip).expect(204);
    expect((await apply(application(), ip).expect(429)).body.code).toBe('TOO_MANY_REQUESTS');
  });

  it('跨來源的送出被擋', async () => {
    await apply(application()).set('origin', 'http://evil.lvh.me').expect(403);
  });

  it('平台後台可以查看與更新狀態；其他網址與未登入都不行', async () => {
    const body = application();
    await apply(body).expect(204);
    const cookie = await platformCookie();
    const list = await http().get('/api/v1/platform/trial-applications?status=pending').set('x-forwarded-host', PLATFORM).set('cookie', cookie).expect(200);
    const row = list.body.find((a: { code: string }) => a.code === body.code);
    expect(row).toMatchObject({ agencyName: '晴天旅行社', status: 'pending', codeTaken: false });
    await http().get('/api/v1/platform/trial-applications').set('x-forwarded-host', PLATFORM).expect(401);
    await http().get('/api/v1/platform/trial-applications').set('x-forwarded-host', SITE).set('cookie', cookie).expect(404);

    await http().patch(`/api/v1/platform/trial-applications/${row.id}`).set('x-forwarded-host', PLATFORM).set('cookie', cookie).send({ status: 'approved' }).expect(204);
    const after = await q1(`SELECT status, handled_by, handled_at FROM trial_applications WHERE id = $1`, [row.id]);
    expect(after.status).toBe('approved');
    expect(after.handled_by).not.toBeNull();
    // 處理完成後，同一個網址可以再申請
    await apply(application({ code: body.code })).expect(204);
    await http().patch(`/api/v1/platform/trial-applications/not-a-uuid`).set('x-forwarded-host', PLATFORM).set('cookie', cookie).send({ status: 'approved' }).expect(404);
  });
});

describe('公開試玩', () => {
  it('重設時間是台灣時間清晨 4 點', () => {
    expect(lastResetAt(new Date('2026-11-08T21:00:00Z')).toISOString()).toBe('2026-11-08T20:00:00.000Z');
    expect(lastResetAt(new Date('2026-11-08T19:59:00Z')).toISOString()).toBe('2026-11-07T20:00:00.000Z');
  });

  it('每位訪客取得新的員工身分，可以直接報名', async () => {
    await demo.ensureFresh();
    const start = await http().post('/api/v1/public/demo/start').set('x-forwarded-host', DEMO).set('x-forwarded-for', nextIp()).expect(201);
    expect(start.body).toEqual({ slug: DEMO_SLUG });
    const cookie = (start.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toContain(`Path=/api/v1/public/events/${DEMO_SLUG}`);
    expect(cookie).toContain('HttpOnly');

    const state = await http().get(`/api/v1/public/events/${DEMO_SLUG}`).set('x-forwarded-host', DEMO).set('cookie', cookie.split(';')[0]!).expect(200);
    expect(state.body.employee.name).toBe('試玩旅客');

    const other = await http().post('/api/v1/public/demo/start').set('x-forwarded-host', DEMO).set('x-forwarded-for', nextIp()).expect(201);
    expect((other.headers['set-cookie'] as unknown as string[])[0]).not.toBe(cookie);
  });

  it('只在 demo 網址提供；同一來源有次數上限', async () => {
    await demo.ensureFresh();
    await http().post('/api/v1/public/demo/start').set('x-forwarded-host', SITE).expect(404);
    await http().post('/api/v1/public/demo/start').set('x-forwarded-host', 'demo-travel.lvh.me').expect(404);
    const ip = nextIp();
    for (let i = 0; i < 10; i += 1) await http().post('/api/v1/public/demo/start').set('x-forwarded-host', DEMO).set('x-forwarded-for', ip).expect(201);
    await http().post('/api/v1/public/demo/start').set('x-forwarded-host', DEMO).set('x-forwarded-for', ip).expect(429);
  });

  it('過了重設時間會整個重建，試玩資料清空；沒過就不動', async () => {
    await demo.ensureFresh();
    await http().post('/api/v1/public/demo/start').set('x-forwarded-host', DEMO).set('x-forwarded-for', nextIp()).expect(201);
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
