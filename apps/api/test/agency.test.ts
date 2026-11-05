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
