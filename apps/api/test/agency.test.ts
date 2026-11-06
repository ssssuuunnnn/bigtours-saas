import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import ExcelJS from 'exceljs';
import { hashPassword, generateToken, hashToken } from '@bigtours/shared/crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { DatabaseService } from '../src/database.service.ts';
import { EncryptionService } from '../src/encryption.service.ts';
import { ExportService } from '../src/export.service.ts';
import { RegistrationService } from '../src/registration.service.ts';
import { MailService } from '../src/mail.service.ts';
import { StorageService } from '../src/storage.service.ts';
import { composeMail, NotificationService } from '../src/notification.service.ts';

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

  it('房型床位不能低於已售加保留中；有人保留或選過的房型不能刪除', async () => {
    const a = await makeAgency('admin');
    const s = await api(a).post('/sessions', session({ roomTypes: [room({ bedQuota: 5 }), room({ name: '單人房', bedQuota: 5 })] })).expect(201);
    const [triple, single] = s.body.roomTypes;
    const emp = await q1(`INSERT INTO event_employees (agency_id, event_id, employee_no, name) VALUES ($1, $2, 'E1', 'N') RETURNING id`, [a.agencyId, a.eventId]);
    const hold = await q1(`INSERT INTO seat_holds (agency_id, event_id, event_employee_id, session_id, quantity, expires_at) VALUES ($1, $2, $3, $4, 3, now() + interval '10 minutes') RETURNING id`, [a.agencyId, a.eventId, emp.id, s.body.id]);
    await admin.query(`INSERT INTO seat_hold_room_items (agency_id, hold_id, room_type_id, quantity) VALUES ($1, $2, $3, 3)`, [a.agencyId, hold.id, triple.id]);
    const both = (o: object) => session({ roomTypes: [room({ id: triple.id, ...o }), room({ id: single.id, name: '單人房', bedQuota: 5 })] });
    expect((await api(a).patch(`/sessions/${s.body.id}`, both({ bedQuota: 2 })).expect(409)).body.code).toBe('CAPACITY_BELOW_SOLD');
    await api(a).patch(`/sessions/${s.body.id}`, both({ bedQuota: 3 })).expect(200);
    expect((await api(a).patch(`/sessions/${s.body.id}`, session({ roomTypes: [room({ id: single.id, name: '單人房' })] })).expect(409)).body.code).toBe('ROOM_TYPE_IN_USE');

    // 保留結束後可以刪；被報名參考過（即使已取消）就不能刪
    await admin.query(`UPDATE seat_holds SET status = 'released' WHERE id = $1`, [hold.id]);
    const type = await q1(`INSERT INTO traveler_types (agency_id, event_id, name, base_price) VALUES ($1, $2, 'T', 0) RETURNING id`, [a.agencyId, a.eventId]);
    const reg = await q1(`INSERT INTO registrations (agency_id, event_id, session_id, event_employee_id, total_amount, payment_status, terms_version_accepted, terms_accepted_at, status) VALUES ($1, $2, $3, $4, 0, 'unpaid', 1, now(), 'cancelled') RETURNING id`, [a.agencyId, a.eventId, s.body.id, emp.id]);
    await admin.query(`INSERT INTO travelers (agency_id, registration_id, traveler_type_id, name, base_price_snapshot, session_room_type_id) VALUES ($1, $2, $3, 'N', 0, $4)`, [a.agencyId, reg.id, type.id, single.id]);
    expect((await api(a).patch(`/sessions/${s.body.id}`, session({ roomTypes: [room({ id: triple.id })] })).expect(409)).body.code).toBe('ROOM_TYPE_IN_USE');
    await api(a).patch(`/sessions/${s.body.id}`, session({ roomTypes: [room({ id: single.id, name: '單人房' })] })).expect(200);
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

describe('員工名單與帳號開通', () => {
  const emp = (o: object = {}) => ({ employeeNo: 'E001', name: '陳怡君', email: 'e001@example.com', department: '研發部', subsidyAmount: null, dependentLimit: null, ...o });
  const csv = (a: Ag, path: string, content: string | Buffer) => request(app.getHttpServer()).post(`/api/v1/agency/events/${a.eventId}/employees/import${path}`)
    .set('x-forwarded-host', a.host).set('cookie', a.cookie).set('content-type', 'text/csv').send(Buffer.from(content));
  const list = async (a: Ag, query = '') => (await api(a).get(`/employees${query}`).expect(200)).body;
  const mail = () => app.get(MailService);
  const until = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error('等待逾時'); };
  const stateOf = async (a: Ag, no: string) => (await list(a, `?search=${no}`)).rows[0]?.accountState;

  it('新增、修改與搜尋；員工編號不能重複，補助留空回傳 null', async () => {
    const a = await makeAgency('admin');
    await api(a).post('/employees', emp({ email: '壞信箱' })).expect(422);
    const id = (await api(a).post('/employees', emp()).expect(201)).body.id;
    expect((await api(a).post('/employees', emp()).expect(409)).body.code).toBe('DUPLICATE_EMPLOYEE_NO');
    await api(a).post('/employees', emp({ employeeNo: 'E002', name: '林雅婷', email: '', subsidyAmount: 12000, dependentLimit: 3 })).expect(201);
    const all = await list(a);
    expect(all).toMatchObject({ total: 2, rosterTotal: 2, pageSize: 50, summary: { none: 1, no_email: 1 } });
    expect(all.rows[0]).toMatchObject({ id, employeeNo: 'E001', subsidyAmount: null, accountState: 'none', registered: false });
    expect((await list(a, '?search=雅婷')).rows.map((r: any) => r.employeeNo)).toEqual(['E002']);
    expect((await list(a, '?search=%25')).total).toBe(0);
    expect((await list(a, '?account=no_email')).rows.map((r: any) => r.employeeNo)).toEqual(['E002']);
    expect((await list(a, '?registration=registered')).total).toBe(0);
    await api(a).patch(`/employees/${id}`, emp({ name: '陳怡君二', subsidyAmount: 500 })).expect(204);
    expect((await list(a)).rows[0]).toMatchObject({ name: '陳怡君二', subsidyAmount: 500 });
    expect((await api(a).patch(`/employees/${id}`, emp({ employeeNo: 'E002' })).expect(409)).body.code).toBe('DUPLICATE_EMPLOYEE_NO');
    const other = await makeAgency('admin');
    await api(other).patch(`/employees/${id}`, emp()).expect(404);
    expect((await api(other).get('/employees').expect(200)).body.total).toBe(0);
  });

  it('開通後不能改員工編號；報名開始後改補助留下紀錄', async () => {
    const a = await makeAgency('admin');
    const id = (await api(a).post('/employees', emp()).expect(201)).body.id;
    await api(a).patch(`/employees/${id}`, emp({ subsidyAmount: 100 })).expect(204);
    const log = await q1(`SELECT actor_type, actor_id IS NOT NULL AS has_actor, metadata FROM audit_logs WHERE agency_id = $1 AND action = 'employee.subsidy_changed' AND target_id = $2`, [a.agencyId, id]);
    expect(log).toEqual({ actor_type: 'agency_user', has_actor: true, metadata: { from: null, to: 100 } });
    await admin.query(`UPDATE events SET registration_opens_at = now() + interval '1 day' WHERE id = $1`, [a.eventId]);
    await api(a).patch(`/employees/${id}`, emp({ subsidyAmount: 200 })).expect(204);
    expect((await admin.query(`SELECT 1 FROM audit_logs WHERE action = 'employee.subsidy_changed' AND target_id = $1`, [id])).rowCount).toBe(1);
    await admin.query(`UPDATE event_employees SET password_set_at = now(), password_hash = 'x' WHERE id = $1`, [id]);
    expect((await api(a).patch(`/employees/${id}`, emp({ employeeNo: 'E999' })).expect(409)).body.code).toBe('EMPLOYEE_NO_LOCKED');
    expect((await list(a)).rows[0].accountState).toBe('activated');
  });

  it('已報名不能移除；移除後不在名單內，重新加入要重新開通', async () => {
    const a = await makeAgency('admin');
    const id = (await api(a).post('/employees', emp()).expect(201)).body.id;
    const s = (await api(a).post('/sessions', session()).expect(201)).body.id;
    const reg = await q1(
      `INSERT INTO registrations (agency_id, event_id, session_id, event_employee_id, total_amount, payment_status, terms_version_accepted, terms_accepted_at)
       VALUES ($1, $2, $3, $4, 0, 'unpaid', 1, now()) RETURNING id`, [a.agencyId, a.eventId, s, id]);
    expect((await list(a)).rows[0].registered).toBe(true);
    expect((await list(a, '?registration=registered')).total).toBe(1);
    expect((await api(a).del(`/employees/${id}`).expect(409)).body.code).toBe('EMPLOYEE_HAS_REGISTRATION');
    await admin.query(`UPDATE registrations SET status = 'cancelled' WHERE id = $1`, [reg.id]);
    await admin.query(`UPDATE event_employees SET password_set_at = now(), password_hash = 'x' WHERE id = $1`, [id]);
    await api(a).del(`/employees/${id}`).expect(204);
    expect((await list(a)).total).toBe(0);
    await api(a).post('/employees', emp({ name: '回來了' })).expect(201);
    expect((await list(a)).rows[0]).toMatchObject({ id, name: '回來了', activated: false });
  });

  it('CSV 預覽不寫入，列出錯誤與重複；確認後才匯入', async () => {
    const a = await makeAgency('admin');
    await api(a).post('/employees', emp({ employeeNo: 'E001', name: '舊名字', subsidyAmount: 100 })).expect(201);
    const file = [
      '員工編號,姓名,部門,Email,補助金額,眷屬人數上限',
      'E001,新名字,研發部,e001@example.com,"8,000",2',
      'E002,林雅婷,,,,',
      ',何美玲,,,,',
      'E003,,,,,',
      'E004,鄭宇軒,,yuxuan@,,',
      'E005,許雅雯,,,八千,',
      'E006,王小明,,,,三人',
      'E002,重複的,,,,',
    ].join('\n');
    const preview = (await csv(a, '/preview', file).expect(200)).body;
    expect(preview).toMatchObject({ newCount: 1, updateCount: 1, errorCount: 5, duplicateCount: 1, issuesTruncated: false });
    expect(preview.issues.map((i: any) => [i.row, i.code])).toEqual([[4, 'MISSING_NO'], [5, 'MISSING_NAME'], [6, 'BAD_EMAIL'], [7, 'BAD_SUBSIDY'], [8, 'BAD_LIMIT'], [9, 'DUPLICATE']]);
    expect(preview.issues[3].value).toBe('八千');
    expect(preview.issues[5].firstRow).toBe(3);
    expect((await list(a)).total).toBe(1);

    expect((await csv(a, '', file).expect(200)).body).toEqual({ created: 1, updated: 1, errorCount: 5, duplicateCount: 1 });
    const rows = (await list(a)).rows;
    expect(rows.map((r: any) => [r.employeeNo, r.name, r.subsidyAmount, r.dependentLimit, r.department])).toEqual([['E001', '新名字', 8000, 2, '研發部'], ['E002', '林雅婷', null, null, null]]);
    expect(mail().sent.filter((m) => m.to === 'e001@example.com' && m.subject.includes('設定密碼')).length).toBe(0);
  });

  it('CSV 接受 UTF-8 BOM 與 Big5，沒有的欄位不動，檔案有問題時回傳明確錯誤', async () => {
    const a = await makeAgency('admin');
    await api(a).post('/employees', emp()).expect(201);
    await csv(a, '', '﻿員工編號,姓名\nE001,改名\n').expect(200);
    expect((await list(a)).rows[0]).toMatchObject({ name: '改名', email: 'e001@example.com', department: '研發部' });
    // 「員工編號,姓名\nE100,王小明」的 Big5 編碼
    const big5 = Buffer.from('rfukdb1zuLksqW2mVwpFMTAwLKT9pHCp+go=', 'base64');
    expect((await csv(a, '/preview', big5).expect(200)).body.newCount).toBe(1);
    await csv(a, '', big5).expect(200);
    expect((await list(a, '?search=E100')).rows[0].name).toBe('王小明');
    expect((await csv(a, '/preview', '姓名,部門\nA,B\n').expect(422)).body.code).toBe('CSV_BAD_HEADER');
    // 真的 Excel 檔（zip）或其他二進位內容不會被當成名單
    expect((await csv(a, '/preview', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff, 0xff])).expect(422)).body.code).toMatch(/INVALID_FILE|CSV_BAD_HEADER/);
    expect((await csv(a, '/preview', '').expect(422)).body.code).toBe('INVALID_FILE');
    const many = ['員工編號,姓名', ...Array.from({ length: 5001 }, (_, i) => `N${i},X`)].join('\n');
    expect((await csv(a, '/preview', many).expect(422)).body.code).toBe('CSV_TOO_MANY_ROWS');
    expect((await csv(a, '/preview', Buffer.alloc(6 * 1024 * 1024, 65)).expect(413)).body.code).toBe('FILE_TOO_LARGE');
  });

  it('從同企業的其他活動複製名單，不帶密碼，已有的不動；不能跨企業', async () => {
    const a = await makeAgency('admin');
    const company = (await q1(`SELECT company_id FROM events WHERE id = $1`, [a.eventId])).company_id;
    const target = await q1(`INSERT INTO events (agency_id, company_id, slug, name, pricing_tier_id) VALUES ($1, $2, 'evt2', 'E2', $3) RETURNING id`, [a.agencyId, company, tierId]);
    const b: Ag = { ...a, eventId: target.id };
    const id = (await api(a).post('/employees', emp({ subsidyAmount: 300 })).expect(201)).body.id;
    await api(a).post('/employees', emp({ employeeNo: 'E002', email: '' })).expect(201);
    await admin.query(`UPDATE event_employees SET password_set_at = now(), password_hash = 'x' WHERE id = $1`, [id]);
    await api(b).post('/employees', emp({ employeeNo: 'E002', name: '已存在' })).expect(201);
    expect((await api(b).get('/employees/copy-sources').expect(200)).body).toEqual([{ id: a.eventId, name: 'E', employees: 2 }]);
    expect((await api(b).post('/employees/copy', { fromEventId: a.eventId }).expect(200)).body).toEqual({ added: 1, skipped: 1 });
    const rows = (await list(b)).rows;
    expect(rows.map((r: any) => [r.employeeNo, r.name, r.subsidyAmount, r.activated])).toEqual([['E001', '陳怡君', 300, false], ['E002', '已存在', null, false]]);
    const other = await makeAgency('admin');
    await api(other).post('/employees/copy', { fromEventId: a.eventId }).expect(404);
  });

  it('寄帳號信：背景寄送含連結、沒信箱跳過、失敗可重寄；連結設定密碼後變已開通', async () => {
    const a = await makeAgency('admin');
    const stamp = randomUUID().slice(0, 8);
    const addr = (n: string) => `${n}-${stamp}@example.com`;
    const ok = (await api(a).post('/employees', emp({ email: addr('ok') })).expect(201)).body.id;
    await api(a).post('/employees', emp({ employeeNo: 'E002', email: '' })).expect(201);
    const bad = (await api(a).post('/employees', emp({ employeeNo: 'E003', email: addr('bad') })).expect(201)).body.id;
    mail().failFor.add(addr('bad'));
    expect((await api(a).post('/employees/account-emails', { employeeIds: [ok, bad] }).expect(202)).body).toEqual({ queued: 2, skipped: 0 });
    await until(async () => (await stateOf(a, 'E001')) === 'sent' && (await stateOf(a, 'E003')) === 'failed');
    expect((await list(a)).summary).toMatchObject({ sent: 1, failed: 1, no_email: 1 });
    const sent = mail().sent.filter((m) => m.to === addr('ok'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.fromName).toBe('T');
    const token = sent[0]!.text.match(/set-password\/(\S+)/)![1]!;
    expect(sent[0]!.html).toContain(`set-password/${token}`);
    expect(sent[0]!.text).not.toContain('E001');

    // 只寄給還沒收到的人：失敗的重寄，沒信箱的跳過
    mail().failFor.delete(addr('bad'));
    expect((await api(a).post('/employees/account-emails', { allPending: true }).expect(202)).body).toEqual({ queued: 1, skipped: 0 });
    await until(async () => (await stateOf(a, 'E003')) === 'sent');
    expect(mail().sent.filter((m) => m.to === addr('ok'))).toHaveLength(1);

    // 連結可用且設定後變已開通
    await request(app.getHttpServer()).post('/api/v1/public/events/evt/password-links/set').set('x-forwarded-host', a.host).set('origin', `http://${a.host}`).send({ token, password: 'abcd1234' }).expect((r) => { if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); });
    expect(await stateOf(a, 'E001')).toBe('activated');
    // 指定寄給已開通的員工（忘記密碼）仍然可以
    expect((await api(a).post('/employees/account-emails', { employeeIds: [ok] }).expect(202)).body.queued).toBe(1);
    await until(async () => mail().sent.filter((m) => m.to === addr('ok')).length === 2);
    await api(a).post('/employees/account-emails', { employeeIds: [] }).expect(422);
  });

  it('寄送中的員工不會重複排入；逾時視為失敗', async () => {
    const a = await makeAgency('admin');
    const id = (await api(a).post('/employees', emp()).expect(201)).body.id;
    const m = await q1(`INSERT INTO email_messages (agency_id, event_id, event_employee_id, recipient_email, template_key, idempotency_key) VALUES ($1, $2, $3, 'x@example.com', 'account', $4) RETURNING id`, [a.agencyId, a.eventId, id, randomUUID()]);
    expect(await stateOf(a, 'E001')).toBe('sending');
    expect((await api(a).post('/employees/account-emails', { employeeIds: [id] }).expect(202)).body).toEqual({ queued: 0, skipped: 1 });
    await admin.query(`UPDATE email_messages SET created_at = now() - interval '20 minutes' WHERE id = $1`, [m.id]);
    expect(await stateOf(a, 'E001')).toBe('failed');
  });

  it('產生連結：舊連結失效、記錄產生人；有信箱才通知且信中不含連結', async () => {
    const a = await makeAgency('admin');
    const stamp = randomUUID().slice(0, 8);
    const to = `link-${stamp}@example.com`;
    const withMail = (await api(a).post('/employees', emp({ email: to })).expect(201)).body.id;
    const noMail = (await api(a).post('/employees', emp({ employeeNo: 'E002', email: '' })).expect(201)).body.id;
    const first = (await api(a).post(`/employees/${withMail}/password-link`, {}).expect(201)).body;
    expect(first).toMatchObject({ slug: 'evt', notified: true, issuedBy: 'A' });
    expect(first.token.length).toBeGreaterThan(20);
    await until(async () => mail().sent.some((m) => m.to === to));
    const notice = mail().sent.find((m) => m.to === to)!;
    expect(notice.text).not.toContain(first.token);
    expect(notice.text).not.toContain('set-password');
    expect(await stateOf(a, 'E001')).toBe('link_issued');
    const second = (await api(a).post(`/employees/${withMail}/password-link`, {}).expect(201)).body;
    expect(second.token).not.toBe(first.token);
    const links = (await admin.query(`SELECT revoked_at IS NOT NULL AS revoked, delivery, created_by_type FROM employee_password_links WHERE event_employee_id = $1 ORDER BY created_at`, [withMail])).rows;
    expect(links).toEqual([{ revoked: true, delivery: 'manual', created_by_type: 'agency_user' }, { revoked: false, delivery: 'manual', created_by_type: 'agency_user' }]);
    expect((await api(a).post(`/employees/${noMail}/password-link`, {}).expect(201)).body.notified).toBe(false);
    const other = await makeAgency('admin');
    await api(other).post(`/employees/${withMail}/password-link`, {}).expect(404);
  });

  it('營運人員不能看名單或開通帳號', async () => {
    const a = await makeAgency('operations');
    await api(a).get('/employees').expect(403);
    await api(a).post('/employees', emp()).expect(403);
    await api(a).post('/employees/account-emails', { allPending: true }).expect(403);
    await csv(a, '/preview', '員工編號,姓名\n').expect(403);
  });
});

describe('報名管理、取消與改派', () => {
  const mail = () => app.get(MailService);
  const until = async (fn: () => boolean) => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error('等待逾時'); };
  const get = (a: Ag, path: string) => request(app.getHttpServer()).get(`/api/v1/agency/events/${a.eventId}${path}`).set('x-forwarded-host', a.host).set('cookie', a.cookie);
  const ENC = () => app.get(EncryptionService);

  const setup = async (role = 'admin') => {
    const a = await makeAgency(role);
    const s = (await q1(`INSERT INTO event_sessions (agency_id, event_id, name, capacity) VALUES ($1, $2, 'A 梯', 100) RETURNING id`, [a.agencyId, a.eventId])).id as string;
    const type = (await q1(`INSERT INTO traveler_types (agency_id, event_id, name, base_price, is_employee_self) VALUES ($1, $2, '員工本人', 10000, true) RETURNING id`, [a.agencyId, a.eventId])).id as string;
    const group = (await q1(`INSERT INTO option_groups (agency_id, event_id, name, max_select, preference_count) VALUES ($1, $2, '下午', 1, 3) RETURNING id`, [a.agencyId, a.eventId])).id as string;
    const option = async (name: string, price: number, capacity: number | null) => {
      const id = (await q1(`INSERT INTO options (agency_id, group_id, name, price) VALUES ($1, $2, $3, $4) RETURNING id`, [a.agencyId, group, name, price])).id as string;
      const quota = capacity === null ? null : (await q1(`INSERT INTO option_session_quotas (agency_id, option_id, session_id, capacity) VALUES ($1, $2, $3, $4) RETURNING id`, [a.agencyId, id, s, capacity])).id as string;
      return { id, quota };
    };
    return { a, s, type, group, option };
  };
  type Ctx = Awaited<ReturnType<typeof setup>>;
  let seq = 0;
  /** 直接建立一筆報名，名額計數也一起更新。 */
  const book = async (c: Ctx, o: { option: { id: string; quota: string | null }; price: number; prefs?: string[]; email?: string | null; subsidy?: number; at?: string; payment?: string }) => {
    seq += 1;
    const no = `E${seq}`;
    const emp = await q1(`INSERT INTO event_employees (agency_id, event_id, employee_no, name, email) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [c.a.agencyId, c.a.eventId, no, `員工${seq}`, o.email ?? null]);
    const total = 10000 + o.price;
    const subsidy = o.subsidy ?? 0;
    const reg = await q1(
      `INSERT INTO registrations (agency_id, event_id, session_id, event_employee_id, total_amount, subsidy_amount, payment_status, terms_version_accepted, terms_accepted_at, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, now(), $8) RETURNING id`,
      [c.a.agencyId, c.a.eventId, c.s, emp.id, total, subsidy, o.payment ?? (total > subsidy ? 'unpaid' : 'not_required'), o.at ?? new Date().toISOString()],
    );
    const t = await q1(`INSERT INTO travelers (agency_id, registration_id, traveler_type_id, is_employee_self, name, base_price_snapshot, sensitive_values_encrypted, sensitive_masks) VALUES ($1, $2, $3, true, $4, 10000, $5, $6) RETURNING id`,
      [c.a.agencyId, reg.id, c.type, `員工${seq}`, ENC().encryptJson({ nid: 'A123456789' }), JSON.stringify({ nid: 'A1*******9' })]);
    await admin.query(`INSERT INTO traveler_options (agency_id, traveler_id, option_id, price_snapshot) VALUES ($1, $2, $3, $4)`, [c.a.agencyId, t.id, o.option.id, o.price]);
    for (const [i, optionId] of (o.prefs ?? []).entries()) {
      await admin.query(`INSERT INTO traveler_option_preferences (agency_id, traveler_id, group_id, rank, option_id) VALUES ($1, $2, $3, $4, $5)`, [c.a.agencyId, t.id, c.group, i + 2, optionId]);
    }
    await admin.query(`UPDATE event_sessions SET sold_count = sold_count + 1 WHERE id = $1`, [c.s]);
    if (o.option.quota) await admin.query(`UPDATE option_session_quotas SET sold_count = sold_count + 1 WHERE id = $1`, [o.option.quota]);
    return { id: reg.id as string, travelerId: t.id as string, no, employeeId: emp.id as string };
  };
  const soldOf = async (quota: string) => (await q1(`SELECT sold_count FROM option_session_quotas WHERE id = $1`, [quota])).sold_count as number;

  it('總覽與列表：統計、篩選，已取消預設不列出', async () => {
    const c = await setup();
    const o = await c.option('獨木舟', 1200, 20);
    const r1 = await book(c, { option: o, price: 1200 });
    const r2 = await book(c, { option: o, price: 1200, subsidy: 50000 });
    const r3 = await book(c, { option: o, price: 1200 });
    await admin.query(`UPDATE registrations SET status = 'cancel_requested', cancel_requested_at = now() WHERE id = $1`, [r2.id]);
    await admin.query(`UPDATE registrations SET status = 'cancelled' WHERE id = $1`, [r3.id]);
    const ov = (await get(c.a, '/overview').expect(200)).body;
    expect(ov).toMatchObject({ roster: 3, registered: 2, pendingCancels: 1, unpaid: 1, travelers: 2 });
    expect(ov.sessions[0]).toMatchObject({ name: 'A 梯', capacity: 100, sold: 3, held: 0, remaining: 97 });

    const all = (await get(c.a, '/registrations').expect(200)).body;
    expect(all).toMatchObject({ total: 2, registrations: 2, travelers: 2 });
    expect(all.rows[0]).toMatchObject({ id: r2.id, status: 'cancel_requested', selfPayAmount: 0, paymentStatus: 'not_required', travelerCount: 1, sessionName: 'A 梯' });
    expect((await get(c.a, '/registrations?status=cancelled').expect(200)).body.rows.map((r: any) => r.id)).toEqual([r3.id]);
    expect((await get(c.a, '/registrations?payment=unpaid').expect(200)).body.rows.map((r: any) => r.id)).toEqual([r1.id]);
    expect((await get(c.a, `/registrations?search=${r1.no}`).expect(200)).body.rows.map((r: any) => r.id)).toEqual([r1.id]);
    expect((await get(c.a, `/registrations?session=${randomUUID()}`).expect(200)).body.total).toBe(0);
    const other = await makeAgency('admin');
    await request(app.getHttpServer()).get(`/api/v1/agency/events/${c.a.eventId}/registrations/${r1.id}`).set('x-forwarded-host', other.host).set('cookie', other.cookie).expect(404);
  });

  it('明細只顯示遮罩；完整個資限管理員且留下紀錄', async () => {
    const c = await setup('admin');
    const o = await c.option('獨木舟', 1200, 20);
    const o2 = await c.option('手作', 0, null);
    await admin.query(`INSERT INTO event_fields (agency_id, event_id, field_key, label, field_type, is_sensitive) VALUES ($1, $2, 'nid', '身分證', 'text', true)`, [c.a.agencyId, c.a.eventId]);
    const r = await book(c, { option: o, price: 1200, prefs: [o2.id] });
    const d = (await get(c.a, `/registrations/${r.id}`).expect(200)).body;
    expect(d).toMatchObject({ employeeNo: r.no, totalAmount: 11200, canViewSensitive: true });
    expect(d.travelers[0]).toMatchObject({ fee: 11200, options: [{ name: '獨木舟', price: 1200 }], preferences: [{ rank: 2, optionName: '手作' }] });
    expect(d.travelers[0].fields).toEqual([{ key: 'nid', label: '身分證', value: 'A1*******9', sensitive: true }]);
    expect(JSON.stringify(d)).not.toContain('A123456789');
    const reveal = (await api(c.a).post(`/registrations/${r.id}/sensitive`, {}).expect(200)).body;
    expect(reveal[r.travelerId]).toEqual({ nid: 'A123456789' });
    const log = await q1(`SELECT actor_id IS NOT NULL AS actor FROM audit_logs WHERE action = 'registration.sensitive_viewed' AND target_id = $1`, [r.id]);
    expect(log.actor).toBe(true);

    const op = await setup('event_operator');
    const o3 = await op.option('X', 0, null);
    const r3 = await book(op, { option: o3, price: 0 });
    expect((await get(op.a, `/registrations/${r3.id}`).expect(200)).body.canViewSensitive).toBe(false);
    await api(op.a).post(`/registrations/${r3.id}/sensitive`, {}).expect(403);
  });

  it('營運人員可以處理報名，但看不到完整個資', async () => {
    const c = await setup('operations');
    const o = await c.option('X', 0, null);
    const r = await book(c, { option: o, price: 0 });
    await get(c.a, '/overview').expect(200);
    await get(c.a, '/registrations').expect(200);
    await api(c.a).put(`/registrations/${r.id}/payment`, { status: 'paid' }).expect(204);
    await api(c.a).post(`/registrations/${r.id}/sensitive`, {}).expect(403);
  });

  it('付款狀態留下紀錄；自付 0 不能標記；調整費用要原因且會改付款狀態', async () => {
    const c = await setup();
    const o = await c.option('X', 0, null);
    const r = await book(c, { option: o, price: 0, subsidy: 3000 });
    await api(c.a).put(`/registrations/${r.id}/payment`, { status: 'not_required' }).expect(422);
    await api(c.a).put(`/registrations/${r.id}/payment`, { status: 'paid' }).expect(204);
    await api(c.a).put(`/registrations/${r.id}/payment`, { status: 'paid' }).expect(204);
    let d = (await get(c.a, `/registrations/${r.id}`).expect(200)).body;
    expect(d.paymentStatus).toBe('paid');
    expect(d.revisions).toHaveLength(1);
    expect(d.revisions[0]).toMatchObject({ actorName: 'A', summary: { action: 'payment', from: 'unpaid', to: 'paid' } });

    await api(c.a).put(`/registrations/${r.id}/fee`, { totalAmount: 500, reason: '' }).expect(422);
    await api(c.a).put(`/registrations/${r.id}/fee`, { totalAmount: 2000, reason: '改住單人房' }).expect(204);
    d = (await get(c.a, `/registrations/${r.id}`).expect(200)).body;
    expect(d).toMatchObject({ totalAmount: 2000, subsidyApplied: 2000, selfPayAmount: 0, paymentStatus: 'paid' });
    expect(d.revisions[0].summary).toEqual({ action: 'fee_adjusted', from: 10000, to: 2000, reason: '改住單人房' });
    expect((await api(c.a).put(`/registrations/${r.id}/payment`, { status: 'unpaid' }).expect(409)).body.code).toBe('PAYMENT_NOT_REQUIRED');

    const r2 = await book(c, { option: o, price: 0, subsidy: 3000 });
    await api(c.a).put(`/registrations/${r2.id}/fee`, { totalAmount: 100, reason: '折扣' }).expect(204);
    expect((await get(c.a, `/registrations/${r2.id}`).expect(200)).body.paymentStatus).toBe('not_required');
    await api(c.a).put(`/registrations/${r2.id}/fee`, { totalAmount: 9000, reason: '更正' }).expect(204);
    expect((await get(c.a, `/registrations/${r2.id}`).expect(200)).body.paymentStatus).toBe('unpaid');
  });

  it('確認取消釋出名額並通知；退回後報名維持有效；不能重複處理', async () => {
    const c = await setup();
    const o = await c.option('X', 1000, 5);
    const stamp = randomUUID().slice(0, 8);
    const r = await book(c, { option: o, price: 1000, email: `cancel-${stamp}@example.com` });
    expect((await api(c.a).post(`/registrations/${r.id}/cancel/confirm`, {}).expect(409)).body.code).toBe('NOT_CANCELLABLE');
    await admin.query(`UPDATE registrations SET status = 'cancel_requested', cancel_requested_at = now() WHERE id = $1`, [r.id]);
    await api(c.a).post(`/registrations/${r.id}/cancel/reject`, {}).expect(204);
    let d = (await get(c.a, `/registrations/${r.id}`).expect(200)).body;
    expect(d).toMatchObject({ status: 'confirmed', cancelRequestedAt: null });
    await until(() => mail().sent.some((m) => m.to === `cancel-${stamp}@example.com` && m.subject.includes('未通過')));

    await admin.query(`UPDATE registrations SET status = 'cancel_requested', cancel_requested_at = now() WHERE id = $1`, [r.id]);
    await api(c.a).post(`/registrations/${r.id}/cancel/confirm`, {}).expect(204);
    d = (await get(c.a, `/registrations/${r.id}`).expect(200)).body;
    expect(d.status).toBe('cancelled');
    expect(d.revisions[0].summary.action).toBe('cancel_confirmed');
    expect(await soldOf(o.quota!)).toBe(0);
    expect((await q1(`SELECT sold_count FROM event_sessions WHERE id = $1`, [c.s])).sold_count).toBe(0);
    await until(() => mail().sent.some((m) => m.to === `cancel-${stamp}@example.com` && m.subject.includes('已取消')));
    expect((await api(c.a).post(`/registrations/${r.id}/cancel/reject`, {}).expect(409)).body.code).toBe('NOT_CANCELLABLE');
    expect((await api(c.a).put(`/registrations/${r.id}/fee`, { totalAmount: 1, reason: 'x' }).expect(409)).body.code).toBe('REGISTRATION_CANCELLED');
  });

  it('改派預填依報名先後、志願與剩餘名額；已滿或沒填志願留待選擇', async () => {
    const c = await setup();
    const src = await c.option('獨木舟', 1200, 20);
    const a = await c.option('手作', 600, 1);
    const b = await c.option('步道', 0, null);
    const first = await book(c, { option: src, price: 1200, prefs: [a.id, b.id], at: '2026-01-01T00:00:00Z' });
    const second = await book(c, { option: src, price: 1200, prefs: [a.id, b.id], at: '2026-01-02T00:00:00Z' });
    const third = await book(c, { option: src, price: 1200, prefs: [a.id], at: '2026-01-03T00:00:00Z' });
    const fourth = await book(c, { option: src, price: 1200, at: '2026-01-04T00:00:00Z' });
    expect((await get(c.a, '/reassign/sources').expect(200)).body).toEqual([expect.objectContaining({ sessionId: c.s, optionId: src.id, optionName: '獨木舟', travelers: 4 })]);
    const plan = (await get(c.a, `/reassign/plan?sessionId=${c.s}&optionId=${src.id}`).expect(200)).body;
    expect(plan.targets.map((t: any) => [t.name, t.remaining])).toEqual([['手作', 1], ['步道', null]]);
    expect(plan.travelers.map((t: any) => t.suggested)).toEqual([a.id, b.id, null, null]);
    expect(plan.travelers.map((t: any) => t.id)).toEqual([first.travelerId, second.travelerId, third.travelerId, fourth.travelerId]);
    await get(c.a, `/reassign/plan?sessionId=${c.s}&optionId=${randomUUID()}`).expect(404);
  });

  it('確認改派：名額搬動、費用重算、付款狀態、志願調整、修改紀錄與通知', async () => {
    const c = await setup();
    const src = await c.option('獨木舟', 1200, 20);
    const a = await c.option('手作', 600, 2);
    const b = await c.option('步道', 0, null);
    const stamp = randomUUID().slice(0, 8);
    const r1 = await book(c, { option: src, price: 1200, prefs: [a.id, b.id], email: `ra-${stamp}@example.com` });
    const r2 = await book(c, { option: src, price: 1200, subsidy: 10000, prefs: [b.id] });
    const stay = await book(c, { option: src, price: 1200 });
    await api(c.a).post('/reassign', { sessionId: c.s, optionId: src.id, reason: '', assignments: [] }).expect(422);
    const res = await api(c.a).post('/reassign', {
      sessionId: c.s, optionId: src.id, reason: '天候不佳',
      assignments: [{ travelerId: r1.travelerId, toOptionId: a.id }, { travelerId: r2.travelerId, toOptionId: b.id }],
    }).expect(200);
    expect(res.body).toEqual({ moved: 2, registrations: 2 });
    expect(await soldOf(src.quota!)).toBe(1);
    expect(await soldOf(a.quota!)).toBe(1);

    const d1 = (await get(c.a, `/registrations/${r1.id}`).expect(200)).body;
    expect(d1.totalAmount).toBe(10600);
    expect(d1.travelers[0].options).toEqual([{ name: '手作', price: 600 }]);
    expect(d1.travelers[0].preferences).toEqual([{ rank: 2, optionName: '步道' }]);
    expect(d1.revisions[0].summary).toMatchObject({ action: 'reassigned', from: 11200, to: 10600, reason: '天候不佳' });
    const d2 = (await get(c.a, `/registrations/${r2.id}`).expect(200)).body;
    expect(d2).toMatchObject({ totalAmount: 10000, selfPayAmount: 0, paymentStatus: 'not_required' });
    expect((await get(c.a, `/registrations/${stay.id}`).expect(200)).body.totalAmount).toBe(11200);

    await until(() => mail().sent.some((m) => m.to === `ra-${stamp}@example.com`));
    const sent = mail().sent.find((m) => m.to === `ra-${stamp}@example.com`)!;
    expect(sent.text).toContain('天候不佳');
    expect(sent.text).toContain('獨木舟 → 手作');
    expect(sent.text).toContain('$10,600');
  });

  it('改派名額不足時整批不生效；不能指派不屬於這個行程或同群組的資料', async () => {
    const c = await setup();
    const src = await c.option('獨木舟', 1200, 20);
    const a = await c.option('手作', 600, 1);
    const b = await c.option('步道', 0, null);
    const r1 = await book(c, { option: src, price: 1200 });
    const r2 = await book(c, { option: src, price: 1200 });
    const r3 = await book(c, { option: a, price: 600 });
    const full = await api(c.a).post('/reassign', { sessionId: c.s, optionId: src.id, reason: 'x', assignments: [{ travelerId: r1.travelerId, toOptionId: a.id }, { travelerId: r2.travelerId, toOptionId: a.id }] }).expect(409);
    expect(full.body.code).toBe('OPTION_FULL');
    expect(await soldOf(src.quota!)).toBe(2);
    expect((await get(c.a, `/registrations/${r1.id}`).expect(200)).body.travelers[0].options[0].name).toBe('獨木舟');
    await api(c.a).post('/reassign', { sessionId: c.s, optionId: src.id, reason: 'x', assignments: [{ travelerId: r3.travelerId, toOptionId: b.id }] }).expect(422);
    await api(c.a).post('/reassign', { sessionId: c.s, optionId: src.id, reason: 'x', assignments: [{ travelerId: r1.travelerId, toOptionId: src.id }] }).expect(422);
    await api(c.a).post('/reassign', { sessionId: c.s, optionId: src.id, reason: 'x', assignments: [{ travelerId: r1.travelerId, toOptionId: randomUUID() }] }).expect(422);
  });

  describe('旅行社修改報名', () => {
    const put = (c: Ctx, id: string, body: object) => api(c.a).put(`/registrations/${id}`, body);
    const edit = (c: Ctx, r: { travelerId: string }, optionId: string, patch: object = {}) => ({
      sessionId: c.s,
      travelers: [{ key: r.travelerId, travelerTypeId: c.type, optionIds: [optionId], name: '改過的名字', fieldValues: {}, requestedRoomNo: 1 }],
      roomPreferences: [],
      ...patch,
    });

    it('報名截止後仍可修改，名額搬動、費用更新、已付款維持已付並顯示差額', async () => {
      const c = await setup();
      const o = await c.option('獨木舟', 1200, 20);
      const o2 = await c.option('手作', 2000, 20);
      const r = await book(c, { option: o, price: 1200, email: 'e@example.com' });
      await admin.query(`UPDATE events SET registration_closes_at = now() - interval '1 day' WHERE id = $1`, [c.a.eventId]);
      await api(c.a).put(`/registrations/${r.id}/payment`, { status: 'paid' }).expect(204);

      const data = (await get(c.a, `/registrations/${r.id}/edit`).expect(200)).body;
      expect(data.registration.travelers[0].id).toBe(r.travelerId);
      expect(data.registration.totalAmount).toBe(11200);
      expect(data.optionGroups[0].options.length).toBe(2);

      mail().sent.length = 0;
      await put(c, r.id, edit(c, r, o2.id)).expect(204);
      expect(await soldOf(o.quota!)).toBe(0);
      expect(await soldOf(o2.quota!)).toBe(1);

      const d = (await get(c.a, `/registrations/${r.id}`).expect(200)).body;
      expect(d).toMatchObject({ totalAmount: 12000, paymentStatus: 'paid', paidAmount: 11200, paymentDiff: 800 });
      expect(d.travelers[0].name).toBe('改過的名字');
      expect((await get(c.a, '/registrations').expect(200)).body.rows[0].paymentDiff).toBe(800);
      await until(() => mail().sent.some((m) => m.subject.includes('報名內容已修改')));

      const rev = d.revisions[0];
      expect(rev).toMatchObject({ hasContent: true, actorType: 'agency_user', summary: { action: 'modified', from: 11200, to: 12000 } });
      const content = (await get(c.a, `/registrations/${r.id}/revisions/${rev.no}`).expect(200)).body;
      expect(content.before.travelers[0]).toMatchObject({ name: '員工' + r.no.slice(1), options: [{ name: '獨木舟', price: 1200 }] });
      expect(content.after.travelers[0]).toMatchObject({ name: '改過的名字', options: [{ name: '手作', price: 2000 }] });
      expect(content.after.total).toBe(12000);
    });

    it('紀錄裡的敏感欄位只有遮罩；留空保留原值', async () => {
      const c = await setup();
      const o = await c.option('獨木舟', 0, null);
      await admin.query(`INSERT INTO event_fields (agency_id, event_id, field_key, label, field_type, is_required, is_sensitive) VALUES ($1, $2, 'nid', '身分證', 'text', true, true)`, [c.a.agencyId, c.a.eventId]);
      const r = await book(c, { option: o, price: 0 });
      await put(c, r.id, edit(c, r, o.id)).expect(204);
      const d = (await get(c.a, `/registrations/${r.id}`).expect(200)).body;
      const res = await get(c.a, `/registrations/${r.id}/revisions/${d.revisions[0].no}`).expect(200);
      expect(JSON.stringify(res.body)).not.toContain('A123456789');
      expect(res.body.after.travelers[0].fields).toEqual([{ label: '身分證', value: 'A1*******9' }]);
      const row = await q1(`SELECT sensitive_values_encrypted AS e FROM travelers WHERE id = $1`, [r.travelerId]);
      expect(ENC().decryptJson(row.e)).toEqual({ nid: 'A123456789' });
    });

    it('名額不足、已取消、別家旅行社都不能修改；紀錄版本不存在回 404', async () => {
      const c = await setup();
      const o = await c.option('獨木舟', 0, 20);
      const full = await c.option('滿了', 0, 0);
      const r = await book(c, { option: o, price: 0 });
      expect((await put(c, r.id, edit(c, r, full.id)).expect(409)).body.code).toBe('OPTION_FULL');
      expect(await soldOf(o.quota!)).toBe(1);
      await get(c.a, `/registrations/${r.id}/revisions/99`).expect(404);

      const other = await makeAgency('admin');
      await request(app.getHttpServer()).put(`/api/v1/agency/events/${c.a.eventId}/registrations/${r.id}`).set('x-forwarded-host', other.host).set('cookie', other.cookie).send(edit(c, r, o.id)).expect(404);

      await admin.query(`UPDATE registrations SET status = 'cancelled' WHERE id = $1`, [r.id]);
      expect((await put(c, r.id, edit(c, r, o.id)).expect(409)).body.code).toBe('NOT_MODIFIABLE');
    });
  });

  it('員工申請取消會留在修改紀錄', async () => {
    const c = await setup();
    const o = await c.option('X', 0, null);
    const r = await book(c, { option: o, price: 0 });
    const token = generateToken();
    await admin.query(`INSERT INTO employee_sessions (agency_id, event_employee_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`, [c.a.agencyId, r.employeeId, hashToken(process.env.TOKEN_HASH_KEY!, token)]);
    await admin.query(`UPDATE events SET page_is_open = true WHERE id = $1`, [c.a.eventId]);
    await request(app.getHttpServer()).post('/api/v1/public/events/evt/registrations/current/cancel-request').set('x-forwarded-host', c.a.host).set('cookie', `bt_session=${token}`).expect(200);
    const d = (await get(c.a, `/registrations/${r.id}`).expect(200)).body;
    expect(d.status).toBe('cancel_requested');
    expect(d.revisions[0]).toMatchObject({ actorType: 'employee', summary: { action: 'cancel_requested' } });
  });
});

describe('Email 通知', () => {
  const mail = () => app.get(MailService);
  const until = async (fn: () => boolean) => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error('等待逾時'); };
  const employee = async (a: Ag, no: string, email: string | null) => (await q1(`INSERT INTO event_employees (agency_id, event_id, employee_no, name, email) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [a.agencyId, a.eventId, no, `員工${no}`, email])).id as string;
  const body = { senderName: '山海旅遊', subject: '【[活動名稱]】提醒', body: '[員工姓名] 您好\n\n請在 [截止時間] 前報名：[報名網站連結]' };
  const openEvent = (a: Ag) => admin.query(`UPDATE events SET status = 'published', registration_opens_at = now() - interval '1 day', registration_closes_at = now() + interval '3 days' WHERE id = $1`, [a.eventId]);

  it('範本未自訂時用預設；儲存後只影響這個活動，可還原', async () => {
    const a = await makeAgency('admin');
    const before = (await api(a).get('/emails').expect(200)).body;
    const t = before.templates.find((x: any) => x.key === 'deadline_reminder');
    expect(t).toMatchObject({ customized: false, senderName: null });
    expect(before.templates.map((x: any) => x.label)).toContain('新的取消申請（寄給旅行社）');
    await api(a).put('/emails/templates/deadline_reminder', body).expect(204);
    const after = (await api(a).get('/emails').expect(200)).body.templates.find((x: any) => x.key === 'deadline_reminder');
    expect(after).toMatchObject({ customized: true, subject: body.subject, senderName: '山海旅遊' });
    await api(a).del('/emails/templates/deadline_reminder').expect(204);
    expect((await api(a).get('/emails').expect(200)).body.templates.find((x: any) => x.key === 'deadline_reminder').customized).toBe(false);
  });

  it('不認得的欄位或少了必要欄位不能儲存；不存在的範本回 404', async () => {
    const a = await makeAgency('admin');
    const bad = await api(a).put('/emails/templates/deadline_reminder', { ...body, body: '[身分證字號] 您好' }).expect(400);
    expect(bad.body).toMatchObject({ code: 'TEMPLATE_INVALID', detail: { unknown: ['身分證字號'] } });
    const missing = await api(a).put('/emails/templates/account', { ...body, subject: '帳號', body: '請設定密碼' }).expect(400);
    expect(missing.body.detail.missing).toEqual(['設定密碼連結']);
    await api(a).put('/emails/templates/nope', body).expect(404);
  });

  it('測試信用未儲存的內容寄給操作者，不留紀錄', async () => {
    const a = await makeAgency('admin');
    const email = (await q1(`SELECT u.email FROM agency_users u WHERE u.agency_id = $1 LIMIT 1`, [a.agencyId])).email;
    const res = await api(a).post('/emails/templates/deadline_reminder/test', body).expect(201);
    expect(res.body.to).toBe(email);
    const sent = mail().sent.filter((m) => m.to === email).at(-1)!;
    expect(sent.subject).toContain('［測試］');
    expect(sent.fromName).toBe('山海旅遊');
    expect(sent.text).toContain('1/29 18:00');
    expect((await q1(`SELECT count(*)::int AS n FROM email_messages WHERE event_id = $1`, [a.eventId])).n).toBe(0);
  });

  it('截止前提醒只寄給有信箱且未報名的員工，並套用自訂範本；截止後不能寄', async () => {
    const a = await makeAgency('admin');
    await openEvent(a);
    await api(a).put('/emails/templates/deadline_reminder', body).expect(204);
    const tag = randomUUID().slice(0, 8);
    await employee(a, 'P1', `p1-${tag}@example.com`);
    await employee(a, 'P2', null);
    const done = await employee(a, 'P3', `p3-${tag}@example.com`);
    const session = (await q1(`INSERT INTO event_sessions (agency_id, event_id, name, capacity) VALUES ($1, $2, 'A', 10) RETURNING id`, [a.agencyId, a.eventId])).id;
    await admin.query(`INSERT INTO registrations (agency_id, event_id, session_id, event_employee_id, total_amount, subsidy_amount, payment_status, terms_version_accepted, terms_accepted_at) VALUES ($1, $2, $3, $4, 100, 0, 'unpaid', 1, now())`, [a.agencyId, a.eventId, session, done]);

    expect((await api(a).get('/emails').expect(200)).body.reminder).toMatchObject({ pending: 1, noEmail: 1, sendable: true, lastSentAt: null });
    expect((await api(a).post('/emails/deadline-reminder', {}).expect(201)).body.queued).toBe(1);
    await until(() => mail().sent.some((m) => m.to === `p1-${tag}@example.com`));
    expect(mail().sent.some((m) => m.to === `p3-${tag}@example.com`)).toBe(false);
    const sent = mail().sent.find((m) => m.to === `p1-${tag}@example.com`)!;
    expect(sent.text).toContain('員工P1 您好');
    expect(sent.fromName).toBe('山海旅遊');
    expect((await api(a).get('/emails').expect(200)).body.reminder.lastSentAt).not.toBeNull();

    await admin.query(`UPDATE events SET registration_closes_at = now() - interval '1 minute' WHERE id = $1`, [a.eventId]);
    expect((await api(a).post('/emails/deadline-reminder', {}).expect(409)).body.code).toBe('REGISTRATION_CLOSED');
  });

  it('寄送失敗列出原因，可修正信箱後重寄，重寄後不再列出', async () => {
    const a = await makeAgency('admin');
    await openEvent(a);
    const tag = randomUUID().slice(0, 8);
    const bad = `bad-${tag}@example.com`;
    const id = await employee(a, 'F1', bad);
    mail().failFor.add(bad);
    await api(a).post('/emails/deadline-reminder', {}).expect(201);
    const failed = async () => (await api(a).get('/emails').expect(200)).body;
    for (let i = 0; i < 100 && (await failed()).failures.length === 0; i++) await new Promise((r) => setTimeout(r, 30));
    const view = await failed();
    expect(view.stats).toMatchObject({ total: 1, failed: 1 });
    expect(view.failures[0]).toMatchObject({ employeeName: '員工F1', employeeNo: 'F1', label: '截止前提醒', email: bad, isEmployee: true });

    const good = `good-${tag}@example.com`;
    await api(a).post(`/emails/messages/${view.failures[0].id}/resend`, { email: good }).expect(204);
    await until(() => mail().sent.some((m) => m.to === good));
    expect(mail().sent.find((m) => m.to === good)!.text).toContain('截止');
    expect((await failed()).failures).toEqual([]);
    expect((await q1(`SELECT email FROM event_employees WHERE id = $1`, [id])).email).toBe(good);
    await api(a).post(`/emails/messages/${view.failures[0].id}/resend`, {}).expect(404);
    mail().failFor.delete(bad);
  });

  it('帳號信重寄會重新產生連結，失敗紀錄不存連結', async () => {
    const a = await makeAgency('admin');
    const tag = randomUUID().slice(0, 8);
    const bad = `acc-${tag}@example.com`;
    const id = await employee(a, 'A1', bad);
    mail().failFor.add(bad);
    await api(a).post('/employees/account-emails', { employeeIds: [id] });
    const failed = async () => (await api(a).get('/emails').expect(200)).body.failures;
    for (let i = 0; i < 100 && (await failed()).length === 0; i++) await new Promise((r) => setTimeout(r, 30));
    const [f] = await failed();
    expect((await q1(`SELECT payload FROM email_messages WHERE id = $1`, [f.id])).payload).toBeNull();
    const good = `acc2-${tag}@example.com`;
    await api(a).post(`/emails/messages/${f.id}/resend`, { email: good }).expect(204);
    await until(() => mail().sent.some((m) => m.to === good));
    expect(mail().sent.find((m) => m.to === good)!.text).toContain('/set-password/');
    mail().failFor.delete(bad);
  });

  it('通知信箱：新的取消申請與員工修改寄給設定的信箱，沒設定就不寄', async () => {
    const a = await makeAgency('admin');
    const service = app.get(NotificationService);
    const tag = randomUUID().slice(0, 8);
    const before = mail().sent.length;
    const template = { key: 'agency_cancel_requested', employeeName: '王', employeeNo: 'E9', sessionName: 'A', eventId: a.eventId, registrationId: randomUUID() } as const;
    await service.notifyAgency(a.agencyId, a.eventId, template);
    expect(mail().sent.length).toBe(before);
    await api(a).put('/emails/notify-emails', { emails: [`ops-${tag}@example.com`, `OPS-${tag}@example.com`, `tc-${tag}@example.com`] }).expect(204);
    expect((await api(a).get('/emails').expect(200)).body.notifyEmails).toEqual([`ops-${tag}@example.com`, `tc-${tag}@example.com`]);
    await service.notifyAgency(a.agencyId, a.eventId, template);
    const got = mail().sent.filter((m) => m.to.endsWith(`-${tag}@example.com`));
    expect(got).toHaveLength(2);
    expect(got[0]!.text).toContain(`/admin/events/${a.eventId}/registrations?registration=`);
    await api(a).put('/emails/notify-emails', { emails: ['not-an-email'] }).expect(422);
  });

  it('信中的文字會跳脫，沒有值的段落不留空', async () => {
    const m = composeMail({ name: 'E<1>', slug: 's', agency_code: 'c', agency_name: 'A' }, { id: null, name: '王', email: 'x@example.com' }, { key: 'registration_success', sessionName: 'A', travelers: 1, total: 100, subsidy: 100, selfPay: 0, paymentInstructions: '請匯款' });
    expect(m.html).toContain('E&lt;1&gt;');
    expect(m.text).not.toContain('請匯款');
    expect(m.text).not.toContain('\n\n\n');
    expect(m.html).toContain('<a href="');
  });

  it('權限與資料隔離：營運人員不能管理，別家旅行社看不到；複製活動帶入範本', async () => {
    const ops = await makeAgency('operations');
    await api(ops).get('/emails').expect(403);
    const a = await makeAgency('admin');
    const other = await makeAgency('admin');
    await request(app.getHttpServer()).get(`/api/v1/agency/events/${a.eventId}/emails`).set('x-forwarded-host', other.host).set('cookie', other.cookie).expect(404);
    await api(a).put('/emails/templates/deadline_reminder', body).expect(204);
    await api(a).put('/emails/notify-emails', { emails: ['team@example.com'] }).expect(204);
    await admin.query(`INSERT INTO agency_quota_ledger (agency_id, pricing_tier_id, change, reason) SELECT agency_id, pricing_tier_id, 1, 'grant' FROM events WHERE id = $1`, [a.eventId]);
    const ev = await q1(`SELECT company_id, pricing_tier_id FROM events WHERE id = $1`, [a.eventId]);
    const copy = await api(a).post('/copy', { companyId: ev.company_id, pricingTierId: ev.pricing_tier_id, name: '複製活動', slug: `copy-${randomUUID().slice(0, 6)}` }).expect(201);
    const copied = await request(app.getHttpServer()).get(`/api/v1/agency/events/${copy.body.id}/emails`).set('x-forwarded-host', a.host).set('cookie', a.cookie).expect(200);
    expect(copied.body.notifyEmails).toEqual(['team@example.com']);
    expect(copied.body.templates.find((x: any) => x.key === 'deadline_reminder')).toMatchObject({ customized: true, senderName: '山海旅遊' });
  });
});

describe('分房', () => {
  const mail = () => app.get(MailService);
  const until = async (fn: () => boolean) => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error('等待逾時'); };
  const setup = async (role = 'admin') => {
    const a = await makeAgency(role);
    const s = (await q1(`INSERT INTO event_sessions (agency_id, event_id, name, capacity, sort_order) VALUES ($1, $2, 'A 梯', 50, 0) RETURNING id`, [a.agencyId, a.eventId])).id as string;
    const twin = (await q1(`INSERT INTO session_room_types (agency_id, session_id, name, capacity, bed_quota) VALUES ($1, $2, '二人房', 2, 50) RETURNING id`, [a.agencyId, s])).id as string;
    const single = (await q1(`INSERT INTO session_room_types (agency_id, session_id, name, capacity, bed_quota) VALUES ($1, $2, '單人房', 1, 50) RETURNING id`, [a.agencyId, s])).id as string;
    const adult = (await q1(`INSERT INTO traveler_types (agency_id, event_id, name, base_price) VALUES ($1, $2, '成人', 100) RETURNING id`, [a.agencyId, a.eventId])).id as string;
    const infant = (await q1(`INSERT INTO traveler_types (agency_id, event_id, name, base_price, occupies_bed) VALUES ($1, $2, '嬰兒', 10, false) RETURNING id`, [a.agencyId, a.eventId])).id as string;
    return { a, s, twin, single, adult, infant };
  };
  type C = Awaited<ReturnType<typeof setup>>;
  let seq = 0;
  /** people：[姓名, 房型 ID, 第幾間, 不佔床] */
  const book = async (c: C, people: [string, string | null, number, boolean?][], email: string | null = null, wish?: [number, string]) => {
    seq += 1;
    const emp = (await q1(`INSERT INTO event_employees (agency_id, event_id, employee_no, name, email) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [c.a.agencyId, c.a.eventId, `R${seq}`, people[0]![0], email])).id;
    const reg = (await q1(`INSERT INTO registrations (agency_id, event_id, session_id, event_employee_id, total_amount, subsidy_amount, payment_status, terms_version_accepted, terms_accepted_at) VALUES ($1, $2, $3, $4, 100, 0, 'unpaid', 1, now()) RETURNING id`, [c.a.agencyId, c.a.eventId, c.s, emp])).id as string;
    const ids: string[] = [];
    for (const [i, [name, room, no, noBed]] of people.entries()) {
      ids.push((await q1(`INSERT INTO travelers (agency_id, registration_id, traveler_type_id, is_employee_self, name, base_price_snapshot, session_room_type_id, requested_room_no, sort_order) VALUES ($1, $2, $3, false, $4, 100, $5, $6, $7) RETURNING id`, [c.a.agencyId, reg, noBed ? c.infant : c.adult, name, room, no, i])).id);
    }
    if (wish) await admin.query(`INSERT INTO room_preferences (agency_id, registration_id, requested_room_no, preferred_coworker_name) VALUES ($1, $2, $3, $4)`, [c.a.agencyId, reg, wish[0], wish[1]]);
    return { reg, ids, emp: emp as string };
  };
  const view = async (c: C) => (await api(c.a).get('/rooms').expect(200)).body.session;

  it('建立草稿依第幾間分組、自動編號；可重複按，不動已排好的房間', async () => {
    const c = await setup();
    await book(c, [['王大明', c.twin, 1], ['王太太', c.twin, 1], ['王小寶', null, 1, true], ['王阿公', c.single, 2]]);
    const first = (await api(c.a).post('/rooms/draft', { sessionId: c.s }).expect(201)).body;
    expect(first).toEqual({ created: 2, placed: 4 });
    const v = await view(c);
    expect(v.rooms.map((r: any) => [r.label, r.typeName, r.beds, r.status])).toEqual([['A-001', '二人房', 2, 'ok'], ['A-002', '單人房', 1, 'ok']]);
    expect(v.rooms[0].travelers.map((t: any) => t.name)).toEqual(['王大明', '王太太', '王小寶']);
    expect(v.stats).toMatchObject({ total: 4, assigned: 4, over: 0 });

    await api(c.a).put('/rooms/assignments', { sessionId: c.s, roomId: v.rooms[1].id, travelerIds: [v.rooms[0].travelers[1].id] }).expect(204);
    await book(c, [['新來的', c.twin, 1]]);
    expect((await api(c.a).post('/rooms/draft', { sessionId: c.s }).expect(201)).body).toEqual({ created: 1, placed: 1 });
    const again = await view(c);
    expect(again.rooms[1].travelers.map((t: any) => t.name)).toEqual(['王太太', '王阿公']);
    expect(again.rooms[2].label).toBe('A-003');
  });

  it('不佔床不計人數；超過不能公布，沒住滿可以公布；房型與報名不同會提醒', async () => {
    const c = await setup();
    const p = await book(c, [['甲', c.twin, 1], ['乙', c.twin, 2]]);
    const small = (await api(c.a).post('/rooms', { sessionId: c.s, roomTypeId: c.single }).expect(201)).body;
    expect(small.label).toBe('A-001');
    await api(c.a).put('/rooms/assignments', { sessionId: c.s, roomId: small.id, travelerIds: [p.ids[0]] }).expect(204);
    const blocked = await api(c.a).post('/rooms/publish', { sessionId: c.s }).expect(409);
    expect(blocked.body).toMatchObject({ code: 'ROOMS_NOT_READY', detail: { unassigned: 1, over: 0 } });

    await api(c.a).put('/rooms/assignments', { sessionId: c.s, roomId: small.id, travelerIds: [p.ids[1]] }).expect(204);
    const v = await view(c);
    expect(v.rooms[0]).toMatchObject({ status: 'over', beds: 2, capacity: 1 });
    expect(v.rooms[0].mismatched.map((m: any) => m.selectedRoom)).toEqual(['二人房', '二人房']);
    expect((await api(c.a).post('/rooms/publish', { sessionId: c.s }).expect(409)).body.detail).toEqual({ unassigned: 0, over: 1 });

    await api(c.a).patch(`/rooms/${small.id}`, { label: 'A-001', roomTypeId: c.twin }).expect(204);
    expect((await view(c)).rooms[0].status).toBe('ok');
    await api(c.a).put('/rooms/assignments', { sessionId: c.s, roomId: null, travelerIds: [p.ids[1]] }).expect(204);
    const big = (await api(c.a).post('/rooms', { sessionId: c.s, roomTypeId: c.twin }).expect(201)).body;
    await api(c.a).put('/rooms/assignments', { sessionId: c.s, roomId: big.id, travelerIds: [p.ids[1]] }).expect(204);
    const baby = await book(c, [['寶寶', null, 1, true]]);
    await api(c.a).put('/rooms/assignments', { sessionId: c.s, roomId: big.id, travelerIds: [baby.ids[0]] }).expect(204);
    const w = await view(c);
    expect(w.rooms.map((r: any) => r.status)).toEqual(['under', 'under']);
    expect(w.rooms[1].beds).toBe(1);
    await api(c.a).post('/rooms/publish', { sessionId: c.s }).expect(201);
  });

  it('公布前員工看不到；重新公布前看到上次結果；只通知有變動的員工', async () => {
    const c = await setup();
    const tag = randomUUID().slice(0, 8);
    const emails = ['a', 'b', 'c'].map((x) => `${x}-${tag}@example.com`);
    const A = await book(c, [['甲', c.twin, 1]], emails[0]!);
    const B = await book(c, [['乙', c.twin, 1]], emails[1]!);
    const D = await book(c, [['丙', c.twin, 1]], emails[2]!);
    await api(c.a).post('/rooms/draft', { sessionId: c.s }).expect(201);
    const before = await view(c);
    expect(before.publication).toBeNull();
    expect(before.notifyCount).toBe(3);

    const svc = app.get(RegistrationService) as any;
    const finalRooms = async (reg: { emp: string }) => {
      const res = await app.get(DatabaseService).withTenant(c.a.agencyId, async (tx: any) => svc.loadRegistration(tx, reg.emp, await svc.loadConfig(tx, c.a.eventId)));
      return res.finalRooms;
    };
    expect(await finalRooms(A)).toBeNull();

    expect((await api(c.a).post('/rooms/publish', { sessionId: c.s }).expect(201)).body.notified).toBe(3);
    await until(() => emails.every((e) => mail().sent.some((m) => m.to === e)));
    const m = mail().sent.find((x) => x.to === emails[0])!;
    expect(m.subject).toContain('分房結果');
    expect(m.text).toContain('A-001 二人房：甲');
    expect(m.text).not.toContain('乙');
    expect(await finalRooms(A)).toEqual([{ label: 'A-001', typeName: '二人房', names: ['甲'] }]);

    const v = await view(c);
    await api(c.a).put('/rooms/assignments', { sessionId: c.s, roomId: v.rooms[0].id, travelerIds: [B.ids[0]] }).expect(204);
    const changed = await view(c);
    expect(changed.publication.changes.map((x: any) => [x.label, x.before, x.after])).toEqual([['A-001', ['甲'], ['甲', '乙']], ['A-002', ['乙'], []]]);
    expect(changed.notifyCount).toBe(2);
    expect(await finalRooms(A)).toEqual([{ label: 'A-001', typeName: '二人房', names: ['甲'] }]);

    const count = (e: string) => mail().sent.filter((x) => x.to === e).length;
    expect((await api(c.a).post('/rooms/publish', { sessionId: c.s }).expect(201)).body.notified).toBe(2);
    await until(() => count(emails[0]!) === 2 && count(emails[1]!) === 2);
    expect(count(emails[2]!)).toBe(1);
    expect(mail().sent.filter((x) => x.to === emails[1]).at(-1)!.text).toContain('A-001 二人房：甲、乙');
    expect((await finalRooms(A))[0].names).toEqual(['甲', '乙']);
    expect((await view(c)).publication.changes).toEqual([]);
    void D;
  });

  it('確認取消後離開房間並出現異動；手動房號不能重複；刪除房間旅客回到未分房', async () => {
    const c = await setup();
    const A = await book(c, [['甲', c.twin, 1]], null, [1, '乙同事']);
    const B = await book(c, [['乙', c.twin, 1]]);
    expect((await view(c)).stats.wishes).toBe(1);
    expect((await view(c)).unassigned[0]).toMatchObject({ employeeName: '甲', wish: '乙同事', selectedRoom: '二人房' });
    await api(c.a).post('/rooms/draft', { sessionId: c.s }).expect(201);
    await api(c.a).post('/rooms/publish', { sessionId: c.s }).expect(201);

    await admin.query(`UPDATE registrations SET status = 'cancel_requested', cancel_requested_at = now() WHERE id = $1`, [B.reg]);
    await admin.query(`UPDATE event_sessions SET sold_count = 2 WHERE id = $1`, [c.s]);
    await admin.query(`UPDATE session_room_types SET sold_count = 2 WHERE id = $1`, [c.twin]);
    await app.get(RegistrationService).confirmCancel(c.a.agencyId, B.reg, null);
    const v = await view(c);
    expect(v.stats.total).toBe(1);
    expect(v.publication.changes).toHaveLength(1);
    expect(v.publication.changes[0]).toMatchObject({ before: ['乙'], after: [] });
    expect(v.rooms[1].status).toBe('empty');

    const label = await api(c.a).post('/rooms', { sessionId: c.s, roomTypeId: c.twin, label: 'A-001' }).expect(409);
    expect(label.body.code).toBe('ROOM_LABEL_TAKEN');
    await api(c.a).del(`/rooms/${v.rooms[0].id}`).expect(204);
    expect((await view(c)).unassigned[0].travelers[0].name).toBe('甲');
    void A;
  });

  it('房型驗證、別的梯次與別家旅行社都擋下；營運人員可以操作', async () => {
    const c = await setup('operations');
    await api(c.a).post('/rooms', { sessionId: c.s, roomTypeId: null, capacity: 2 }).expect(422);
    const other = await q1(`INSERT INTO event_sessions (agency_id, event_id, name, capacity, sort_order) VALUES ($1, $2, 'B 梯', 50, 1) RETURNING id`, [c.a.agencyId, c.a.eventId]);
    const free = (await api(c.a).post('/rooms', { sessionId: other.id, roomTypeId: null, capacity: 4 }).expect(201)).body;
    expect(free.label).toBe('B-001');
    await api(c.a).post('/rooms', { sessionId: other.id, roomTypeId: c.twin }).expect(422);
    const p = await book(c, [['甲', c.twin, 1]]);
    await api(c.a).put('/rooms/assignments', { sessionId: c.s, roomId: free.id, travelerIds: [p.ids[0]] }).expect(404);
    await api(c.a).put('/rooms/assignments', { sessionId: other.id, roomId: free.id, travelerIds: [p.ids[0]] }).expect(404);
    const stranger = await makeAgency('admin');
    await request(app.getHttpServer()).post(`/api/v1/agency/events/${c.a.eventId}/rooms/draft`).set('x-forwarded-host', stranger.host).set('cookie', stranger.cookie).send({ sessionId: c.s }).expect(404);
  });
});

describe('資料匯出', () => {
  const loginAs = async (a: Ag, role: string) => {
    const user = (await q1(`INSERT INTO agency_users (agency_id, email, password_hash, name, role) VALUES ($1, $2, $3, '第二人', $4) RETURNING id`, [a.agencyId, `${role}@example.com`, hash, role])).id;
    const token = generateToken();
    await admin.query(`INSERT INTO agency_user_sessions (agency_id, agency_user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`, [a.agencyId, user, hashToken(process.env.TOKEN_HASH_KEY!, token)]);
    return { cookie: `bt_agency_session=${token}` };
  };
  const ENC = () => app.get(EncryptionService);
  const setup = async (role = 'admin') => {
    const a = await makeAgency(role);
    const s = (await q1(`INSERT INTO event_sessions (agency_id, event_id, name, capacity, sort_order, departs_on) VALUES ($1, $2, 'A 梯', 50, 0, '2027-03-01') RETURNING id`, [a.agencyId, a.eventId])).id as string;
    const s2 = (await q1(`INSERT INTO event_sessions (agency_id, event_id, name, capacity, sort_order) VALUES ($1, $2, 'B 梯', 50, 1) RETURNING id`, [a.agencyId, a.eventId])).id as string;
    const room = (await q1(`INSERT INTO session_room_types (agency_id, session_id, name, capacity, bed_quota) VALUES ($1, $2, '二人房', 2, 50) RETURNING id`, [a.agencyId, s])).id as string;
    const type = (await q1(`INSERT INTO traveler_types (agency_id, event_id, name, base_price, is_employee_self) VALUES ($1, $2, '本人', 10000, true) RETURNING id`, [a.agencyId, a.eventId])).id as string;
    const group = (await q1(`INSERT INTO option_groups (agency_id, event_id, name, max_select) VALUES ($1, $2, '第二天', 1) RETURNING id`, [a.agencyId, a.eventId])).id as string;
    const option = (await q1(`INSERT INTO options (agency_id, group_id, name, price) VALUES ($1, $2, '水族館', 500) RETURNING id`, [a.agencyId, group])).id as string;
    await admin.query(`INSERT INTO event_fields (agency_id, event_id, field_key, label, field_type, is_sensitive, sort_order) VALUES ($1, $2, 'nid', '身分證字號', 'text', true, 0), ($1, $2, 'diet', '飲食需求', 'text', false, 1), ($1, $2, 'birth', '生日', 'date', false, 2)`, [a.agencyId, a.eventId]);
    const book = async (session: string, no: string, name: string, status = 'confirmed') => {
      const emp = (await q1(`INSERT INTO event_employees (agency_id, event_id, employee_no, name, department) VALUES ($1, $2, $3, $4, '資訊部') RETURNING id`, [a.agencyId, a.eventId, no, name])).id;
      const reg = (await q1(`INSERT INTO registrations (agency_id, event_id, session_id, event_employee_id, total_amount, subsidy_amount, payment_status, terms_version_accepted, terms_accepted_at, status) VALUES ($1, $2, $3, $4, 10500, 3000, 'unpaid', 1, now(), $5) RETURNING id`, [a.agencyId, a.eventId, session, emp, status])).id as string;
      const t = (await q1(`INSERT INTO travelers (agency_id, registration_id, traveler_type_id, is_employee_self, name, base_price_snapshot, field_values, sensitive_values_encrypted, sensitive_masks, session_room_type_id) VALUES ($1, $2, $3, true, $4, 10000, $5, $6, $7, $8) RETURNING id`,
        [a.agencyId, reg, type, name, JSON.stringify({ diet: '素食' }), ENC().encryptJson({ nid: '0123456789' }), JSON.stringify({ nid: '01*******9' }), session === s ? room : null])).id as string;
      await admin.query(`INSERT INTO traveler_options (agency_id, traveler_id, option_id, price_snapshot) VALUES ($1, $2, $3, 500)`, [a.agencyId, t, option]);
      return { reg, t };
    };
    return { a, s, s2, room, book };
  };
  const run = async (a: Ag, body: object) => {
    const { id } = (await api(a).post('/exports', body).expect(201)).body;
    let job: any;
    for (let i = 0; i < 100; i++) {
      job = (await api(a).get('/exports').expect(200)).body.jobs.find((j: any) => j.id === id);
      if (job.status === 'completed' || job.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 30));
    }
    return job;
  };
  const read = async (a: Ag, id: string) => {
    const res = await api(a).get(`/exports/${id}/download`).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(res.body as never);
    const sheet = book.worksheets[0]!;
    const rows: unknown[][] = [];
    sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
    return { rows, res };
  };

  it('內建四種範本，範本欄位依權限；旅客總表每位旅客一列，已取消不列入', async () => {
    const c = await setup();
    await c.book(c.s, 'E1', '王小明');
    await c.book(c.s, 'E2', '已取消', 'cancelled');
    const view = (await api(c.a).get('/exports').expect(200)).body;
    expect(view.templates.map((t: any) => t.name)).toEqual(['旅客總表', '分房表', '保險名單', '費用報表']);
    expect(view.canExportSensitive).toBe(true);
    const all = view.templates[0];
    expect(all.columns).toContain('field:diet');
    expect(all.columns).not.toContain('field:nid');
    expect(view.templates[2].columns).toContain('field:nid');
    expect(view.templates[2].columns).toContain('field:birth');
    expect(view.templates[2].columns).not.toContain('field:diet');

    const job = await run(c.a, { name: all.name, scope: all.scope, sessionId: null, columns: all.columns });
    expect(job).toMatchObject({ status: 'completed', rowCount: 1, containsSensitive: false, createdByName: expect.any(String) });
    const { rows, res } = await read(c.a, job.id);
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(rows[0]).toContain('旅客姓名');
    expect(rows[1]).toContain('王小明');
    expect(rows[1]).toContain('素食');
    expect(rows[1]).toContain('水族館');
    expect(rows[1]).toContain(10500);
  });

  it('含個資的匯出：解密寫入、保留開頭的 0、留下產生與下載紀錄；未選時不解密', async () => {
    const c = await setup();
    await c.book(c.s, 'E1', '王小明');
    const job = await run(c.a, { name: '保險名單', scope: 'travelers', sessionId: null, columns: ['traveler_name', 'field:nid'] });
    expect(job.containsSensitive).toBe(true);
    const { rows } = await read(c.a, job.id);
    expect(rows[1]).toEqual(['王小明', '0123456789']);
    const logs = await admin.query(`SELECT action, metadata FROM audit_logs WHERE agency_id = $1 AND action LIKE 'export_sensitive%' ORDER BY id`, [c.a.agencyId]);
    expect(logs.rows.map((r) => r.action)).toEqual(['export_sensitive', 'export_sensitive_download']);
    expect(logs.rows[0].metadata).toMatchObject({ name: '保險名單', rows: 1, fields: ['身分證字號'] });
    expect(JSON.stringify(logs.rows)).not.toContain('0123456789');

    const plain = await run(c.a, { name: '不含', scope: 'travelers', sessionId: null, columns: ['traveler_name', 'field:diet'] });
    expect(plain.containsSensitive).toBe(false);
    expect(JSON.stringify((await read(c.a, plain.id)).rows)).not.toContain('0123456789');
  });

  it('沒有權限的人不能選敏感欄位，看不到別人的匯出，也下載不了', async () => {
    const c = await setup('admin');
    await c.book(c.s, 'E1', '王小明');
    const secret = await run(c.a, { name: '保險名單', scope: 'travelers', sessionId: null, columns: ['field:nid'] });
    const ops = { ...c.a, ...(await loginAs(c.a, 'operations')) };
    const view = (await api(ops).get('/exports').expect(200)).body;
    expect(view.canExportSensitive).toBe(false);
    expect(view.catalog.travelers.map((x: any) => x.key)).not.toContain('field:nid');
    expect(view.jobs).toEqual([]);
    expect((await api(ops).post('/exports', { name: 'x', scope: 'travelers', sessionId: null, columns: ['field:nid'] }).expect(403)).body.code).toBe('FORBIDDEN');
    await api(ops).post('/export-templates', { name: 'x', scope: 'travelers', columns: ['field:nid'] }).expect(403);
    await api(ops).get(`/exports/${secret.id}/download`).expect(404);

    const own = await run(ops, { name: '費用', scope: 'registrations', sessionId: null, columns: ['employee_no', 'total'] });
    expect(own.status).toBe('completed');
    await read(ops, own.id);
    expect((await api(c.a).get('/exports').expect(200)).body.jobs.map((j: any) => j.id)).toContain(own.id);

    const stranger = await makeAgency('admin');
    await request(app.getHttpServer()).get(`/api/v1/agency/events/${c.a.eventId}/exports/${own.id}/download`).set('x-forwarded-host', stranger.host).set('cookie', stranger.cookie).expect(404);
  });

  it('費用報表每筆報名一列，可篩梯次；分房表依房號排並列出同房', async () => {
    const c = await setup();
    const b1 = await c.book(c.s, 'E2', '乙');
    const b2 = await c.book(c.s, 'E1', '甲');
    await c.book(c.s2, 'E3', '丙');
    await admin.query(`UPDATE registrations SET payment_status = 'paid', paid_amount = 7000 WHERE id = $1`, [b1.reg]);
    const fee = await run(c.a, { name: '費用報表', scope: 'registrations', sessionId: c.s, columns: ['employee_no', 'total', 'subsidy', 'self_pay', 'payment_status', 'payment_diff'] });
    expect(fee.rowCount).toBe(2);
    const { rows } = await read(c.a, fee.id);
    expect(rows[1]).toEqual(['E1', 10500, 3000, 7500, '未付', '']);
    expect(rows[2]).toEqual(['E2', 10500, 3000, 7500, '已付', 500]);

    const r = (await q1(`INSERT INTO rooms (agency_id, session_id, label, session_room_type_id, capacity) VALUES ($1, $2, 'A-001', $3, 2) RETURNING id`, [c.a.agencyId, c.s, c.room])).id;
    for (const t of [b1.t, b2.t]) await admin.query(`INSERT INTO room_assignments (traveler_id, agency_id, room_id) VALUES ($1, $2, $3)`, [t, c.a.agencyId, r]);
    const rooms = await run(c.a, { name: '分房表', scope: 'travelers', sessionId: null, columns: ['session', 'final_room', 'final_room_type', 'traveler_name', 'roommates'] });
    const out = (await read(c.a, rooms.id)).rows;
    expect(out[1]).toEqual(['A 梯', 'A-001', '二人房', '甲', '乙']);
    expect(out[2]).toEqual(['A 梯', 'A-001', '二人房', '乙', '甲']);
    expect(out[3]).toEqual(['B 梯', '', '', '丙', '']);
  });

  it('自訂範本全旅行社共用，別的活動只帶入有的欄位；不存在的欄位不能用', async () => {
    const c = await setup();
    const saved = (await api(c.a).post('/export-templates', { name: '航空公司名單', scope: 'travelers', columns: ['traveler_name', 'field:nid', 'group:第二天'] }).expect(201)).body;
    expect((await api(c.a).get('/exports').expect(200)).body.templates.find((t: any) => t.id === saved.id)).toMatchObject({ builtin: false, columns: ['traveler_name', 'field:nid', 'group:第二天'] });
    await api(c.a).post('/export-templates', { name: '航空公司名單', scope: 'travelers', columns: ['traveler_name'] }).expect(201);
    expect((await api(c.a).get('/exports').expect(200)).body.templates.filter((t: any) => t.name === '航空公司名單')).toHaveLength(1);
    await api(c.a).post('/exports', { name: 'x', scope: 'travelers', sessionId: null, columns: ['nope'] }).expect(422);
    await api(c.a).post('/exports', { name: 'x', scope: 'registrations', sessionId: null, columns: ['traveler_name'] }).expect(422);
    await api(c.a).post('/exports', { name: 'x', scope: 'travelers', sessionId: randomUUID(), columns: ['traveler_name'] }).expect(404);
    await api(c.a).del(`/export-templates/${saved.id}`).expect(204);
    await api(c.a).del(`/export-templates/${saved.id}`).expect(404);
  });

  it('到期的檔案會刪除，也不能再下載', async () => {
    const c = await setup();
    await c.book(c.s, 'E1', '王小明');
    const job = await run(c.a, { name: '費用', scope: 'registrations', sessionId: null, columns: ['employee_no'] });
    await read(c.a, job.id);
    await admin.query(`UPDATE export_jobs SET expires_at = now() - interval '1 minute' WHERE id = $1`, [job.id]);
    await api(c.a).get(`/exports/${job.id}/download`).expect(404);
    expect((await api(c.a).get('/exports').expect(200)).body.jobs).toEqual([]);
    const key = (await q1(`SELECT result_object_key AS k FROM export_jobs WHERE id = $1`, [job.id])).k;
    expect(await app.get(ExportService).cleanup(c.a.agencyId)).toBe(1);
    await expect(app.get(StorageService).get(key)).rejects.toThrow();
  });
});

describe('個資紀錄', () => {
  const root = (a: Ag) => (p: string) => request(app.getHttpServer()).get(`/api/v1/agency${p}`).set('x-forwarded-host', a.host).set('cookie', a.cookie);
  const setup = async (role = 'admin') => {
    const a = await makeAgency(role);
    const session = (await q1(`INSERT INTO event_sessions (agency_id, event_id, name, capacity) VALUES ($1, $2, 'A 梯', 10) RETURNING id`, [a.agencyId, a.eventId])).id as string;
    const type = (await q1(`INSERT INTO traveler_types (agency_id, event_id, name, base_price, is_employee_self) VALUES ($1, $2, '本人', 100, true) RETURNING id`, [a.agencyId, a.eventId])).id as string;
    await admin.query(`INSERT INTO event_fields (agency_id, event_id, field_key, label, field_type, is_sensitive) VALUES ($1, $2, 'nid', '身分證字號', 'text', true)`, [a.agencyId, a.eventId]);
    const emp = (await q1(`INSERT INTO event_employees (agency_id, event_id, employee_no, name) VALUES ($1, $2, 'E7', '王小明') RETURNING id`, [a.agencyId, a.eventId])).id;
    const reg = (await q1(`INSERT INTO registrations (agency_id, event_id, session_id, event_employee_id, total_amount, subsidy_amount, payment_status, terms_version_accepted, terms_accepted_at) VALUES ($1, $2, $3, $4, 100, 0, 'unpaid', 1, now()) RETURNING id`, [a.agencyId, a.eventId, session, emp])).id as string;
    await admin.query(`INSERT INTO travelers (agency_id, registration_id, traveler_type_id, is_employee_self, name, base_price_snapshot, sensitive_values_encrypted) VALUES ($1, $2, $3, true, '王小明', 100, $4)`, [a.agencyId, reg, type, app.get(EncryptionService).encryptJson({ nid: 'A123456789' })]);
    return { a, reg, session };
  };

  it('查看完整個資與匯出都會列出，內容不含個資；可篩選', async () => {
    const c = await setup();
    await api(c.a).post(`/registrations/${c.reg}/sensitive`, {}).expect(200);
    const { id } = (await api(c.a).post('/exports', { name: '保險名單', scope: 'travelers', sessionId: c.session, columns: ['traveler_name', 'field:nid'] }).expect(201)).body;
    for (let i = 0; i < 100; i++) {
      if ((await api(c.a).get('/exports').expect(200)).body.jobs.find((j: any) => j.id === id).status === 'completed') break;
      await new Promise((r) => setTimeout(r, 30));
    }
    await api(c.a).get(`/exports/${id}/download`).expect(200);

    const log = (await root(c.a)('/data-log').expect(200)).body;
    expect(log.rows.map((r: any) => r.action)).toEqual(['export_sensitive_download', 'export_sensitive', 'registration.sensitive_viewed']);
    expect(JSON.stringify(log)).not.toContain('A123456789');
    expect(log.rows[1]).toMatchObject({ name: '保險名單', sessionName: 'A 梯', rows: 1, fields: ['身分證字號'], eventName: expect.any(String), actorName: expect.any(String) });
    expect(log.rows[2]).toMatchObject({ employeeName: '王小明', employeeNo: 'E7', travelerCount: 1, fields: ['身分證字號'] });
    expect(log.actors).toHaveLength(1);

    const only = (await root(c.a)('/data-log?action=registration.sensitive_viewed').expect(200)).body.rows;
    expect(only).toHaveLength(1);
    expect((await root(c.a)(`/data-log?event=${randomUUID()}`).expect(200)).body.rows).toEqual([]);
    expect((await root(c.a)(`/data-log?actor=${randomUUID()}`).expect(200)).body.rows).toEqual([]);

    await admin.query(`UPDATE audit_logs SET created_at = now() - interval '40 days' WHERE agency_id = $1 AND action = 'export_sensitive'`, [c.a.agencyId]);
    expect((await root(c.a)('/data-log').expect(200)).body.rows).toHaveLength(2);
    expect((await root(c.a)('/data-log?days=90').expect(200)).body.rows).toHaveLength(3);
    expect((await root(c.a)('/data-log?days=all').expect(200)).body.rows).toHaveLength(3);
  });

  it('只有管理員能看，別家旅行社的紀錄看不到，一般操作不會列入', async () => {
    const ops = await setup('operations');
    await root(ops.a)('/data-log').expect(403);
    const c = await setup();
    const other = await setup();
    await api(c.a).post(`/registrations/${c.reg}/sensitive`, {}).expect(200);
    expect((await root(other.a)('/data-log').expect(200)).body.rows).toEqual([]);
    await admin.query(`INSERT INTO audit_logs (agency_id, actor_type, action) VALUES ($1, 'system', 'something_else')`, [c.a.agencyId]);
    expect((await root(c.a)('/data-log').expect(200)).body.rows).toHaveLength(1);
  });

  it('超過一頁時可以載入更多', async () => {
    const c = await setup();
    for (let i = 0; i < 51; i++) await admin.query(`INSERT INTO audit_logs (agency_id, actor_type, action, target_type, target_id, metadata) VALUES ($1, 'agency_user', 'export_sensitive', 'event', $2, $3)`, [c.a.agencyId, c.a.eventId, JSON.stringify({ name: `第${i}`, rows: 1, fields: [] })]);
    const first = (await root(c.a)('/data-log').expect(200)).body;
    expect(first.rows).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    const next = (await root(c.a)('/data-log?offset=50').expect(200)).body;
    expect(next.rows).toHaveLength(1);
    expect(next.hasMore).toBe(false);
  });
});

describe('企業窗口', () => {
  const http = () => request(app.getHttpServer());
  const mail = () => app.get(MailService);
  const agencyCall = (a: Ag) => ({
    get: (p: string) => http().get(`/api/v1/agency${p}`).set('x-forwarded-host', a.host).set('cookie', a.cookie),
    post: (p: string, b: object) => http().post(`/api/v1/agency${p}`).set('x-forwarded-host', a.host).set('cookie', a.cookie).send(b),
    patch: (p: string, b: object) => http().patch(`/api/v1/agency${p}`).set('x-forwarded-host', a.host).set('cookie', a.cookie).send(b),
  });
  const company = async (a: Ag) => (await q1(`SELECT company_id FROM events WHERE id = $1`, [a.eventId])).company_id as string;
  const tokenFrom = (to: string) => mail().sent.filter((m) => m.to === to).at(-1)!.text.match(/set-password\/([\w-]+)/)![1]!;
  /** 建立窗口、用邀請信設定密碼、登入，回傳可以呼叫窗口 API 的工具。 */
  const contactOf = async (a: Ag, companyId?: string) => {
    const cid = companyId ?? await company(a);
    const email = `c-${randomUUID().slice(0, 8)}@example.com`;
    const { id } = (await agencyCall(a).post(`/companies/${cid}/contacts`, { name: '林窗口', email }).expect(201)).body;
    await http().post(`/api/v1/company/password-links/${tokenFrom(email)}`).set('x-forwarded-host', a.host).send({ password: 'contact1234' }).expect(204);
    const login = await http().post('/api/v1/agency/session').set('x-forwarded-host', a.host).send({ email, password: 'contact1234' }).expect(204);
    const cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('bt_contact_session='))!.split(';')[0]!;
    const call = (method: 'get' | 'post' | 'patch' | 'delete', p: string) => (http() as any)[method](`/api/v1/company${p}`).set('x-forwarded-host', a.host).set('cookie', cookie);
    return { id, email, cookie, cid, get: (p: string) => call('get', p), post: (p: string, b: object) => call('post', p).send(b), patch: (p: string, b: object) => call('patch', p).send(b), del: (p: string) => call('delete', p) };
  };
  const booked = async (a: Ag, no: string, status = 'confirmed') => {
    const s = (await q1(`INSERT INTO event_sessions (agency_id, event_id, name, capacity, sort_order, sold_count) VALUES ($1, $2, $3, 50, 0, 1) RETURNING id`, [a.agencyId, a.eventId, `梯${no}`])).id;
    const type = (await q1(`INSERT INTO traveler_types (agency_id, event_id, name, base_price) VALUES ($1, $2, $3, 1000) RETURNING id`, [a.agencyId, a.eventId, `T${no}`])).id;
    const emp = (await q1(`INSERT INTO event_employees (agency_id, event_id, employee_no, name, department) VALUES ($1, $2, $3, $4, '資訊部') RETURNING id`, [a.agencyId, a.eventId, no, `員工${no}`])).id;
    const reg = (await q1(`INSERT INTO registrations (agency_id, event_id, session_id, event_employee_id, total_amount, subsidy_amount, payment_status, terms_version_accepted, terms_accepted_at, status) VALUES ($1, $2, $3, $4, 10000, 3000, 'unpaid', 1, now(), $5) RETURNING id`, [a.agencyId, a.eventId, s, emp, status])).id as string;
    await admin.query(`INSERT INTO travelers (agency_id, registration_id, traveler_type_id, is_employee_self, name, base_price_snapshot, field_values, sensitive_masks, sensitive_values_encrypted) VALUES ($1, $2, $3, true, $4, 1000, $5, $6, $7)`,
      [a.agencyId, reg, type, `員工${no}`, JSON.stringify({ diet: '素食' }), JSON.stringify({ nid: 'A1*******9' }), app.get(EncryptionService).encryptJson({ nid: 'A123456789' })]);
    return { reg, emp: emp as string };
  };

  it('邀請信開通後能登入，連結只能用一次；共用登入頁判斷身分；旅行社 API 不接受窗口', async () => {
    const a = await makeAgency('admin');
    const c = await contactOf(a);
    expect((await c.get('/me').expect(200)).body).toMatchObject({ companyName: expect.any(String), user: { name: '林窗口', email: c.email } });
    await http().get('/api/v1/agency/me').set('x-forwarded-host', a.host).set('cookie', c.cookie).expect(401);
    await http().get('/api/v1/company/me').set('x-forwarded-host', a.host).set('cookie', a.cookie).expect(401);
    const list = (await agencyCall(a).get(`/companies/${c.cid}/contacts`).expect(200)).body;
    expect(list[0]).toMatchObject({ name: '林窗口', status: 'active', activated: true });
    await http().post('/api/v1/agency/session').set('x-forwarded-host', a.host).send({ email: c.email, password: 'wrong-pass1' }).expect(401);

    const invite = mail().sent.filter((m) => m.to === c.email).at(-1)!;
    expect(invite.subject).toContain('企業窗口帳號邀請');
    const used = tokenFrom(c.email);
    await http().get(`/api/v1/company/password-links/${used}`).set('x-forwarded-host', a.host).expect(410);
    await http().post(`/api/v1/company/password-links/${used}`).set('x-forwarded-host', a.host).send({ password: 'other12345' }).expect(410);
    await http().post(`/api/v1/company/password-links/nope`).set('x-forwarded-host', a.host).send({ password: 'short' }).expect(422);
  });

  it('Email 不能和旅行社人員或其他窗口重複；重設連結讓舊連結失效；停用後立即不能使用', async () => {
    const a = await makeAgency('admin');
    const cid = await company(a);
    const staff = (await q1(`SELECT email FROM agency_users WHERE agency_id = $1 LIMIT 1`, [a.agencyId])).email;
    expect((await agencyCall(a).post(`/companies/${cid}/contacts`, { name: 'X', email: staff }).expect(409)).body.code).toBe('EMAIL_TAKEN');
    const c = await contactOf(a);
    expect((await agencyCall(a).post(`/companies/${cid}/contacts`, { name: 'Y', email: c.email }).expect(409)).body.code).toBe('EMAIL_TAKEN');

    await agencyCall(a).post(`/companies/${cid}/contacts/${c.id}/link`, {}).expect(204);
    const first = tokenFrom(c.email);
    expect(mail().sent.filter((m) => m.to === c.email).at(-1)!.subject).toContain('重設');
    await agencyCall(a).post(`/companies/${cid}/contacts/${c.id}/link`, {}).expect(204);
    await http().get(`/api/v1/company/password-links/${first}`).set('x-forwarded-host', a.host).expect(410);
    const second = tokenFrom(c.email);
    await http().get(`/api/v1/company/password-links/${second}`).set('x-forwarded-host', a.host).expect(200);

    await agencyCall(a).patch(`/companies/${cid}/contacts/${c.id}`, { status: 'disabled' }).expect(204);
    await c.get('/me').expect(401);
    await http().get(`/api/v1/company/password-links/${second}`).set('x-forwarded-host', a.host).expect(410);
    await http().post('/api/v1/agency/session').set('x-forwarded-host', a.host).send({ email: c.email, password: 'contact1234' }).expect(401);
    await agencyCall(a).post(`/companies/${cid}/contacts/${c.id}/link`, {}).expect(404);
    await agencyCall(a).patch(`/companies/${cid}/contacts/${c.id}`, { status: 'active' }).expect(204);
    await http().post('/api/v1/agency/session').set('x-forwarded-host', a.host).send({ email: c.email, password: 'contact1234' }).expect(204);

    mail().failFor.add('broken@example.com');
    expect((await agencyCall(a).post(`/companies/${cid}/contacts`, { name: 'Z', email: 'broken@example.com' }).expect(502)).body.code).toBe('MAIL_FAILED');
    mail().failFor.delete('broken@example.com');
    const ops = await makeAgency('operations');
    await agencyCall(ops).get(`/companies/${await company(ops)}/contacts`).expect(403);
  });

  it('只看得到自家企業的活動；別家企業的活動、報名、名單都是 404，尚未發布的看得到', async () => {
    const a = await makeAgency('admin');
    const c = await contactOf(a);
    await admin.query(`UPDATE events SET status = 'draft' WHERE id = $1`, [a.eventId]);
    const events = (await c.get('/events').expect(200)).body;
    expect(events.map((e: any) => e.id)).toEqual([a.eventId]);
    expect(events[0].state).toBe('draft');

    const otherCompany = (await q1(`INSERT INTO companies (agency_id, name) VALUES ($1, '別家') RETURNING id`, [a.agencyId])).id;
    const tier = (await q1(`SELECT pricing_tier_id FROM events WHERE id = $1`, [a.eventId])).pricing_tier_id;
    const other = (await q1(`INSERT INTO events (agency_id, company_id, name, slug, pricing_tier_id) VALUES ($1, $2, '別家活動', $3, $4) RETURNING id`, [a.agencyId, otherCompany, `o-${randomUUID().slice(0, 6)}`, tier])).id;
    const emp = (await q1(`INSERT INTO event_employees (agency_id, event_id, employee_no, name) VALUES ($1, $2, 'Z1', '別人') RETURNING id`, [a.agencyId, other])).id;
    expect((await c.get('/events').expect(200)).body).toHaveLength(1);
    await c.get(`/events/${other}/overview`).expect(404);
    await c.get(`/events/${other}/employees`).expect(404);
    await c.get(`/events/${other}/registrations`).expect(404);
    await c.get(`/events/${other}/fee-report`).expect(404);
    await c.post(`/events/${other}/employees`, { employeeNo: 'N1', name: 'n', email: null, department: null, subsidyAmount: null, dependentLimit: null }).expect(404);
    await c.patch(`/events/${other}/employees/${emp}`, { employeeNo: 'Z1', name: 'x', email: null, department: null, subsidyAmount: null, dependentLimit: null }).expect(404);
    await c.del(`/events/${other}/employees/${emp}`).expect(404);
    await c.post(`/events/${other}/employees/${emp}/password-link`, {}).expect(404);
    expect((await c.post(`/events/${a.eventId}/employees/copy`, { fromEventId: other }).expect(404)).body.code).toBe('NOT_FOUND');

    const stranger = await makeAgency('admin');
    await http().get('/api/v1/company/me').set('x-forwarded-host', stranger.host).set('cookie', c.cookie).expect(401);
  });

  it('報名明細唯讀且不含個資；已取消有列出但不計入補助合計；費用報表不含個資', async () => {
    const a = await makeAgency('admin');
    await admin.query(`INSERT INTO event_fields (agency_id, event_id, field_key, label, field_type, is_sensitive) VALUES ($1, $2, 'nid', '身分證字號', 'text', true), ($1, $2, 'diet', '飲食', 'text', false)`, [a.agencyId, a.eventId]);
    const c = await contactOf(a);
    const live = await booked(a, 'E1');
    await booked(a, 'E2', 'cancelled');
    const over = (await c.get(`/events/${a.eventId}/overview`).expect(200)).body;
    expect(over).toMatchObject({ roster: 2, registered: 1, subsidyTotal: 3000, accountsPending: 2 });
    expect(over.sessions).toHaveLength(2);

    const list = (await c.get(`/events/${a.eventId}/registrations`).expect(200)).body;
    expect(list.rows.map((r: any) => r.status).sort()).toEqual(['cancelled', 'confirmed']);
    expect(Object.keys(list.rows[0])).not.toContain('paymentDiff');
    const detail = await c.get(`/events/${a.eventId}/registrations/${live.reg}`).expect(200);
    expect(detail.body.travelers[0]).toEqual({ id: expect.any(String), name: '員工E1', typeName: 'TE1', roomTypeName: null, options: [], fee: 1000 });
    expect(JSON.stringify(detail.body)).not.toMatch(/A1\*|A123|素食|revisions/);

    await c.post(`/events/${a.eventId}/registrations/${live.reg}/sensitive`, {}).expect(404);
    await c.patch(`/events/${a.eventId}/registrations/${live.reg}/payment`, { status: 'paid' }).expect(404);
    await c.get(`/events/${a.eventId}/rooms`).expect(404);

    const res = await c.get(`/events/${a.eventId}/fee-report`).buffer(true).parse((r: any, cb: any) => { const b: Buffer[] = []; r.on('data', (d: Buffer) => b.push(d)); r.on('end', () => cb(null, Buffer.concat(b))); }).expect(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(res.body as never);
    const rows: unknown[][] = [];
    book.worksheets[0]!.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('部門');
    expect(rows[1]).toContain('E1');
    expect(JSON.stringify(rows)).not.toContain('A123456789');
  });

  it('員工名單和旅行社相同，操作紀錄記的是窗口；可匯入、寄帳號信、產生連結', async () => {
    const a = await makeAgency('admin');
    const c = await contactOf(a);
    const base = `/events/${a.eventId}/employees`;
    const e = (await c.post(base, { employeeNo: 'K1', name: '小王', email: `k1-${randomUUID().slice(0, 6)}@example.com`, department: '資訊部', subsidyAmount: 1000, dependentLimit: 1 }).expect(201)).body;
    expect((await c.get(base).expect(200)).body.rows[0]).toMatchObject({ employeeNo: 'K1', accountState: 'none' });
    await c.patch(`${base}/${e.id}`, { employeeNo: 'K1', name: '小王', email: null, department: '資訊部', subsidyAmount: 2000, dependentLimit: 1 }).expect(204);
    const link = (await c.post(`${base}/${e.id}/password-link`, {}).expect(201)).body;
    expect(link).toMatchObject({ issuedBy: '林窗口', token: expect.any(String) });
    const row = await q1(`SELECT created_by_type, created_by_id FROM employee_password_links WHERE event_employee_id = $1`, [e.id]);
    expect(row).toEqual({ created_by_type: 'company_contact', created_by_id: c.id });
    const logs = await admin.query(`SELECT action, actor_type, actor_id FROM audit_logs WHERE agency_id = $1 AND action LIKE 'employee.%'`, [a.agencyId]);
    expect(logs.rows.length).toBeGreaterThan(0);
    expect(logs.rows.every((l) => l.actor_type === 'company_contact' && l.actor_id === c.id)).toBe(true);

    const csv = Buffer.from('員工編號,姓名,Email,部門,補助金額,眷屬上限\nK2,小李,,人資部,,\n');
    const preview = await http().post(`/api/v1/company${base}/import/preview`).set('x-forwarded-host', a.host).set('cookie', c.cookie).set('content-type', 'text/csv').send(csv).expect(200);
    expect(preview.body.newCount).toBe(1);
    await http().post(`/api/v1/company${base}/import`).set('x-forwarded-host', a.host).set('cookie', c.cookie).set('content-type', 'text/csv').send(csv).expect(200);
    expect((await c.get(base).expect(200)).body.rosterTotal).toBe(2);
  });
});
