import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { hashPassword, generateToken, hashToken } from '@bigtours/shared/crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';

const PASSWORD = 'abcd1234';
let app: INestApplication;
let admin: pg.Client;
let tierId: string;
let hash: string;

const q1 = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0];

async function makeAgency(role = 'event_operator') {
  const code = `g-${randomUUID().slice(0, 8)}`;
  const agencyId = (await q1(`INSERT INTO agencies (code, name) VALUES ($1, 'T') RETURNING id`, [code])).id as string;
  const company = (await q1(`INSERT INTO companies (agency_id, name) VALUES ($1, 'C') RETURNING id`, [agencyId])).id as string;
  const eventId = (await q1(
    `INSERT INTO events (agency_id, company_id, slug, name, status, pricing_tier_id, registration_opens_at, registration_closes_at)
     VALUES ($1, $2, 'evt', 'E', 'published', $3, now() - interval '1 day', now() + interval '30 days') RETURNING id`,
    [agencyId, company, tierId],
  )).id as string;
  await admin.query(`INSERT INTO agency_users (agency_id, email, password_hash, name, role) VALUES ($1, 'a@example.com', $2, 'A', $3)`, [agencyId, hash, role]);
  const token = generateToken();
  const userId = (await q1(`SELECT id FROM agency_users WHERE agency_id = $1`, [agencyId])).id;
  await admin.query(`INSERT INTO agency_user_sessions (agency_id, agency_user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [agencyId, userId, hashToken(process.env.TOKEN_HASH_KEY!, token)]);
  return { agencyId, eventId, host: `${code}.lvh.me`, cookie: `bt_agency_session=${token}` };
}
type Ag = Awaited<ReturnType<typeof makeAgency>>;

const api = (a: Ag) => {
  const http = request(app.getHttpServer());
  const h = (r: request.Test) => r.set('x-forwarded-host', a.host).set('cookie', a.cookie);
  const b = `/api/v1/agency/events/${a.eventId}`;
  return {
    get: (p: string) => h(http.get(`${b}${p}`)),
    post: (p: string, body: object) => h(http.post(`${b}${p}`)).send(body),
    patch: (p: string, body: object) => h(http.patch(`${b}${p}`)).send(body),
    put: (p: string, body: object) => h(http.put(`${b}${p}`)).send(body),
    del: (p: string) => h(http.delete(`${b}${p}`)),
  };
};

const session = (o: object = {}) => ({
  name: '快樂東京5日遊', departsOn: '2027-03-01', returnsOn: '2027-03-05', departureTime: '08:30', returnArrivalTime: '19:40',
  outboundFlightNo: 'cx001', returnFlightNo: 'CX002', capacity: 40, ...o,
});
const field = (o: object = {}) => ({ label: '飲食', type: 'select', choices: ['一般', '素食'], isRequired: true, ...o });

beforeAll(async () => {
  admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  tierId = (await q1(`INSERT INTO pricing_tiers (min_travelers, max_travelers, price_amount) VALUES (1, 199, 500)
                      ON CONFLICT (min_travelers, max_travelers) DO UPDATE SET price_amount = EXCLUDED.price_amount RETURNING id`)).id;
  hash = await hashPassword(PASSWORD);
  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  await app.listen(0);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('旅行社登入', () => {
  it('登入後可用，登出後失效；Cookie 限定後台路徑', async () => {
    const a = await makeAgency();
    const http = () => request(app.getHttpServer());
    const res = await http().post('/api/v1/agency/session').set('x-forwarded-host', a.host).send({ email: 'A@example.com', password: PASSWORD });
    expect(res.status).toBe(204);
    const header = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Path=/api/v1/agency');
    const cookie = header.split(';')[0]!;
    const me = await http().get('/api/v1/agency/me').set('x-forwarded-host', a.host).set('cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.name).toBe('A');
    await http().delete('/api/v1/agency/session').set('x-forwarded-host', a.host).set('cookie', cookie);
    expect((await http().get('/api/v1/agency/me').set('x-forwarded-host', a.host).set('cookie', cookie)).status).toBe(401);
  });

  it('密碼錯誤與帳號不存在回傳相同錯誤，連續失敗後鎖定', async () => {
    const a = await makeAgency();
    const login = (email: string, password: string) =>
      request(app.getHttpServer()).post('/api/v1/agency/session').set('x-forwarded-host', a.host).send({ email, password });
    expect((await login('none@example.com', PASSWORD)).body.code).toBe('INVALID_CREDENTIALS');
    for (let i = 0; i < 5; i += 1) expect((await login('a@example.com', 'wrong1234')).status).toBe(401);
    expect((await login('a@example.com', PASSWORD)).status).toBe(401);
  });

  it('未登入不能存取；其他旅行社的登入狀態與活動都不能使用', async () => {
    const a = await makeAgency();
    const b = await makeAgency();
    expect((await request(app.getHttpServer()).get(`/api/v1/agency/events/${a.eventId}/sessions`).set('x-forwarded-host', a.host)).status).toBe(401);
    expect((await api({ ...a, cookie: b.cookie }).get('/sessions')).status).toBe(401);
    expect((await api({ ...b, eventId: a.eventId }).get('/sessions')).status).toBe(404);
    expect((await api({ ...b, eventId: a.eventId }).post('/sessions', session())).status).toBe(404);
    const list = await request(app.getHttpServer()).get('/api/v1/agency/events').set('x-forwarded-host', b.host).set('cookie', b.cookie);
    expect(list.body.map((e: { id: string }) => e.id)).toEqual([b.eventId]);
  });

  it('員工的登入狀態不能進入後台', async () => {
    const a = await makeAgency();
    const r = await request(app.getHttpServer()).get('/api/v1/agency/me').set('x-forwarded-host', a.host).set('cookie', a.cookie.replace('bt_agency_session', 'bt_session'));
    expect(r.status).toBe(401);
  });
});

describe('梯次設定', () => {
  it('新增後員工前台看得到，航班轉大寫，空白航班存為空', async () => {
    const a = await makeAgency();
    const created = await api(a).post('/sessions', session());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: '快樂東京5日遊', outboundFlightNo: 'CX001', departureTime: '08:30', returnArrivalTime: '19:40', departsOn: '2027-03-01' });
    const noFlight = await api(a).post('/sessions', session({ outboundFlightNo: '', returnFlightNo: null }));
    expect(noFlight.body).toMatchObject({ outboundFlightNo: null, returnFlightNo: null });

    const emp = (await q1(`INSERT INTO event_employees (agency_id, event_id, employee_no, name) VALUES ($1, $2, 'E1', 'N') RETURNING id`, [a.agencyId, a.eventId])).id;
    const token = generateToken();
    await admin.query(`INSERT INTO employee_sessions (agency_id, event_employee_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [a.agencyId, emp, hashToken(process.env.TOKEN_HASH_KEY!, token)]);
    const front = await request(app.getHttpServer()).get('/api/v1/public/events/evt').set('x-forwarded-host', a.host).set('cookie', `bt_session=${token}`);
    expect(front.body.availability[0]).toMatchObject({ name: '快樂東京5日遊', outboundFlightNo: 'CX001', departureTime: '08:30' });
  });

  it('必填與格式錯誤一律拒絕，回程不能早於去程', async () => {
    const a = await makeAgency();
    for (const bad of [{ name: ' ' }, { departsOn: '2027-13-01' }, { departureTime: '25:00' }, { returnArrivalTime: null }, { capacity: -1 }, { returnsOn: '2027-02-28' }]) {
      const r = await api(a).post('/sessions', session(bad));
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('INVALID_INPUT');
    }
    expect((await api(a).get('/sessions')).body).toEqual([]);
  });

  it('所有梯次總名額不能超過活動級距', async () => {
    const a = await makeAgency();
    const first = await api(a).post('/sessions', session({ capacity: 150 }));
    const over = await api(a).post('/sessions', session({ capacity: 50 }));
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('TIER_LIMIT_EXCEEDED');
    expect((await api(a).post('/sessions', session({ capacity: 49 }))).status).toBe(201);
    expect((await api(a).patch(`/sessions/${first.body.id}`, session({ capacity: 151 }))).status).toBe(409);
    expect((await api(a).patch(`/sessions/${first.body.id}`, session({ capacity: 150, name: '改名' }))).body.name).toBe('改名');
  });

  it('同時新增也不會超過級距', async () => {
    const a = await makeAgency();
    const results = await Promise.all(Array.from({ length: 5 }, () => api(a).post('/sessions', session({ capacity: 100 }))));
    expect(results.filter((r) => r.status === 201).length).toBe(1);
  });

  it('名額不能低於已報名人數；已有保留或報名時不能刪除', async () => {
    const a = await makeAgency();
    const s = (await api(a).post('/sessions', session({ capacity: 10 }))).body;
    await admin.query(`UPDATE event_sessions SET sold_count = 5 WHERE id = $1`, [s.id]);
    const low = await api(a).patch(`/sessions/${s.id}`, session({ capacity: 4 }));
    expect(low.status).toBe(409);
    expect(low.body.code).toBe('CAPACITY_BELOW_SOLD');
    expect((await api(a).patch(`/sessions/${s.id}`, session({ capacity: 5 }))).status).toBe(200);

    const free = (await api(a).post('/sessions', session({ capacity: 1 }))).body;
    const emp = (await q1(`INSERT INTO event_employees (agency_id, event_id, employee_no, name) VALUES ($1, $2, 'E1', 'N') RETURNING id`, [a.agencyId, a.eventId])).id;
    await admin.query(`INSERT INTO seat_holds (agency_id, event_id, event_employee_id, session_id, quantity, expires_at) VALUES ($1, $2, $3, $4, 1, now() + interval '15 minutes')`,
      [a.agencyId, a.eventId, emp, free.id]);
    expect((await api(a).del(`/sessions/${free.id}`)).body.code).toBe('SESSION_IN_USE');
    const unused = (await api(a).post('/sessions', session({ capacity: 1 }))).body;
    expect((await api(a).del(`/sessions/${unused.id}`)).status).toBe(204);
  });

  it('可以調整順序，必須包含全部且不重複', async () => {
    const a = await makeAgency();
    const x = (await api(a).post('/sessions', session({ name: 'X', capacity: 1 }))).body;
    const y = (await api(a).post('/sessions', session({ name: 'Y', capacity: 1 }))).body;
    expect((await api(a).put('/sessions/order', { ids: [y.id, x.id] })).status).toBe(204);
    expect((await api(a).get('/sessions')).body.map((s: { name: string }) => s.name)).toEqual(['Y', 'X']);
    expect((await api(a).put('/sessions/order', { ids: [y.id] })).status).toBe(422);
    expect((await api(a).put('/sessions/order', { ids: [y.id, y.id] })).status).toBe(422);
  });
});

describe('旅客資料欄位設定', () => {
  it('五種型態都能新增，依順序回傳給前台', async () => {
    const a = await makeAgency();
    const made = [];
    for (const f of [
      { label: '文字', type: 'text', choices: null, isRequired: false },
      { label: '數字', type: 'number', choices: null, isRequired: true },
      { label: '日期', type: 'date', choices: null, isRequired: false },
      { label: '單選', type: 'select', choices: ['A', 'B'], isRequired: true },
      { label: '多選', type: 'multiselect', choices: ['A', 'B'], isRequired: false },
    ]) {
      const r = await api(a).post('/fields', f);
      expect(r.status).toBe(201);
      made.push(r.body);
    }
    const reversed = made.map((f) => f.id).reverse();
    expect((await api(a).put('/fields/order', { ids: reversed })).status).toBe(204);
    expect((await api(a).get('/fields')).body.map((f: { label: string }) => f.label)).toEqual(['多選', '單選', '日期', '數字', '文字']);
  });

  it('單選與多選必須有選項且不重複，其他型態不能有選項', async () => {
    const a = await makeAgency();
    for (const bad of [
      { type: 'select', choices: null }, { type: 'multiselect', choices: [] }, { type: 'select', choices: ['A', 'A'] },
      { type: 'text', choices: ['A'] }, { type: 'checkbox', choices: null }, { label: '' },
      { type: 'select', choices: ['A'], isSensitive: true },
    ]) {
      expect((await api(a).post('/fields', field(bad))).status).toBe(422);
    }
  });

  it('沒有報名時可以修改與刪除', async () => {
    const a = await makeAgency();
    const f = (await api(a).post('/fields', field())).body;
    const changed = await api(a).patch(`/fields/${f.id}`, { label: '身高', type: 'number', choices: null, isRequired: false });
    expect(changed.body).toMatchObject({ label: '身高', type: 'number', choices: null, isRequired: false });
    expect((await api(a).del(`/fields/${f.id}`)).status).toBe(204);
    expect((await api(a).del(`/fields/${f.id}`)).status).toBe(404);
  });

  it('已有報名後不能刪除或改型態，名稱、必填與選項仍可改', async () => {
    const a = await makeAgency();
    const f = (await api(a).post('/fields', field())).body;
    const s = (await api(a).post('/sessions', session({ capacity: 5 }))).body;
    const emp = (await q1(`INSERT INTO event_employees (agency_id, event_id, employee_no, name) VALUES ($1, $2, 'E1', 'N') RETURNING id`, [a.agencyId, a.eventId])).id;
    await admin.query(`INSERT INTO registrations (agency_id, event_id, event_employee_id, session_id, total_amount, subsidy_amount, payment_status, terms_version_accepted, terms_accepted_at)
                       VALUES ($1, $2, $3, $4, 0, 0, 'not_required', 1, now())`, [a.agencyId, a.eventId, emp, s.id]);
    expect((await api(a).del(`/fields/${f.id}`)).body.code).toBe('FIELD_LOCKED');
    expect((await api(a).patch(`/fields/${f.id}`, field({ type: 'multiselect' }))).body.code).toBe('FIELD_LOCKED');
    expect((await api(a).patch(`/fields/${f.id}`, { label: '飲食', type: 'text', choices: null, isRequired: true, isSensitive: true })).body.code).toBe('FIELD_LOCKED');
    const ok = await api(a).patch(`/fields/${f.id}`, field({ label: '飲食需求', choices: ['一般', '素食', '不吃牛'], isRequired: false }));
    expect(ok.status).toBe(200);
    expect(ok.body.choices).toEqual(['一般', '素食', '不吃牛']);
    expect((await api(a).del(`/sessions/${s.id}`)).body.code).toBe('SESSION_IN_USE');
  });

  it('活動代碼不能使用 admin', async () => {
    const a = await makeAgency();
    await expect(admin.query(`UPDATE events SET slug = 'admin' WHERE id = $1`, [a.eventId])).rejects.toThrow();
  });
});

describe('角色權限', () => {
  const me = (a: Ag) => request(app.getHttpServer()).get('/api/v1/agency/me').set('x-forwarded-host', a.host).set('cookie', a.cookie);
  const pin = (a: Ag, items: unknown) => request(app.getHttpServer()).put('/api/v1/agency/me/pinned-nav').set('x-forwarded-host', a.host).set('cookie', a.cookie).send({ items });

  it('登入資訊回傳角色與釘選項目', async () => {
    const a = await makeAgency('admin');
    const res = await me(a).expect(200);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.pinnedNavItems).toEqual([]);
  });

  it('活動操作員可以設定活動', async () => {
    const a = await makeAgency('event_operator');
    await api(a).get('/sessions').expect(200);
    await api(a).post('/sessions', session()).expect(201);
  });

  it('營運人員不能查看或修改活動設定', async () => {
    const a = await makeAgency('operations');
    const res = await api(a).get('/sessions').expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    await api(a).post('/sessions', session()).expect(403);
    await api(a).get('/fields').expect(403);
    await api(a).post('/fields', field()).expect(403);
    await api(a).put('/fields/order', { ids: [randomUUID()] }).expect(403);
  });

  it('營運人員仍可看到活動資訊', async () => {
    const a = await makeAgency('operations');
    const res = await request(app.getHttpServer()).get('/api/v1/agency/events').set('x-forwarded-host', a.host).set('cookie', a.cookie).expect(200);
    expect(res.body).toHaveLength(1);
    await api(a).get('').expect(200);
  });

  it('沒有登入時回 401，不回 403', async () => {
    const a = await makeAgency('operations');
    await request(app.getHttpServer()).get(`/api/v1/agency/events/${a.eventId}/sessions`).set('x-forwarded-host', a.host).expect(401);
  });

  it('釘選項目依順序保存，下次登入仍在', async () => {
    const a = await makeAgency('event_operator');
    await pin(a, ['registrations', 'roster']).expect(204);
    expect((await me(a).expect(200)).body.pinnedNavItems).toEqual(['registrations', 'roster']);
    await pin(a, []).expect(204);
    expect((await me(a)).body.pinnedNavItems).toEqual([]);
  });

  it('拒絕未知或重複的釘選項目', async () => {
    const a = await makeAgency('admin');
    await pin(a, ['nope']).expect(422);
    await pin(a, ['rooms', 'rooms']).expect(422);
  });

  it('營運人員沒有釘選功能', async () => {
    await pin(await makeAgency('operations'), ['rooms']).expect(403);
  });
});

describe('活動設定', () => {
  const http = () => request(app.getHttpServer());
  const root = (a: Ag) => ({
    get: (p: string) => http().get(`/api/v1/agency${p}`).set('x-forwarded-host', a.host).set('cookie', a.cookie),
    post: (p: string, b: object) => http().post(`/api/v1/agency${p}`).set('x-forwarded-host', a.host).set('cookie', a.cookie).send(b),
    del: (p: string) => http().delete(`/api/v1/agency${p}`).set('x-forwarded-host', a.host).set('cookie', a.cookie),
  });
  const grant = (a: Ag, n: number) => admin.query(`INSERT INTO agency_quota_ledger (agency_id, pricing_tier_id, change, reason) VALUES ($1, $2, $3, 'grant')`, [a.agencyId, tierId, n]);
  const remaining = async (a: Ag) => (await root(a).get('/quota').expect(200)).body.find((t: any) => t.id === tierId).remaining as number;
  const companyId = async (a: Ag) => (await root(a).get('/companies').expect(200)).body[0].id as string;
  const create = async (a: Ag, slug = 'new-event') => root(a).post('/events', { companyId: await companyId(a), name: '新活動', slug, pricingTierId: tierId });
  const basic = (o: object = {}) => ({ name: '花東三日遊', slug: 'evt', days: [{ title: '第 1 天', description: '花蓮' }], themeColor: '#1F3A8A', supportPhone: '0800-000-000', supportHours: null, ...o });
  const schedule = (o: object = {}) => ({ pageMode: 'manual', pageOpensAt: null, pageClosesAt: null, registrationOpensAt: null, registrationClosesAt: null, ...o });

  it('建立活動會扣一場額度，預設為草稿且活動頁關閉', async () => {
    const a = await makeAgency();
    await grant(a, 2);
    const res = await create(a);
    expect(res.status).toBe(201);
    expect(await remaining(a)).toBe(1);
    const detail = (await root(a).get(`/events/${res.body.id}`).expect(200)).body;
    expect(detail).toMatchObject({ status: 'draft', pageMode: 'manual', pageIsOpen: false, pageState: 'closed', themeColor: '#0E6B72' });
  });

  it('額度用完時不能建立活動', async () => {
    const a = await makeAgency();
    const res = await create(a);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('QUOTA_EMPTY');
  });

  it('同時建立活動不會超扣額度', async () => {
    const a = await makeAgency();
    await grant(a, 2);
    const company = await companyId(a);
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => root(a).post('/events', { companyId: company, name: 'E', slug: `race-${i}`, pricingTierId: tierId })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.body.code === 'QUOTA_EMPTY')).toHaveLength(3);
    expect(await remaining(a)).toBe(0);
  });

  it('活動代碼重複時回傳明確錯誤且不扣額度', async () => {
    const a = await makeAgency();
    await grant(a, 2);
    const res = await create(a, 'evt');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SLUG_TAKEN');
    expect(await remaining(a)).toBe(2);
  });

  it('不能使用其他旅行社的企業建立活動', async () => {
    const a = await makeAgency();
    const other = await makeAgency();
    await grant(a, 1);
    const company = await companyId(other);
    await root(a).post('/events', { companyId: company, name: 'E', slug: 'x-1', pricingTierId: tierId }).expect(404);
  });

  it('草稿刪除後額度退回，代碼可重新使用；已發布的活動不能刪除', async () => {
    const a = await makeAgency();
    await grant(a, 1);
    const { body } = await create(a, 'again');
    expect(await remaining(a)).toBe(0);
    await root(a).del(`/events/${body.id}`).expect(204);
    expect(await remaining(a)).toBe(1);
    expect((await root(a).get('/events')).body.map((e: any) => e.id)).not.toContain(body.id);
    expect((await create(a, 'again')).status).toBe(201);
    const res = await root(a).del(`/events/${a.eventId}`).expect(409);
    expect(res.body.code).toBe('EVENT_NOT_DRAFT');
  });

  it('可以修改基本資料，前台改用活動主色', async () => {
    const a = await makeAgency();
    await api(a).put('/basic', basic()).expect(204);
    const detail = (await api(a).get('').expect(200)).body;
    expect(detail).toMatchObject({ name: '花東三日遊', themeColor: '#1F3A8A', supportPhone: '0800-000-000', supportHours: null });
    expect(detail.days).toHaveLength(1);
    const landing = await http().get('/api/v1/public/events/evt/landing').set('x-forwarded-host', a.host);
    expect(landing.body.event.themeColor).toBe('#1F3A8A');
  });

  it('修改基本資料保留行程摘要', async () => {
    const a = await makeAgency();
    await admin.query(`UPDATE events SET itinerary = '{"summary":"S"}' WHERE id = $1`, [a.eventId]);
    await api(a).put('/basic', basic()).expect(204);
    expect((await q1(`SELECT itinerary FROM events WHERE id = $1`, [a.eventId])).itinerary.summary).toBe('S');
  });

  it('發布後不能改活動代碼，色碼必須正確', async () => {
    const a = await makeAgency();
    const res = await api(a).put('/basic', basic({ slug: 'other' })).expect(409);
    expect(res.body.code).toBe('EVENT_NOT_DRAFT');
    await api(a).put('/basic', basic({ themeColor: 'blue' })).expect(422);
  });

  it('自動模式下依時間開關，手動開關會被拒絕', async () => {
    const a = await makeAgency();
    const future = new Date(Date.now() + 86400000).toISOString(), later = new Date(Date.now() + 2 * 86400000).toISOString();
    await api(a).put('/schedule', schedule({ pageMode: 'scheduled', pageOpensAt: future, pageClosesAt: later })).expect(204);
    expect((await api(a).get('').expect(200)).body.pageState).toBe('not_open');
    const res = await api(a).put('/page', { open: true }).expect(409);
    expect(res.body.code).toBe('PAGE_MODE_MISMATCH');
  });

  it('從自動切回手動時維持目前狀態', async () => {
    const a = await makeAgency();
    const future = new Date(Date.now() + 86400000).toISOString(), later = new Date(Date.now() + 2 * 86400000).toISOString();
    await api(a).put('/schedule', schedule({ pageMode: 'scheduled', pageOpensAt: future, pageClosesAt: later })).expect(204);
    await api(a).put('/schedule', schedule()).expect(204);
    expect((await api(a).get('')).body).toMatchObject({ pageMode: 'manual', pageIsOpen: false, pageState: 'closed' });
  });

  it('手動開關活動頁；草稿不能開啟', async () => {
    const a = await makeAgency();
    await api(a).put('/page', { open: false }).expect(204);
    expect((await api(a).get('')).body.pageState).toBe('closed');
    await api(a).put('/page', { open: true }).expect(204);
    expect((await api(a).get('')).body.pageState).toBe('open');
    await grant(a, 1);
    const { body } = await create(a, 'draft-1');
    const res = await http().put(`/api/v1/agency/events/${body.id}/page`).set('x-forwarded-host', a.host).set('cookie', a.cookie).send({ open: true }).expect(409);
    expect(res.body.code).toBe('EVENT_NOT_PUBLISHED');
  });

  it('設定時間順序錯誤會被拒絕', async () => {
    const a = await makeAgency();
    await api(a).put('/schedule', schedule({ registrationOpensAt: '2027-02-01T00:00:00Z', registrationClosesAt: '2027-01-01T00:00:00Z' })).expect(422);
  });

  it('企業客戶可以新增，並彼此隔離', async () => {
    const a = await makeAgency();
    const other = await makeAgency();
    await root(a).post('/companies', { name: '永晟科技' }).expect(201);
    expect((await root(a).get('/companies')).body.map((c: any) => c.name)).toContain('永晟科技');
    expect((await root(other).get('/companies')).body.map((c: any) => c.name)).not.toContain('永晟科技');
  });

  it('營運人員不能建立或修改活動', async () => {
    const a = await makeAgency('operations');
    await root(a).get('/quota').expect(403);
    await root(a).get('/companies').expect(403);
    await root(a).post('/events', {}).expect(403);
    await api(a).put('/basic', basic()).expect(403);
    await api(a).put('/schedule', schedule()).expect(403);
    await api(a).put('/page', { open: true }).expect(403);
    await root(a).del(`/events/${a.eventId}`).expect(403);
  });
});

describe('旅客類型、房型與自選行程', () => {
  const pricing = (types: object[], o: object = {}) => ({ types, defaultSubsidyAmount: 0, defaultDependentLimit: 0, allowDependentsOnly: false, ...o });
  const type = (o: object = {}) => ({ id: null, name: '成人眷屬', basePrice: 10800, note: null, occupiesBed: true, ...o });
  const withSelf = async (a: Ag) =>
    (await q1(`INSERT INTO traveler_types (agency_id, event_id, name, base_price, is_employee_self) VALUES ($1, $2, '員工本人', 0, true) RETURNING id`, [a.agencyId, a.eventId])).id as string;
  const room = (o: object = {}) => ({ id: null, name: '三人房', capacity: 3, surcharge: 0, bedQuota: 30, ...o });
  const group = (o: object = {}) => ({ name: '第二天下午體驗', isRequired: true, maxSelect: 1, preferenceCount: 3, ...o });

  it('新活動固定有員工本人，不能改名、不能不佔床，也不能刪除', async () => {
    const a = await makeAgency('admin');
    const self = await withSelf(a);
    const saved = await api(a).put('/pricing', pricing([
      type({ id: self, name: '改名', basePrice: 9800, occupiesBed: false, note: '已含保險' }),
      type({ name: '嬰兒眷屬', basePrice: 1500, occupiesBed: false, note: '未滿 2 歲' }),
    ], { defaultSubsidyAmount: 5000, defaultDependentLimit: 2, allowDependentsOnly: true })).expect(200);
    expect(saved.body.types[0]).toMatchObject({ id: self, name: '員工本人', basePrice: 9800, occupiesBed: true, note: '已含保險', isEmployeeSelf: true });
    expect(saved.body.types[1]).toMatchObject({ name: '嬰兒眷屬', occupiesBed: false, isEmployeeSelf: false });
    expect(saved.body).toMatchObject({ defaultSubsidyAmount: 5000, defaultDependentLimit: 2, allowDependentsOnly: true });

    const noSelf = await api(a).put('/pricing', pricing([type()])).expect(422);
    expect(noSelf.body.code).toBe('INVALID_INPUT');
    const dup = await api(a).put('/pricing', pricing([type({ id: self }), type(), type()])).expect(409);
    expect(dup.body.code).toBe('DUPLICATE_NAME');
    const dupSelf = await api(a).put('/pricing', pricing([type({ id: self }), type({ name: '員工本人' })])).expect(409);
    expect(dupSelf.body.code).toBe('DUPLICATE_NAME');
    expect((await api(a).get('/pricing').expect(200)).body.types).toHaveLength(2);
  });

  it('沒列出的旅客類型會刪除；已有旅客使用時不能刪，也不能套用其他活動的類型', async () => {
    const a = await makeAgency('admin');
    const self = await withSelf(a);
    const saved = await api(a).put('/pricing', pricing([type({ id: self }), type()])).expect(200);
    const adult = saved.body.types[1].id as string;

    const other = await makeAgency('admin');
    const otherSelf = await withSelf(other);
    await api(a).put('/pricing', pricing([type({ id: self }), type({ id: otherSelf, name: 'X' })])).expect(422);

    const s = await api(a).post('/sessions', session()).expect(201);
    const emp = await q1(`INSERT INTO event_employees (agency_id, event_id, employee_no, name) VALUES ($1, $2, 'E1', 'N') RETURNING id`, [a.agencyId, a.eventId]);
    const reg = await q1(
      `INSERT INTO registrations (agency_id, event_id, session_id, event_employee_id, total_amount, payment_status, terms_version_accepted, terms_accepted_at)
       VALUES ($1, $2, $3, $4, 0, 'unpaid', 1, now()) RETURNING id`,
      [a.agencyId, a.eventId, s.body.id, emp.id],
    );
    await admin.query(`INSERT INTO travelers (agency_id, registration_id, traveler_type_id, name, base_price_snapshot) VALUES ($1, $2, $3, 'N', 0)`, [a.agencyId, reg.id, adult]);
    const used = await api(a).put('/pricing', pricing([type({ id: self })])).expect(409);
    expect(used.body.code).toBe('TRAVELER_TYPE_IN_USE');
  });

  it('房型依梯次儲存，不同梯次可不同；已售出不能刪除也不能低於已售', async () => {
    const a = await makeAgency('admin');
    const s1 = await api(a).post('/sessions', session({ roomTypes: [room(), room({ name: '單人房', capacity: 1, surcharge: 3000, bedQuota: 5 })] })).expect(201);
    expect(s1.body.roomTypes.map((r: any) => r.name)).toEqual(['三人房', '單人房']);
    const s2 = await api(a).post('/sessions', session({ name: 'B' })).expect(201);
    expect(s2.body.roomTypes).toEqual([]);

    // 沒帶房型時不變更
    const same = await api(a).patch(`/sessions/${s1.body.id}`, session({ capacity: 50 })).expect(200);
    expect(same.body.roomTypes).toHaveLength(2);

    const dup = await api(a).patch(`/sessions/${s1.body.id}`, session({ roomTypes: [room(), room()] })).expect(409);
    expect(dup.body.code).toBe('DUPLICATE_NAME');
    await api(a).patch(`/sessions/${s2.body.id}`, session({ roomTypes: [room({ id: s1.body.roomTypes[0].id })] })).expect(422);

    const [triple, single] = s1.body.roomTypes;
    await admin.query(`UPDATE session_room_types SET sold_count = 3 WHERE id = $1`, [single.id]);
    const removed = await api(a).patch(`/sessions/${s1.body.id}`, session({ roomTypes: [room({ id: triple.id })] })).expect(409);
    expect(removed.body.code).toBe('ROOM_TYPE_IN_USE');
    const low = await api(a).patch(`/sessions/${s1.body.id}`, session({ roomTypes: [room({ id: triple.id }), room({ id: single.id, name: '單人房', bedQuota: 2 })] })).expect(409);
    expect(low.body.code).toBe('CAPACITY_BELOW_SOLD');

    const ok = await api(a).patch(`/sessions/${s1.body.id}`, session({ roomTypes: [room({ id: single.id, name: '單人房', bedQuota: 3 })] })).expect(200);
    expect(ok.body.roomTypes).toMatchObject([{ id: single.id, bedQuota: 3, soldCount: 3 }]);
    const listed = await api(a).get('/sessions').expect(200);
    expect(listed.body.find((s: any) => s.id === s2.body.id).roomTypes).toEqual([]);
  });

  it('名額不能低於已報名加保留中的人數', async () => {
    const a = await makeAgency('admin');
    const s = await api(a).post('/sessions', session({ capacity: 10 })).expect(201);
    const emp = await q1(`INSERT INTO event_employees (agency_id, event_id, employee_no, name) VALUES ($1, $2, 'E1', 'N') RETURNING id`, [a.agencyId, a.eventId]);
    await admin.query(`INSERT INTO seat_holds (agency_id, event_id, event_employee_id, session_id, quantity, expires_at) VALUES ($1, $2, $3, $4, 3, now() + interval '10 minutes')`,
      [a.agencyId, a.eventId, emp.id, s.body.id]);
    const low = await api(a).patch(`/sessions/${s.body.id}`, session({ capacity: 2 })).expect(409);
    expect(low.body.code).toBe('CAPACITY_BELOW_SOLD');
    await api(a).patch(`/sessions/${s.body.id}`, session({ capacity: 3 })).expect(200);
  });

  it('群組的必選、可選項數與志願；志願只用於單選，最多到第三志願', async () => {
    const a = await makeAgency('admin');
    const g = await api(a).post('/option-groups', group()).expect(201);
    await api(a).post('/option-groups', group({ name: 'x', maxSelect: 2 })).expect(422);
    await api(a).post('/option-groups', group({ name: 'x', preferenceCount: 4 })).expect(422);
    const dup = await api(a).post('/option-groups', group()).expect(409);
    expect(dup.body.code).toBe('DUPLICATE_NAME');
    await api(a).patch(`/option-groups/${g.body.id}`, group({ isRequired: false, maxSelect: 2, preferenceCount: 1 })).expect(204);
    const list = await api(a).get('/option-groups').expect(200);
    expect(list.body[0]).toMatchObject({ name: '第二天下午體驗', isRequired: false, maxSelect: 2, preferenceCount: 1, options: [] });
    const row = await q1(`SELECT min_select FROM option_groups WHERE id = $1`, [g.body.id]);
    expect(row.min_select).toBe(0);
  });

  it('選項名額依梯次設定，留空不限；有人選時不能改成不限、不能低於已售、不能刪除', async () => {
    const a = await makeAgency('admin');
    const s1 = (await api(a).post('/sessions', session()).expect(201)).body.id as string;
    const s2 = (await api(a).post('/sessions', session({ name: 'B' })).expect(201)).body.id as string;
    const g = (await api(a).post('/option-groups', group()).expect(201)).body.id as string;
    const o = (await api(a).post(`/option-groups/${g}/options`, { name: '獨木舟', price: 1200, quotas: [{ sessionId: s1, capacity: 20 }, { sessionId: s2, capacity: null }] }).expect(201)).body.id as string;
    const quotas = async () => (await api(a).get('/option-groups').expect(200)).body[0].options[0].quotas;
    expect(await quotas()).toEqual({ [s1]: { capacity: 20, soldCount: 0 } });

    const opt = (capacity: number | null) => ({ name: '獨木舟', price: 1000, quotas: [{ sessionId: s1, capacity }] });
    await admin.query(`UPDATE option_session_quotas SET sold_count = 5 WHERE option_id = $1`, [o]);
    expect((await api(a).patch(`/options/${o}`, opt(4)).expect(409)).body.code).toBe('CAPACITY_BELOW_SOLD');
    expect((await api(a).patch(`/options/${o}`, opt(null)).expect(409)).body.code).toBe('QUOTA_IN_USE');
    await api(a).patch(`/options/${o}`, opt(5)).expect(204);
    await admin.query(`UPDATE option_session_quotas SET sold_count = 0 WHERE option_id = $1`, [o]);
    await api(a).patch(`/options/${o}`, opt(null)).expect(204);
    expect(await quotas()).toEqual({});

    const other = await makeAgency('admin');
    const otherS = (await api(other).post('/sessions', session()).expect(201)).body.id as string;
    await api(a).patch(`/options/${o}`, { ...opt(1), quotas: [{ sessionId: otherS, capacity: 1 }] }).expect(422);
    await api(other).del(`/options/${o}`).expect(404);

    const s = await api(a).post('/sessions', session({ name: 'C' })).expect(201);
    await api(a).patch(`/options/${o}`, { ...opt(9), quotas: [{ sessionId: s.body.id, capacity: 9 }] }).expect(204);
    const emp = await q1(`INSERT INTO event_employees (agency_id, event_id, employee_no, name) VALUES ($1, $2, 'E1', 'N') RETURNING id`, [a.agencyId, a.eventId]);
    const hold = await q1(`INSERT INTO seat_holds (agency_id, event_id, event_employee_id, session_id, quantity, expires_at) VALUES ($1, $2, $3, $4, 1, now() + interval '10 minutes') RETURNING id`,
      [a.agencyId, a.eventId, emp.id, s.body.id]);
    const quota = await q1(`SELECT id FROM option_session_quotas WHERE option_id = $1`, [o]);
    await admin.query(`INSERT INTO seat_hold_items (agency_id, hold_id, quota_id, quantity) VALUES ($1, $2, $3, 1)`, [a.agencyId, hold.id, quota.id]);
    expect((await api(a).del(`/options/${o}`).expect(409)).body.code).toBe('OPTION_IN_USE');
    expect((await api(a).del(`/option-groups/${g}`).expect(409)).body.code).toBe('OPTION_IN_USE');

    // 保留結束後可以刪除，紀錄一併清除
    await admin.query(`UPDATE seat_holds SET status = 'released' WHERE id = $1`, [hold.id]);
    await api(a).del(`/options/${o}`).expect(204);
    await api(a).del(`/option-groups/${g}`).expect(204);
  });

  it('營運人員不能設定，房型資料也受租戶隔離', async () => {
    const a = await makeAgency('operations');
    await api(a).get('/pricing').expect(403);
    await api(a).get('/option-groups').expect(403);
    await api(a).post('/option-groups', group()).expect(403);

    const b = await makeAgency('admin');
    const c = await makeAgency('admin');
    await api(b).post('/sessions', session({ roomTypes: [room()] })).expect(201);
    const rls = await q1(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'session_room_types'`);
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await api(c).get('/sessions').expect(200)).body).toEqual([]);
    await api(c).get(`/pricing`).expect(200);
  });
});

describe('付款說明、條款、服務人員與發布', () => {
  const PDF = Buffer.from('%PDF-1.4 test');
  const root = (a: Ag) => ({ get: (p: string) => request(app.getHttpServer()).get(`/api/v1/agency${p}`).set('x-forwarded-host', a.host).set('cookie', a.cookie) });
  const upload = (a: Ag, content: Buffer, type = 'application/pdf', name = '條款.pdf') =>
    request(app.getHttpServer()).put(`/api/v1/agency/events/${a.eventId}/terms`).query({ name })
      .set('x-forwarded-host', a.host).set('cookie', a.cookie).set('content-type', type).send(content);
  const contact = (o: object = {}) => ({ id: null, name: '李冠廷', phone: '0912-000-111', scope: '報名與付款問題', ...o });
  const paymentBody = (o: object = {}) => ({ paymentInstructions: '請匯款', retentionDays: 180, ...o });

  const draft = async (role = 'admin') => {
    const a = await makeAgency(role);
    await admin.query(`UPDATE events SET status = 'draft', page_is_open = false WHERE id = $1`, [a.eventId]);
    return a;
  };
  /** 補齊所有必要條件，員工本人團費可指定。 */
  const ready = async (fee = 9800) => {
    const a = await draft();
    await admin.query(`INSERT INTO traveler_types (agency_id, event_id, name, base_price, is_employee_self) VALUES ($1, $2, '員工本人', $3, true)`, [a.agencyId, a.eventId, fee]);
    await api(a).post('/sessions', session()).expect(201);
    await api(a).put('/payment-terms', paymentBody()).expect(204);
    await upload(a, PDF).expect(200);
    await api(a).put('/contacts', { contacts: [contact()] }).expect(200);
    return a;
  };
  const states = async (a: Ag) => Object.fromEntries((await api(a).get('/publish-check').expect(200)).body.checks.map((c: any) => [c.key, c.state]));

  it('付款說明與保存期限可以儲存', async () => {
    const a = await draft();
    await api(a).put('/payment-terms', paymentBody({ retentionDays: 365 })).expect(204);
    const e = await root(a).get(`/events/${a.eventId}`).expect(200);
    expect(e.body).toMatchObject({ paymentInstructions: '請匯款', retentionDays: 365, termsFileName: null, termsVersion: 1 });
    await api(a).put('/payment-terms', paymentBody({ retentionDays: 0 })).expect(422);
  });

  it('條款只收 PDF 且有大小上限；更換後版本遞增、舊檔保留', async () => {
    const a = await draft();
    expect((await upload(a, Buffer.from('not a pdf')).expect(422)).body.code).toBe('INVALID_FILE');
    expect((await upload(a, PDF, 'text/plain').expect(422)).body.code).toBe('INVALID_FILE');
    expect((await upload(a, Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)])).expect(413)).body.code).toBe('FILE_TOO_LARGE');

    expect((await upload(a, PDF, undefined, '../../第一版.pdf').expect(200)).body).toEqual({ termsFileName: '....第一版.pdf', termsVersion: 1 });
    const first = await q1(`SELECT terms_object_key FROM events WHERE id = $1`, [a.eventId]);
    expect(first.terms_object_key).toMatch(new RegExp(`^${a.agencyId}/events/${a.eventId}/terms/v1-[0-9a-f]+\\.pdf$`));
    const newer = Buffer.from('%PDF-1.4 newer');
    expect((await upload(a, newer).expect(200)).body.termsVersion).toBe(2);
    const got = await api(a).get('/terms').buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect(got.headers['content-type']).toBe('application/pdf');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.body.equals(newer)).toBe(true);

    const other = await draft();
    await root(other).get(`/events/${a.eventId}/terms`).expect(404);
  });

  it('服務人員整份儲存並依順序；不能套用其他活動的資料', async () => {
    const a = await draft();
    const saved = await api(a).put('/contacts', { contacts: [contact(), contact({ name: '吳佩珊' })] }).expect(200);
    const [first, second] = saved.body;
    const swapped = await api(a).put('/contacts', { contacts: [contact({ id: second.id, name: '吳佩珊' }), contact({ id: first.id, phone: '02-1234' })] }).expect(200);
    expect(swapped.body.map((c: any) => [c.id, c.name, c.phone])).toEqual([[second.id, '吳佩珊', '0912-000-111'], [first.id, '李冠廷', '02-1234']]);
    await api(a).put('/contacts', { contacts: [contact({ phone: '' })] }).expect(422);
    const other = await draft();
    await api(other).put('/contacts', { contacts: [contact({ id: first.id })] }).expect(422);
    await api(a).put('/contacts', { contacts: [] }).expect(200);
  });

  it('發布前檢查列出必須完成與建議處理的項目，缺少時不能發布', async () => {
    const a = await draft();
    await admin.query(`INSERT INTO traveler_types (agency_id, event_id, name, base_price, is_employee_self) VALUES ($1, $2, '員工本人', 100, true)`, [a.agencyId, a.eventId]);
    expect(await states(a)).toMatchObject({ sessions: 'block', terms: 'block', payment: 'block', contacts: 'block', types: 'ok', heroImage: 'warn', roster: 'warn', fields: 'ok' });
    const blocked = await api(a).post('/publish', {}).expect(409);
    expect(blocked.body.code).toBe('PUBLISH_BLOCKED');
    expect(blocked.body.detail.keys).toEqual(['sessions', 'terms', 'payment', 'contacts']);
    expect((await q1(`SELECT status FROM events WHERE id = $1`, [a.eventId])).status).toBe('draft');
  });

  it('必選群組沒有選項不能發布；選填群組沒有選項與床位不足只提醒', async () => {
    const a = await ready();
    const g = await api(a).post('/option-groups', { name: '必選', isRequired: true, maxSelect: 1, preferenceCount: 1 }).expect(201);
    expect((await states(a)).options).toBe('block');
    await api(a).post(`/option-groups/${g.body.id}/options`, { name: 'A', price: 0, quotas: [] }).expect(201);
    expect((await states(a)).options).toBe('ok');
    await api(a).post('/option-groups', { name: '選填', isRequired: false, maxSelect: 1, preferenceCount: 1 }).expect(201);
    expect((await states(a)).options).toBe('warn');
    await api(a).post('/sessions', session({ name: 'B', capacity: 40, roomTypes: [{ id: null, name: '二人房', capacity: 2, surcharge: 0, bedQuota: 10 }] })).expect(201);
    expect((await states(a)).sessions).toBe('warn');
    await api(a).post('/publish', {}).expect(204);
  });

  it('條件齊全才能發布，手動模式活動頁維持關閉，不能重複發布', async () => {
    const a = await ready();
    await api(a).post('/publish', {}).expect(204);
    const e = await root(a).get(`/events/${a.eventId}`).expect(200);
    expect(e.body).toMatchObject({ status: 'published', pageState: 'closed' });
    expect((await api(a).post('/publish', {}).expect(409)).body.code).toBe('EVENT_NOT_DRAFT');
  });

  it('員工本人團費為 0 時要明確確認才能發布', async () => {
    const a = await ready(0);
    expect((await states(a)).types).toBe('confirm');
    const r = await api(a).post('/publish', {}).expect(409);
    expect(r.body.detail.keys).toEqual(['types']);
    await api(a).post('/publish', { confirmFreeSelfFee: true }).expect(204);
  });

  it('發布後不能移除必要條件', async () => {
    const a = await ready();
    await api(a).post('/publish', {}).expect(204);
    expect((await api(a).put('/payment-terms', paymentBody({ paymentInstructions: '' })).expect(409)).body.code).toBe('PUBLISH_REQUIREMENT');
    expect((await api(a).put('/contacts', { contacts: [] }).expect(409)).body.code).toBe('PUBLISH_REQUIREMENT');
    const only = (await api(a).get('/sessions').expect(200)).body[0];
    expect((await api(a).del(`/sessions/${only.id}`).expect(409)).body.code).toBe('PUBLISH_REQUIREMENT');
    const extra = await api(a).post('/sessions', session({ name: 'B' })).expect(201);
    await api(a).del(`/sessions/${extra.body.id}`).expect(204);
  });

  it('群組與選項可以調整順序', async () => {
    const a = await draft();
    const g1 = (await api(a).post('/option-groups', { name: 'G1', isRequired: false, maxSelect: 1, preferenceCount: 1 }).expect(201)).body.id;
    const g2 = (await api(a).post('/option-groups', { name: 'G2', isRequired: false, maxSelect: 1, preferenceCount: 1 }).expect(201)).body.id;
    const o1 = (await api(a).post(`/option-groups/${g1}/options`, { name: 'O1', price: 0, quotas: [] }).expect(201)).body.id;
    const o2 = (await api(a).post(`/option-groups/${g1}/options`, { name: 'O2', price: 0, quotas: [] }).expect(201)).body.id;
    await api(a).put('/option-groups/order', { ids: [g2, g1] }).expect(204);
    await api(a).put(`/option-groups/${g1}/options/order`, { ids: [o2, o1] }).expect(204);
    const list = (await api(a).get('/option-groups').expect(200)).body;
    expect(list.map((g: any) => g.name)).toEqual(['G2', 'G1']);
    expect(list[1].options.map((o: any) => o.name)).toEqual(['O2', 'O1']);
    await api(a).put(`/option-groups/${g1}/options/order`, { ids: [o1] }).expect(422);
  });

  it('營運人員不能設定，服務人員受租戶隔離', async () => {
    const a = await makeAgency('operations');
    await api(a).get('/contacts').expect(403);
    await api(a).get('/publish-check').expect(403);
    await api(a).post('/publish', {}).expect(403);
    await upload(a, PDF).expect(403);
    const rls = await q1(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'event_service_contacts'`);
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});

describe('前台圖片、行程 PDF 與複製活動', () => {
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg')]);
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png')]);
  const WEBP = Buffer.from('RIFF0000WEBPVP8 ');
  const PDF = Buffer.from('%PDF-1.4 itinerary');
  const binary = (req: request.Test) => req.buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
  const put = (a: Ag, path: string, content: Buffer, type: string) => request(app.getHttpServer()).put(`/api/v1/agency/events/${a.eventId}${path}`)
    .set('x-forwarded-host', a.host).set('cookie', a.cookie).set('content-type', type).send(content);
  const grant = (a: Ag) => admin.query(`INSERT INTO agency_quota_ledger (agency_id, pricing_tier_id, change, reason) VALUES ($1, $2, 5, 'grant')`, [a.agencyId, tierId]);
  const pub = (a: Ag, path: string) => request(app.getHttpServer()).get(`/api/v1/public/events/evt${path}`).set('x-forwarded-host', a.host);
  const agencyGet = (a: Ag, path: string) => request(app.getHttpServer()).get(`/api/v1/agency${path}`).set('x-forwarded-host', a.host).set('cookie', a.cookie);
  const session1 = async (a: Ag) => (await api(a).post('/sessions', session()).expect(201)).body.id as string;
  const option = async (a: Ag, name = '獨木舟') => {
    const g = (await api(a).post('/option-groups', { name: `${name}群組`, isRequired: false, maxSelect: 1, preferenceCount: 3 }).expect(201)).body.id as string;
    return { groupId: g, optionId: (await api(a).post(`/option-groups/${g}/options`, { name, price: 500, quotas: [] }).expect(201)).body.id as string };
  };

  it('圖片依內容判斷格式、有大小上限；後台與前台都讀得到，更換後網址改變', async () => {
    const a = await makeAgency('admin');
    await admin.query(`UPDATE events SET status = 'published' WHERE id = $1`, [a.eventId]);
    expect((await put(a, '/images/login', Buffer.from('not image'), 'image/jpeg').expect(422)).body.code).toBe('INVALID_FILE');
    expect((await put(a, '/images/login', Buffer.from('<svg></svg>'), 'image/svg+xml').expect(422)).body.code).toBe('INVALID_FILE');
    expect((await put(a, '/images/login', Buffer.concat([JPG, Buffer.alloc(5 * 1024 * 1024)]), 'image/jpeg').expect(413)).body.code).toBe('FILE_TOO_LARGE');
    await put(a, '/images/nope', JPG, 'image/jpeg').expect(404);

    let landing = (await pub(a, '/landing').expect(200)).body.event.images;
    expect(landing).toEqual({ login: null, loginMobile: null, home: null });
    await pub(a, '/images/login').expect(404);

    await put(a, '/images/login', PNG, 'image/png').expect(200);
    landing = (await pub(a, '/landing').expect(200)).body.event.images;
    expect(landing.login).toMatch(/^\/api\/v1\/public\/events\/evt\/images\/login\?v=/);
    expect(landing.home).toBe(landing.login);
    const img = await binary(pub(a, '/images/login')).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.body.equals(PNG)).toBe(true);

    await put(a, '/images/home', WEBP, 'image/webp').expect(200);
    const changed = (await pub(a, '/landing').expect(200)).body.event.images;
    expect(changed.home).toContain('/images/home');
    expect((await binary(pub(a, '/images/home')).expect(200)).headers['content-type']).toBe('image/webp');
    await put(a, '/images/login', JPG, 'image/jpeg').expect(200);
    expect((await pub(a, '/landing').expect(200)).body.event.images.login).not.toBe(landing.login);

    const detail = (await agencyGet(a, `/events/${a.eventId}`).expect(200)).body;
    expect(detail.images.login).toContain(`/api/v1/agency/events/${a.eventId}/images/login`);
    expect((await binary(agencyGet(a, `/events/${a.eventId}/images/login`)).expect(200)).headers['cache-control']).toBe('private, no-store');

    await api(a).del('/images/home').expect(204);
    await pub(a, '/images/home').expect(404);
    const check = (await api(a).get('/publish-check').expect(200)).body.checks.find((c: any) => c.key === 'heroImage');
    expect(check.state).toBe('ok');
  });

  it('草稿活動的圖片不對外公開，其他旅行社也讀不到', async () => {
    const a = await makeAgency('admin');
    await admin.query(`UPDATE events SET status = 'draft' WHERE id = $1`, [a.eventId]);
    await put(a, '/images/login', JPG, 'image/jpeg').expect(200);
    await pub(a, '/images/login').expect(404);
    await agencyGet(a, `/events/${a.eventId}/images/login`).expect(200);
    const other = await makeAgency('admin');
    await agencyGet(other, `/events/${a.eventId}/images/login`).expect(404);
    const ops = await makeAgency('operations');
    await put(ops, '/images/login', JPG, 'image/jpeg').expect(403);
  });

  it('行程 PDF 選填，每個選項一份；只收 PDF，不能跨活動存取', async () => {
    const a = await makeAgency('admin');
    const { optionId } = await option(a);
    expect((await put(a, `/options/${optionId}/pdf`, Buffer.from('nope'), 'application/pdf').expect(422)).body.code).toBe('INVALID_FILE');
    expect((await put(a, `/options/${optionId}/pdf`, Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]), 'application/pdf').expect(413)).body.code).toBe('FILE_TOO_LARGE');
    await agencyGet(a, `/events/${a.eventId}/options/${optionId}/pdf`).expect(404);
    expect((await put(a, `/options/${optionId}/pdf?name=${encodeURIComponent('行程.pdf')}`, PDF, 'application/pdf').expect(200)).body).toEqual({ pdfFileName: '行程.pdf' });
    expect((await api(a).get('/option-groups').expect(200)).body[0].options[0].pdfFileName).toBe('行程.pdf');
    expect((await binary(agencyGet(a, `/events/${a.eventId}/options/${optionId}/pdf`)).expect(200)).body.equals(PDF)).toBe(true);
    const other = await makeAgency('admin');
    await put(other, `/options/${optionId}/pdf`, PDF, 'application/pdf').expect(404);
    await api(a).del(`/options/${optionId}/pdf`).expect(204);
    expect((await api(a).get('/option-groups').expect(200)).body[0].options[0].pdfFileName).toBeNull();
  });

  it('複製活動帶入設定、不帶梯次與名單，並扣額度', async () => {
    const a = await makeAgency('admin');
    await admin.query(`UPDATE events SET theme_color = '#1F3A8A', itinerary = '{"days":[{"title":"D1","description":""}]}', default_subsidy_amount = 5000, payment_instructions = '請匯款', registration_opens_at = now(), registration_closes_at = now() + interval '1 day' WHERE id = $1`, [a.eventId]);
    await admin.query(`INSERT INTO traveler_types (agency_id, event_id, name, base_price, is_employee_self, sort_order) VALUES ($1, $2, '員工本人', 9800, true, 1), ($1, $2, '嬰兒', 500, false, 2)`, [a.agencyId, a.eventId]);
    await admin.query(`UPDATE traveler_types SET occupies_bed = false, note = '未滿 2 歲' WHERE event_id = $1 AND name = '嬰兒'`, [a.eventId]);
    await api(a).post('/fields', field()).expect(201);
    await put(a, '/images/login', JPG, 'image/jpeg').expect(200);
    await put(a, '/terms?name=terms.pdf', PDF, 'application/pdf').expect(200);
    await put(a, '/terms?name=terms2.pdf', PDF, 'application/pdf').expect(200);
    await api(a).put('/contacts', { contacts: [{ id: null, name: '李冠廷', phone: '0912', scope: '報名' }] }).expect(200);
    const s = await session1(a);
    await api(a).patch(`/sessions/${s}`, session({ roomTypes: [{ id: null, name: '二人房', capacity: 2, surcharge: 0, bedQuota: 2 }] })).expect(200);
    const { optionId } = await option(a);
    await api(a).patch(`/options/${optionId}`, { name: '獨木舟', price: 500, quotas: [{ sessionId: s, capacity: 5 }] }).expect(204);
    await put(a, `/options/${optionId}/pdf?name=x.pdf`, PDF, 'application/pdf').expect(200);
    await q1(`INSERT INTO event_employees (agency_id, event_id, employee_no, name) VALUES ($1, $2, 'E1', 'N') RETURNING id`, [a.agencyId, a.eventId]);

    await grant(a);
    const before = await q1(`SELECT sum(change)::int AS n FROM agency_quota_ledger WHERE agency_id = $1 AND pricing_tier_id = $2`, [a.agencyId, tierId]);
    const companyId = (await q1(`SELECT company_id FROM events WHERE id = $1`, [a.eventId])).company_id;
    const r = await api(a).post('/copy', { companyId, name: '複製活動', slug: `copy-${Date.now()}`, pricingTierId: tierId }).expect(201);
    const after = await q1(`SELECT sum(change)::int AS n FROM agency_quota_ledger WHERE agency_id = $1 AND pricing_tier_id = $2`, [a.agencyId, tierId]);
    expect(after.n).toBe(before.n - 1);

    const c: Ag = { ...a, eventId: r.body.id };
    const e = (await agencyGet(c, `/events/${c.eventId}`).expect(200)).body;
    expect(e).toMatchObject({ name: '複製活動', status: 'draft', pageState: 'closed', themeColor: '#1F3A8A', paymentInstructions: '請匯款', registrationOpensAt: null, termsFileName: 'terms2.pdf', termsVersion: 1 });
    expect(e.days).toHaveLength(1);
    expect(e.images.login).toContain(c.eventId);
    await agencyGet(c, `/events/${c.eventId}/images/login`).expect(200);
    await agencyGet(c, `/events/${c.eventId}/terms`).expect(200);

    const pricing = (await api(c).get('/pricing').expect(200)).body;
    expect(pricing.defaultSubsidyAmount).toBe(5000);
    expect(pricing.types.map((t: any) => [t.name, t.basePrice, t.isEmployeeSelf, t.occupiesBed, t.note])).toEqual([['員工本人', 9800, true, true, null], ['嬰兒', 500, false, false, '未滿 2 歲']]);
    expect((await api(c).get('/sessions').expect(200)).body).toEqual([]);
    expect((await api(c).get('/contacts').expect(200)).body).toHaveLength(1);
    expect((await api(c).get('/fields').expect(200)).body).toHaveLength(1);
    const groups = (await api(c).get('/option-groups').expect(200)).body;
    expect(groups[0]).toMatchObject({ preferenceCount: 3, options: [{ name: '獨木舟', price: 500, pdfFileName: 'x.pdf', quotas: {} }] });
    expect(groups[0].options[0].id).not.toBe(optionId);
    await agencyGet(c, `/events/${c.eventId}/options/${groups[0].options[0].id}/pdf`).expect(200);
    expect((await q1(`SELECT count(*)::int AS n FROM event_employees WHERE event_id = $1`, [c.eventId])).n).toBe(0);

    // 改複製的活動不影響原活動
    await api(c).patch(`/options/${groups[0].options[0].id}`, { name: '改名', price: 1, quotas: [] }).expect(204);
    expect((await api(a).get('/option-groups').expect(200)).body[0].options[0].name).toBe('獨木舟');
    await agencyGet(a, `/events/${a.eventId}/options/${optionId}/pdf`).expect(200);
  });

  it('複製活動檢查額度、代碼、權限，不能複製其他旅行社的活動', async () => {
    const a = await makeAgency('admin');
    const companyId = (await q1(`SELECT company_id FROM events WHERE id = $1`, [a.eventId])).company_id;
    const body = (slug: string) => ({ companyId, name: 'X', slug, pricingTierId: tierId });
    await grant(a);
    const taken = await api(a).post('/copy', body('evt')).expect(409);
    expect(taken.body.code).toBe('SLUG_TAKEN');
    const other = await makeAgency('admin');
    const otherCompany = (await q1(`SELECT company_id FROM events WHERE id = $1`, [other.eventId])).company_id;
    await request(app.getHttpServer()).post(`/api/v1/agency/events/${a.eventId}/copy`).set('x-forwarded-host', other.host).set('cookie', other.cookie)
      .send({ companyId: otherCompany, name: 'X', slug: `steal-${Date.now()}`, pricingTierId: tierId }).expect(404);
    const ops = await makeAgency('operations');
    await api(ops).post('/copy', body('nope-1')).expect(403);
    await admin.query(`DELETE FROM agency_quota_ledger WHERE agency_id = $1`, [a.agencyId]);
    expect((await api(a).post('/copy', body(`q-${Date.now()}`)).expect(409)).body.code).toBe('QUOTA_EMPTY');
  });
});
