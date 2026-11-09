import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { generateToken, hashPassword, hashToken } from '@bigtours/shared/crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountService } from '../src/account.service.ts';
import { AppModule } from '../src/app.module.ts';
import { LineVerifier } from '../src/line.service.ts';
import { MailService } from '../src/mail.service.ts';

const PASSWORD = 'abcd1234';
const CHANNEL = '1234567890';
const LIFF = '1234567890-AbCdEfGh';
let app: INestApplication;
let admin: pg.Client;
let tierId: string;
let knownHash: string;

const q1 = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0];
/** 測試用 ID Token：`tok:<Channel ID>:<LINE 帳號>`，其他 Channel 的 Token 驗證失敗。 */
const tokenFor = (user: string, channel = CHANNEL) => `tok:${channel}:${user}`;

interface Opts { line?: boolean; eventLine?: boolean; pageOpen?: boolean; slug?: string }

async function makeAgency(line = true) {
  const code = `l-${randomUUID().slice(0, 8)}`;
  const agencyId = (await q1(
    `INSERT INTO agencies (code, name, line_channel_id, line_liff_id) VALUES ($1, 'T', $2, $3) RETURNING id`,
    [code, line ? CHANNEL : null, line ? LIFF : null],
  )).id as string;
  const company = (await q1(`INSERT INTO companies (agency_id, name) VALUES ($1, '企業') RETURNING id`, [agencyId])).id as string;
  return { agencyId, company, code, host: `${code}.lvh.me` };
}
type Ag = Awaited<ReturnType<typeof makeAgency>>;

async function makeEvent(a: Ag, o: Opts = {}) {
  const slug = o.slug ?? 'evt';
  const eventId = (await q1(
    `INSERT INTO events (agency_id, company_id, slug, name, status, pricing_tier_id, registration_opens_at, registration_closes_at, page_mode, page_is_open, line_enabled)
     VALUES ($1, $2, $3, $4, 'published', $5, now() - interval '1 day', now() + interval '30 days', 'manual', $6, $7) RETURNING id`,
    [a.agencyId, a.company, slug, `活動 ${slug}`, tierId, o.pageOpen ?? true, o.eventLine ?? true],
  )).id as string;
  return { ...a, eventId, slug };
}
type Ev = Awaited<ReturnType<typeof makeEvent>>;

async function makeEmployee(e: Ev, no = 'E001', passwordHash: string | null = knownHash) {
  return (await q1(
    `INSERT INTO event_employees (agency_id, event_id, employee_no, name, email, password_hash, password_set_at)
     VALUES ($1, $2, $3, '王小明', $4, $5, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END) RETURNING id`,
    [e.agencyId, e.eventId, no, `${no}-${randomUUID().slice(0, 6)}@example.com`, passwordHash],
  )).id as string;
}

const http = () => request(app.getHttpServer());
const on = (host: string, r: request.Test) => r.set('x-forwarded-host', host);
const base = (e: Ev) => `/api/v1/public/events/${e.slug}`;
const lineLogin = (e: Ev, idToken: string) => on(e.host, http().post(`${base(e)}/line-session`)).send({ idToken });
const bind = (e: Ev, idToken: string, employeeNo = 'E001', password = PASSWORD) =>
  on(e.host, http().post(`${base(e)}/line-binding`)).send({ idToken, employeeNo, password });
const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
const boundAt = async (id: string) => (await q1(`SELECT line_bound_at FROM event_employees WHERE id = $1`, [id])).line_bound_at;

async function agencyUser(a: Ag, role = 'admin') {
  const userId = (await q1(
    `INSERT INTO agency_users (agency_id, email, password_hash, name, role) VALUES ($1, $2, $3, '承辦', $4) RETURNING id`,
    [a.agencyId, `${role}-${randomUUID().slice(0, 6)}@example.com`, knownHash, role],
  )).id;
  const token = generateToken();
  await admin.query(`INSERT INTO agency_user_sessions (agency_id, agency_user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [a.agencyId, userId, hashToken(process.env.TOKEN_HASH_KEY!, token)]);
  const cookie = `bt_agency_session=${token}`;
  const h = (r: request.Test) => r.set('x-forwarded-host', a.host).set('cookie', cookie);
  return {
    get: (p: string) => h(http().get(`/api/v1/agency${p}`)),
    put: (p: string, body: object) => h(http().put(`/api/v1/agency${p}`)).send(body),
    del: (p: string) => h(http().delete(`/api/v1/agency${p}`)),
  };
}

async function contactUser(a: Ag) {
  const id = (await q1(
    `INSERT INTO company_contacts (agency_id, company_id, email, name, password_hash) VALUES ($1, $2, $3, '窗口', $4) RETURNING id`,
    [a.agencyId, a.company, `c-${randomUUID().slice(0, 6)}@example.com`, knownHash],
  )).id;
  const token = generateToken();
  await admin.query(`INSERT INTO company_contact_sessions (agency_id, contact_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [a.agencyId, id, hashToken(process.env.TOKEN_HASH_KEY!, token)]);
  const h = (r: request.Test) => r.set('x-forwarded-host', a.host).set('cookie', `bt_contact_session=${token}`);
  return {
    get: (p: string) => h(http().get(`/api/v1/company${p}`)),
    del: (p: string) => h(http().delete(`/api/v1/company${p}`)),
  };
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  tierId = (await q1(`INSERT INTO pricing_tiers (min_travelers, max_travelers, price_amount) VALUES (1, 5000, 500)
                      ON CONFLICT (min_travelers, max_travelers) DO UPDATE SET price_amount = EXCLUDED.price_amount RETURNING id`)).id;
  knownHash = await hashPassword(PASSWORD);
  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  await app.listen(0);
  app.get(LineVerifier).stub = (channelId, idToken) => {
    const [kind, channel, user] = idToken.split(':');
    return kind === 'tok' && channel === channelId && user ? user : null;
  };
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('LINE 登入', () => {
  it('設定：未設定 LINE 的旅行社沒有 LIFF 設定；有設定時回傳 LIFF ID', async () => {
    const a = await makeAgency();
    expect((await on(a.host, http().get('/api/v1/public/line/config')).expect(200)).body).toEqual({ liffId: LIFF, agencyName: 'T' });
    const none = await makeAgency(false);
    expect((await on(none.host, http().get('/api/v1/public/line/config')).expect(404)).body.code).toBe('LINE_NOT_AVAILABLE');
  });

  it('第一次以員工編號＋密碼綁定，之後在 LINE 直接登入；登入狀態可使用前台', async () => {
    const e = await makeEvent(await makeAgency());
    const id = await makeEmployee(e);
    expect((await lineLogin(e, tokenFor('U1')).expect(401)).body.code).toBe('LINE_NOT_BOUND');
    const bound = await bind(e, tokenFor('U1')).expect(204);
    expect(cookieOf(bound)).toMatch(/^bt_session=/);
    expect(await boundAt(id)).not.toBeNull();

    const res = await lineLogin(e, tokenFor('U1')).expect(204);
    const status = await on(e.host, http().get(`${base(e)}/line-binding`)).set('cookie', cookieOf(res)).expect(200);
    expect(status.body).toMatchObject({ available: true, bound: true });
    // 同一個 LINE 再綁一次同一位員工不算錯誤
    await bind(e, tokenFor('U1')).expect(204);
    // 密碼登入照常可用
    await on(e.host, http().post(`${base(e)}/session`)).send({ employeeNo: 'E001', password: PASSWORD }).expect(204);
    // 只存雜湊，不存 LINE 帳號識別碼本身
    const row = await q1(`SELECT line_user_hash FROM event_employees WHERE id = $1`, [id]);
    expect(row.line_user_hash.toString('utf8')).not.toContain('U1');
  });

  it('Token 無效、其他 Channel 的 Token、密碼錯誤都不能綁定；密碼錯誤沿用鎖定規則', async () => {
    const e = await makeEvent(await makeAgency());
    const id = await makeEmployee(e);
    expect((await bind(e, 'garbage').expect(401)).body.code).toBe('LINE_TOKEN_INVALID');
    expect((await bind(e, tokenFor('U1', '9999999999')).expect(401)).body.code).toBe('LINE_TOKEN_INVALID');
    expect((await bind(e, tokenFor('U1'), 'E001', 'wrong1234').expect(401)).body.code).toBe('INVALID_CREDENTIALS');
    expect((await bind(e, tokenFor('U1'), 'NOPE').expect(401)).body.code).toBe('INVALID_CREDENTIALS');
    expect(await boundAt(id)).toBeNull();
    for (let i = 0; i < 4; i++) await bind(e, tokenFor('U1'), 'E001', 'wrong1234').expect(401);
    // 已鎖定：正確密碼也不能綁定
    expect((await bind(e, tokenFor('U1')).expect(401)).body.code).toBe('INVALID_CREDENTIALS');
    expect(await boundAt(id)).toBeNull();
  });

  it('沒設定密碼的員工不能用 LINE 開通', async () => {
    const e = await makeEvent(await makeAgency());
    await makeEmployee(e, 'E002', null);
    expect((await bind(e, tokenFor('U1'), 'E002', PASSWORD).expect(401)).body.code).toBe('INVALID_CREDENTIALS');
  });

  it('一對一：一個 LINE 只綁一位員工，一位員工只綁一個 LINE；密碼正確才說明原因', async () => {
    const e = await makeEvent(await makeAgency());
    await makeEmployee(e, 'E001');
    await makeEmployee(e, 'E002');
    await bind(e, tokenFor('U1'), 'E001').expect(204);
    expect((await bind(e, tokenFor('U1'), 'E002').expect(409)).body.code).toBe('LINE_ACCOUNT_IN_USE');
    expect((await bind(e, tokenFor('U2'), 'E001').expect(409)).body.code).toBe('EMPLOYEE_LINE_BOUND');
    expect((await bind(e, tokenFor('U1'), 'E002', 'wrong1234').expect(401)).body.code).toBe('INVALID_CREDENTIALS');
  });

  it('同一個 LINE 參加不同活動時各綁一次；共用連結只列出已綁定且活動頁開啟中的活動', async () => {
    const a = await makeAgency();
    const one = await makeEvent(a, { slug: 'one' });
    const two = await makeEvent(a, { slug: 'two' });
    const closed = await makeEvent(a, { slug: 'closed' });
    const off = await makeEvent(a, { slug: 'off' });
    for (const e of [one, two, closed, off]) await makeEmployee(e);
    await bind(one, tokenFor('U1')).expect(204);
    expect((await lineLogin(two, tokenFor('U1')).expect(401)).body.code).toBe('LINE_NOT_BOUND');
    await bind(two, tokenFor('U1')).expect(204);
    await bind(closed, tokenFor('U1')).expect(204);
    await bind(off, tokenFor('U1')).expect(204);
    await admin.query(`UPDATE events SET page_is_open = false WHERE id = $1`, [closed.eventId]);
    await admin.query(`UPDATE events SET line_enabled = false WHERE id = $1`, [off.eventId]);

    const list = await on(a.host, http().post('/api/v1/public/line/events')).send({ idToken: tokenFor('U1') }).expect(200);
    expect(list.body.map((x: any) => x.slug).sort()).toEqual(['one', 'two']);
    expect(list.body[0]).toMatchObject({ companyName: '企業' });
    expect((await on(a.host, http().post('/api/v1/public/line/events')).send({ idToken: tokenFor('U9') }).expect(200)).body).toEqual([]);
    // 其他旅行社看不到
    const other = await makeAgency();
    expect((await on(other.host, http().post('/api/v1/public/line/events')).send({ idToken: tokenFor('U1') }).expect(200)).body).toEqual([]);
  });

  it('活動頁關閉、活動關閉 LINE 入口、旅行社未設定 LINE 時都不能從 LINE 進入', async () => {
    const a = await makeAgency();
    const closed = await makeEvent(a, { slug: 'closed', pageOpen: false });
    await makeEmployee(closed);
    expect((await bind(closed, tokenFor('U1')).expect(403)).body.code).toBe('PAGE_CLOSED');
    const off = await makeEvent(a, { slug: 'off', eventLine: false });
    await makeEmployee(off);
    expect((await bind(off, tokenFor('U1')).expect(404)).body.code).toBe('LINE_NOT_AVAILABLE');
    const none = await makeEvent(await makeAgency(false));
    await makeEmployee(none);
    expect((await lineLogin(none, tokenFor('U1')).expect(404)).body.code).toBe('LINE_NOT_AVAILABLE');
  });

  it('員工自行解除綁定後要重新綁定；目前的登入狀態不受影響', async () => {
    const e = await makeEvent(await makeAgency());
    const id = await makeEmployee(e);
    const cookie = cookieOf(await bind(e, tokenFor('U1')).expect(204));
    await on(e.host, http().delete(`${base(e)}/line-binding`)).set('cookie', cookie).expect(204);
    expect(await boundAt(id)).toBeNull();
    expect((await lineLogin(e, tokenFor('U1')).expect(401)).body.code).toBe('LINE_NOT_BOUND');
    expect((await on(e.host, http().get(`${base(e)}/line-binding`)).set('cookie', cookie).expect(200)).body).toMatchObject({ bound: false });
    const log = await q1(`SELECT count(*)::int AS n FROM audit_logs WHERE target_id = $1 AND action = 'employee.line_unbound' AND actor_type = 'employee'`, [id]);
    expect(log.n).toBe(1);
  });

  it('移出名單時綁定一併刪除，重新加入要重新綁定', async () => {
    const e = await makeEvent(await makeAgency());
    const staff = await agencyUser(e, 'admin');
    const id = await makeEmployee(e);
    await bind(e, tokenFor('U1')).expect(204);
    await staff.del(`/events/${e.eventId}/employees/${id}`).expect(204);
    expect(await boundAt(id)).toBeNull();
    expect((await lineLogin(e, tokenFor('U1')).expect(401)).body.code).toBe('LINE_NOT_BOUND');
  });
});

describe('後台：LINE 設定、活動開關與名單', () => {
  it('只有管理員可以修改 LINE 設定；兩個欄位一起設定或清空；換 Channel 會清除既有綁定', async () => {
    const a = await makeAgency(false);
    const e = await makeEvent(a);
    const id = await makeEmployee(e);
    const boss = await agencyUser(a, 'admin');
    const op = await agencyUser(a, 'event_operator');
    await op.put('/settings/line', { channelId: CHANNEL, liffId: LIFF }).expect(403);
    await boss.put('/settings/line', { channelId: CHANNEL, liffId: null }).expect(422);
    await boss.put('/settings/line', { channelId: 'abc', liffId: LIFF }).expect(422);
    await boss.put('/settings/line', { channelId: CHANNEL, liffId: LIFF }).expect(200);
    const settings = (await boss.get('/settings').expect(200)).body;
    expect(settings.line).toEqual({
      channelId: CHANNEL, liffId: LIFF,
      endpointUrl: `http://${a.code}.lvh.me:3000/line`,
      sharedUrl: `https://liff.line.me/${LIFF}`,
    });

    await bind(e, tokenFor('U1')).expect(204);
    // 只改 LIFF ID：綁定保留
    expect((await boss.put('/settings/line', { channelId: CHANNEL, liffId: '1234567890-Other12' }).expect(200)).body).toEqual({ clearedBindings: 0 });
    expect(await boundAt(id)).not.toBeNull();
    // 換 Channel：綁定清除
    expect((await boss.put('/settings/line', { channelId: '2222222222', liffId: '2222222222-NewLiff1' }).expect(200)).body).toEqual({ clearedBindings: 1 });
    expect(await boundAt(id)).toBeNull();
    await boss.put('/settings/line', { channelId: null, liffId: null }).expect(200);
    expect((await boss.get('/settings').expect(200)).body.line).toMatchObject({ channelId: null, sharedUrl: null });
  });

  it('活動可個別關閉 LINE 入口；活動資料顯示 LINE 連結；複製活動帶入設定', async () => {
    const a = await makeAgency();
    const e = await makeEvent(a);
    const staff = await agencyUser(a, 'event_operator');
    expect((await staff.get(`/events/${e.eventId}`).expect(200)).body.line).toEqual({ configured: true, enabled: true, url: `https://liff.line.me/${LIFF}/evt` });
    await staff.put(`/events/${e.eventId}/line`, { enabled: false }).expect(204);
    expect((await staff.get(`/events/${e.eventId}`).expect(200)).body.line).toEqual({ configured: true, enabled: false, url: null });

    const ops = await agencyUser(a, 'operations');
    await ops.put(`/events/${e.eventId}/line`, { enabled: true }).expect(403);

    await admin.query(`INSERT INTO agency_quota_ledger (agency_id, pricing_tier_id, change, reason) VALUES ($1, $2, 5, 'grant')`, [a.agencyId, tierId]);
    const copy = await request(app.getHttpServer()).post(`/api/v1/agency/events/${e.eventId}/copy`)
      .set('x-forwarded-host', a.host).set('cookie', (await agencyCookie(a)))
      .send({ companyId: a.company, name: '複製', slug: 'copy-evt', pricingTierId: tierId });
    expect(copy.status).toBe(201);
    expect((await q1(`SELECT line_enabled FROM events WHERE id = $1`, [copy.body.id])).line_enabled).toBe(false);
  });

  it('名單顯示綁定狀態並可篩選；旅行社人員與企業窗口都能解除，留下紀錄', async () => {
    const a = await makeAgency();
    const e = await makeEvent(a);
    const first = await makeEmployee(e, 'E001');
    await makeEmployee(e, 'E002');
    await bind(e, tokenFor('U1'), 'E001').expect(204);
    const staff = await agencyUser(a, 'event_operator');
    const list = (await staff.get(`/events/${e.eventId}/employees`).expect(200)).body;
    expect(list.rows.map((r: any) => [r.employeeNo, r.lineBound])).toEqual([['E001', true], ['E002', false]]);
    expect(list.line).toEqual({ available: true, url: `https://liff.line.me/${LIFF}/evt`, boundCount: 1 });
    expect((await staff.get(`/events/${e.eventId}/employees?line=bound`).expect(200)).body.rows.map((r: any) => r.employeeNo)).toEqual(['E001']);
    expect((await staff.get(`/events/${e.eventId}/employees?line=unbound`).expect(200)).body.rows.map((r: any) => r.employeeNo)).toEqual(['E002']);

    await staff.del(`/events/${e.eventId}/employees/${first}/line-binding`).expect(204);
    expect(await boundAt(first)).toBeNull();

    await bind(e, tokenFor('U1'), 'E001').expect(204);
    const contact = await contactUser(a);
    expect((await contact.get(`/events/${e.eventId}/employees`).expect(200)).body.line.boundCount).toBe(1);
    await contact.del(`/events/${e.eventId}/employees/${first}/line-binding`).expect(204);
    expect(await boundAt(first)).toBeNull();
    const logs = (await admin.query(`SELECT actor_type FROM audit_logs WHERE target_id = $1 AND action = 'employee.line_unbound' ORDER BY created_at`, [first])).rows;
    expect(logs.map((l) => l.actor_type)).toEqual(['agency_user', 'company_contact']);

    // 其他旅行社不能解除
    const other = await agencyUser(await makeAgency(), 'admin');
    await other.del(`/events/${e.eventId}/employees/${first}/line-binding`).expect(404);
  });

  it('帳號信與設定密碼完成頁附上 LINE 連結；活動關閉 LINE 入口時不附', async () => {
    const a = await makeAgency();
    const e = await makeEvent(a);
    const staff = await agencyUser(a, 'admin');
    const id = await makeEmployee(e, 'E001', null);
    const mail = app.get(MailService);
    const before = mail.sent.length;
    await request(app.getHttpServer()).post(`/api/v1/agency/events/${e.eventId}/employees/account-emails`)
      .set('x-forwarded-host', a.host).set('cookie', await agencyCookie(a)).send({ employeeIds: [id] }).expect(202);
    for (let i = 0; i < 100 && mail.sent.length === before; i++) await new Promise((r) => setTimeout(r, 30));
    const sent = mail.sent.slice(before).find((m) => m.subject.includes('報名網站密碼'))!;
    expect(sent.text).toContain(`https://liff.line.me/${LIFF}/evt`);

    const { token } = await app.get(AccountService).issuePasswordLink(a.agencyId, id, { type: 'system', id: null }, 'manual');
    const done = await on(a.host, http().post(`${base(e)}/password-links/set`)).send({ token, password: 'newpass123' }).expect(200);
    expect(done.body).toEqual({ employeeNo: 'E001', lineUrl: `https://liff.line.me/${LIFF}/evt` });

    await staff.put(`/events/${e.eventId}/line`, { enabled: false }).expect(204);
    const second = await makeEmployee(e, 'E002', null);
    const { token: t2 } = await app.get(AccountService).issuePasswordLink(a.agencyId, second, { type: 'system', id: null }, 'manual');
    expect((await on(a.host, http().post(`${base(e)}/password-links/set`)).send({ token: t2, password: 'newpass123' }).expect(200)).body.lineUrl).toBeNull();
  });
});

describe('平台後台', () => {
  it('顯示旅行社是否設定 LINE 與各活動已綁定人數', async () => {
    const a = await makeAgency();
    const e = await makeEvent(a);
    await makeEmployee(e);
    await bind(e, tokenFor('U1')).expect(204);
    const userId = (await q1(`INSERT INTO platform_users (email, name, password_hash) VALUES ($1, 'P', $2) RETURNING id`, [`p-${randomUUID().slice(0, 6)}@example.com`, knownHash])).id;
    const token = generateToken();
    await admin.query(`INSERT INTO platform_user_sessions (platform_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
      [userId, hashToken(process.env.TOKEN_HASH_KEY!, token)]);
    const p = (path: string) => http().get(`/api/v1/platform${path}`).set('x-forwarded-host', 'platform.lvh.me').set('cookie', `bt_platform_session=${token}`);
    const detail = (await p(`/agencies/${a.agencyId}`).expect(200)).body;
    expect(detail.line).toEqual({ configured: true, events: [{ id: e.eventId, name: '活動 evt', enabled: true, boundCount: 1 }] });
    const list = (await p(`/agencies?search=${a.code}`).expect(200)).body;
    expect(list[0]).toMatchObject({ lineConfigured: true });
  });
});

/** 另外建一個旅行社人員的 Cookie，給 supertest 直接呼叫時使用。 */
async function agencyCookie(a: Ag) {
  const userId = (await q1(`SELECT id FROM agency_users WHERE agency_id = $1 AND role = 'admin' LIMIT 1`, [a.agencyId]))?.id
    ?? (await q1(`INSERT INTO agency_users (agency_id, email, password_hash, name, role) VALUES ($1, $2, $3, 'A', 'admin') RETURNING id`,
      [a.agencyId, `x-${randomUUID().slice(0, 6)}@example.com`, knownHash])).id;
  const token = generateToken();
  await admin.query(`INSERT INTO agency_user_sessions (agency_id, agency_user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [a.agencyId, userId, hashToken(process.env.TOKEN_HASH_KEY!, token)]);
  return `bt_agency_session=${token}`;
}
