import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { hashPassword } from '@bigtours/shared/crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountService } from '../src/account.service.ts';
import { AppModule } from '../src/app.module.ts';
import { StorageService } from '../src/storage.service.ts';

const PASSWORD = 'abcd1234';
let app: INestApplication;
let admin: pg.Client;
let accounts: AccountService;
let storage: StorageService;
let tierId: string;
let knownHash: string;

const q1 = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0];

interface Page { mode?: 'manual' | 'scheduled'; isOpen?: boolean; opensIn?: string; closesIn?: string; registrationOpensIn?: string }

async function makeEvent(page: Page = {}) {
  const code = `a-${randomUUID().slice(0, 8)}`;
  const agencyId = (await q1(`INSERT INTO agencies (code, name) VALUES ($1, 'T') RETURNING id`, [code])).id;
  const company = (await q1(`INSERT INTO companies (agency_id, name) VALUES ($1, 'C') RETURNING id`, [agencyId])).id;
  const eventId = (await q1(
    `INSERT INTO events (agency_id, company_id, slug, name, status, pricing_tier_id, registration_opens_at, registration_closes_at,
                         page_mode, page_is_open, page_opens_at, page_closes_at)
     VALUES ($1, $2, 'evt', 'E', 'published', $3, now() + $4::interval, now() + interval '30 days', $5, $6, now() + $7::interval, now() + $8::interval)
     RETURNING id`,
    [agencyId, company, tierId, page.registrationOpensIn ?? '-1 day', page.mode ?? 'manual', page.isOpen ?? true, page.opensIn ?? '-1 day', page.closesIn ?? '60 days'],
  )).id;
  const sessionId = (await q1(`INSERT INTO event_sessions (agency_id, event_id, name, capacity) VALUES ($1, $2, 'S', 5) RETURNING id`, [agencyId, eventId])).id;
  const selfType = (await q1(`INSERT INTO traveler_types (agency_id, event_id, name, base_price, is_employee_self) VALUES ($1, $2, '本人', 1000, true) RETURNING id`, [agencyId, eventId])).id;
  return { agencyId, eventId, sessionId, selfType, host: `${code}.lvh.me` };
}
type Ev = Awaited<ReturnType<typeof makeEvent>>;

async function makeEmployee(e: Ev, passwordHash: string | null = knownHash, no = 'E001') {
  return (await q1(
    `INSERT INTO event_employees (agency_id, event_id, employee_no, name, password_hash) VALUES ($1, $2, $3, '王小明', $4) RETURNING id`,
    [e.agencyId, e.eventId, no, passwordHash],
  )).id as string;
}

const http = () => request(app.getHttpServer());
const base = '/api/v1/public/events/evt';
const on = (e: Ev, r: request.Test) => r.set('x-forwarded-host', e.host);
const login = (e: Ev, employeeNo: string, password: string) => on(e, http().post(`${base}/session`)).send({ employeeNo, password });
const lookup = (e: Ev, token: string) => on(e, http().post(`${base}/password-links/lookup`)).send({ token });
const setPassword = (e: Ev, token: string, password: string) => on(e, http().post(`${base}/password-links/set`)).send({ token, password });
const state = (e: Ev, cookie: string) => on(e, http().get(base)).set('cookie', cookie);
const issue = (e: Ev, id: string, delivery: 'email' | 'manual' = 'email') =>
  accounts.issuePasswordLink(e.agencyId, id, { type: 'company_contact', id: null }, delivery);

function sessionCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[];
  return raw[0]!.split(';')[0]!;
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
  accounts = app.get(AccountService);
  storage = app.get(StorageService);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('設定密碼連結', () => {
  it('設定完成後顯示員工編號，並能用新密碼登入', async () => {
    const e = await makeEvent();
    const id = await makeEmployee(e, null);
    const { token, expiresAt } = await issue(e, id);
    const days = (expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);

    const found = await lookup(e, token);
    expect(found.status).toBe(200);
    expect(found.body.employee.name).toBe('王小明');

    const done = await setPassword(e, token, PASSWORD);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ employeeNo: 'E001' });
    expect((await login(e, 'E001', PASSWORD)).status).toBe(204);
  });

  it('連結只能使用一次，同時送出也只成功一次', async () => {
    const e = await makeEvent();
    const { token } = await issue(e, await makeEmployee(e, null));
    const results = await Promise.all([setPassword(e, token, PASSWORD), setPassword(e, token, 'other1234')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    expect((await lookup(e, token)).status).toBe(410);
  });

  it('重新產生後舊連結立即失效，逾期連結不能使用', async () => {
    const e = await makeEvent();
    const id = await makeEmployee(e, null);
    const first = await issue(e, id, 'email');
    const second = await issue(e, id, 'manual');
    expect((await lookup(e, first.token)).status).toBe(410);
    expect((await lookup(e, second.token)).status).toBe(200);
    await admin.query(`UPDATE employee_password_links SET expires_at = now() - interval '1 second' WHERE event_employee_id = $1 AND revoked_at IS NULL`, [id]);
    expect((await lookup(e, second.token)).status).toBe(410);
    expect((await setPassword(e, second.token, PASSWORD)).status).toBe(410);
  });

  it('不符合密碼規則時拒絕，連結仍可使用', async () => {
    const e = await makeEvent();
    const { token } = await issue(e, await makeEmployee(e, null));
    for (const weak of ['abc123', 'abcdefgh', '12345678']) {
      const r = await setPassword(e, token, weak);
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('INVALID_PASSWORD');
    }
    expect((await setPassword(e, token, PASSWORD)).status).toBe(200);
  });

  it('其他旅行社的網址不能使用連結', async () => {
    const a = await makeEvent();
    const b = await makeEvent();
    const { token } = await issue(a, await makeEmployee(a, null));
    expect((await lookup(b, token)).status).toBe(410);
  });

  it('產生連結時記錄產生人與時間，資料庫不存連結本身', async () => {
    const e = await makeEvent();
    const id = await makeEmployee(e, null);
    const contact = randomUUID();
    const { token } = await accounts.issuePasswordLink(e.agencyId, id, { type: 'company_contact', id: contact }, 'manual');
    const log = await q1(`SELECT actor_type, actor_id, metadata, created_at FROM audit_logs WHERE target_id = $1 AND action = 'employee.password_link_issued'`, [id]);
    expect(log).toMatchObject({ actor_type: 'company_contact', actor_id: contact, metadata: { delivery: 'manual' } });
    expect(log.created_at).toBeInstanceOf(Date);
    const link = await q1(`SELECT row_to_json(l)::text AS j FROM employee_password_links l WHERE event_employee_id = $1`, [id]);
    expect(link.j).not.toContain(token);
  });

  it('重設密碼後，舊的登入狀態失效', async () => {
    const e = await makeEvent();
    const id = await makeEmployee(e);
    const cookie = sessionCookie(await login(e, 'E001', PASSWORD));
    expect((await state(e, cookie)).status).toBe(200);
    const { token } = await issue(e, id);
    await setPassword(e, token, 'newpass123');
    expect((await state(e, cookie)).status).toBe(401);
    expect((await login(e, 'E001', PASSWORD)).status).toBe(401);
    expect((await login(e, 'E001', 'newpass123')).status).toBe(204);
  });
});

describe('登入', () => {
  it('Cookie 限定 HttpOnly 與活動路徑，且資料庫只存雜湊', async () => {
    const e = await makeEvent();
    const id = await makeEmployee(e);
    const res = await login(e, 'E001', PASSWORD);
    const header = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain(`Path=${base}`);
    const value = sessionCookie(res).split('=')[1]!;
    const row = await q1(`SELECT row_to_json(s)::text AS j FROM employee_sessions s WHERE event_employee_id = $1`, [id]);
    expect(row.j).not.toContain(value);
    const body = await state(e, sessionCookie(res));
    expect(body.status).toBe(200);
    expect(body.body.employee.employeeNo).toBe('E001');
  });

  it('帳號不存在、密碼錯誤、尚未設定密碼都回傳相同錯誤', async () => {
    const e = await makeEvent();
    await makeEmployee(e);
    await makeEmployee(e, null, 'E002');
    for (const [no, password] of [['E001', 'wrong1234'], ['E999', PASSWORD], ['E002', PASSWORD]] as const) {
      const r = await login(e, no, password);
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('INVALID_CREDENTIALS');
    }
  });

  it('連續失敗 5 次後暫時鎖定，正確密碼也無法登入，解鎖後恢復', async () => {
    const e = await makeEvent();
    const id = await makeEmployee(e);
    for (let i = 0; i < 5; i += 1) expect((await login(e, 'E001', 'wrong1234')).status).toBe(401);
    const locked = await login(e, 'E001', PASSWORD);
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe('INVALID_CREDENTIALS');
    await admin.query(`UPDATE event_employees SET locked_until = now() - interval '1 second' WHERE id = $1`, [id]);
    expect((await login(e, 'E001', PASSWORD)).status).toBe(204);
  });

  it('帳號不跨活動共用：相同員工編號在另一個活動不能用這組密碼', async () => {
    const a = await makeEvent();
    const b = await makeEvent();
    await makeEmployee(a);
    await makeEmployee(b, await hashPassword('other1234'));
    expect((await login(b, 'E001', PASSWORD)).status).toBe(401);
    const cookie = sessionCookie(await login(a, 'E001', PASSWORD));
    expect((await state(b, cookie)).status).toBe(401);
  });

  it('登出後登入狀態失效', async () => {
    const e = await makeEvent();
    await makeEmployee(e);
    const cookie = sessionCookie(await login(e, 'E001', PASSWORD));
    const out = await on(e, http().delete(`${base}/session`)).set('cookie', cookie);
    expect(out.status).toBe(204);
    expect((await state(e, cookie)).status).toBe(401);
  });

  it('來自其他網址的請求一律拒絕', async () => {
    const e = await makeEvent();
    await makeEmployee(e);
    const cookie = sessionCookie(await login(e, 'E001', PASSWORD));
    const r = await on(e, http().post(`${base}/registrations/current/cancel-request`)).set('cookie', cookie).set('origin', 'http://other.lvh.me');
    expect(r.status).toBe(403);
    const same = await on(e, http().post(`${base}/registrations/current/cancel-request`)).set('cookie', cookie).set('origin', `http://${e.host}`);
    expect(same.status).toBe(409);
    const forged = await on(e, http().post(`${base}/session`)).set('origin', 'http://other.lvh.me').send({ employeeNo: 'E001', password: PASSWORD });
    expect(forged.status).toBe(403);
  });
});

describe('活動頁開關與報名期間', () => {
  const hold = (e: Ev, cookie: string) =>
    on(e, http().post(`${base}/holds`)).set('cookie', cookie).send({ sessionId: e.sessionId, travelers: [{ key: randomUUID(), travelerTypeId: e.selfType, optionIds: [] }] });

  it('條款與付款說明只給已登入的員工，沒有條款時回傳找不到', async () => {
    const e = await makeEvent();
    await makeEmployee(e);
    const cookie = sessionCookie(await login(e, 'E001', PASSWORD).expect(204));
    await on(e, http().get(`${base}/terms`)).expect(401);
    await on(e, http().get(`${base}/terms`)).set('cookie', cookie).expect(404);
    expect((await state(e, cookie).expect(200)).body.event).toMatchObject({ hasTerms: false, paymentInstructions: null });

    const key = `${e.agencyId}/${randomUUID()}.pdf`;
    await storage.put(key, Buffer.from('%PDF-1.4 terms'));
    await q1(`UPDATE events SET terms_object_key = $2, terms_file_name = '條款.pdf', payment_instructions = '請匯款' WHERE id = $1`, [e.eventId, key]);
    const r = await on(e, http().get(`${base}/terms`)).set('cookie', cookie).buffer(true)
      .parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.body.toString()).toBe('%PDF-1.4 terms');
    expect((await state(e, cookie).expect(200)).body.event).toMatchObject({ hasTerms: true, paymentInstructions: '請匯款' });
  });

  it('登入頁不需登入即可取得報名期間與活動頁狀態', async () => {
    const e = await makeEvent();
    const r = await on(e, http().get(`${base}/landing`));
    expect(r.status).toBe(200);
    expect(r.body.event.pageState).toBe('open');
    expect(r.body.event.registrationOpensAt).toBeTruthy();
    expect(r.body.event.registrationClosesAt).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toContain('itinerary');
    expect((await request(app.getHttpServer()).get(`${base}/landing`).set('x-forwarded-host', 'unknown.lvh.me')).status).toBe(404);
  });

  it('手動關閉時所有員工都不能登入，已登入的員工也不能存取', async () => {
    const e = await makeEvent();
    await makeEmployee(e);
    const cookie = sessionCookie(await login(e, 'E001', PASSWORD));
    await admin.query(`UPDATE events SET page_is_open = false WHERE id = $1`, [e.eventId]);

    const denied = await login(e, 'E001', PASSWORD);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PAGE_CLOSED');
    expect((await state(e, cookie)).status).toBe(403);
    expect((await hold(e, cookie)).status).toBe(403);

    await admin.query(`UPDATE events SET page_is_open = true WHERE id = $1`, [e.eventId]);
    expect((await state(e, cookie)).status).toBe(200);
  });

  it('依時間自動開關：開始前與結束後都不能登入', async () => {
    const before = await makeEvent({ mode: 'scheduled', opensIn: '1 day', closesIn: '2 days' });
    await makeEmployee(before);
    expect((await login(before, 'E001', PASSWORD)).status).toBe(403);
    const landing = await on(before, http().get(`${base}/landing`));
    expect(landing.body.event.pageState).toBe('not_open');
    expect(landing.body.event.pageOpensAt).toBeTruthy();

    const after = await makeEvent({ mode: 'scheduled', opensIn: '-2 days', closesIn: '-1 day' });
    await makeEmployee(after);
    expect((await login(after, 'E001', PASSWORD)).status).toBe(403);
    expect((await on(after, http().get(`${base}/landing`))).body.event.pageState).toBe('closed');

    const during = await makeEvent({ mode: 'scheduled', isOpen: false, opensIn: '-1 day', closesIn: '1 day' });
    await makeEmployee(during);
    expect((await login(during, 'E001', PASSWORD)).status).toBe(204);
  });

  it('活動頁關閉時設定密碼連結仍可使用，但要等開啟才能登入', async () => {
    const e = await makeEvent({ isOpen: false });
    const { token } = await issue(e, await makeEmployee(e, null));
    expect((await lookup(e, token)).status).toBe(200);
    expect((await setPassword(e, token, PASSWORD)).status).toBe(200);
    expect((await login(e, 'E001', PASSWORD)).status).toBe(403);
    await admin.query(`UPDATE events SET page_is_open = true WHERE id = $1`, [e.eventId]);
    expect((await login(e, 'E001', PASSWORD)).status).toBe(204);
  });

  it('關閉時保留中的名額不能送出，到期前也不會被其他人使用', async () => {
    const e = await makeEvent();
    await makeEmployee(e);
    const cookie = sessionCookie(await login(e, 'E001', PASSWORD));
    expect((await hold(e, cookie)).status).toBe(201);
    await admin.query(`UPDATE events SET page_is_open = false WHERE id = $1`, [e.eventId]);
    const r = await on(e, http().post(`${base}/registrations`)).set('cookie', cookie).send({ travelers: [], roomPreferences: [], termsAccepted: true });
    expect(r.status).toBe(403);
    const seat = await q1(`SELECT sold_count FROM event_sessions WHERE id = $1`, [e.sessionId]);
    expect(seat.sold_count).toBe(0);
    expect((await q1(`SELECT count(*)::int AS n FROM seat_holds WHERE session_id = $1 AND status = 'active'`, [e.sessionId])).n).toBe(1);
  });

  it('梯次回傳航班與時間，沒有航班時為空', async () => {
    const e = await makeEvent();
    await makeEmployee(e);
    await admin.query(
      `UPDATE event_sessions SET name = '快樂東京5日遊', departs_on = '2027-03-01', returns_on = '2027-03-05',
              outbound_flight_no = 'CX001', return_flight_no = 'CX002', departure_time = '08:30', return_arrival_time = '19:40' WHERE id = $1`,
      [e.sessionId],
    );
    await admin.query(`INSERT INTO event_sessions (agency_id, event_id, name, capacity, sort_order) VALUES ($1, $2, '無航班', 5, 9)`, [e.agencyId, e.eventId]);
    const cookie = sessionCookie(await login(e, 'E001', PASSWORD));
    const [withFlight, without] = (await state(e, cookie)).body.availability;
    expect(withFlight).toMatchObject({
      name: '快樂東京5日遊', departsOn: '2027-03-01', returnsOn: '2027-03-05',
      outboundFlightNo: 'CX001', returnFlightNo: 'CX002', departureTime: '08:30', returnArrivalTime: '19:40',
    });
    expect(without).toMatchObject({ name: '無航班', outboundFlightNo: null, returnFlightNo: null, departureTime: null, returnArrivalTime: null });
  });

  it('自訂欄位依順序回傳，並檢查必填與各型態的值', async () => {
    const e = await makeEvent();
    await makeEmployee(e);
    const fields: [string, string, unknown, boolean, number][] = [
      ['diet', 'select', ['一般', '素食'], true, 3],
      ['needs', 'multiselect', ['輪椅', '嬰兒車'], true, 1],
      ['age', 'number', null, false, 2],
      ['day', 'date', null, false, 4],
    ];
    for (const [key, type, choices, required, sort] of fields) {
      await admin.query(
        `INSERT INTO event_fields (agency_id, event_id, field_key, label, field_type, choices, is_required, sort_order) VALUES ($1, $2, $3, $3, $4, $5, $6, $7)`,
        [e.agencyId, e.eventId, key, type, choices ? JSON.stringify(choices) : null, required, sort],
      );
    }
    const cookie = sessionCookie(await login(e, 'E001', PASSWORD));
    expect((await state(e, cookie)).body.fields.map((f: { key: string }) => f.key)).toEqual(['needs', 'age', 'diet', 'day']);

    const traveler = { key: randomUUID(), travelerTypeId: e.selfType, optionIds: [] };
    expect((await on(e, http().post(`${base}/holds`)).set('cookie', cookie).send({ sessionId: e.sessionId, travelers: [traveler] })).status).toBe(201);
    const submit = (fieldValues: Record<string, unknown>) =>
      on(e, http().post(`${base}/registrations`)).set('cookie', cookie)
        .send({ travelers: [{ ...traveler, name: '王小明', fieldValues, requestedRoomNo: 1 }], roomPreferences: [], termsAccepted: true });
    const invalidFields = async (values: Record<string, unknown>) => {
      const r = await submit(values);
      expect(r.status).toBe(422);
      return r.body.detail.errors.map((x: { field: string }) => x.field).sort();
    };
    expect(await invalidFields({})).toEqual(['diet', 'needs']);
    expect(await invalidFields({ diet: '葷食', needs: ['輪椅'] })).toEqual(['diet']);
    expect(await invalidFields({ diet: '一般', needs: ['飛機'] })).toEqual(['needs']);
    expect(await invalidFields({ diet: '一般', needs: [] })).toEqual(['needs']);
    expect(await invalidFields({ diet: '一般', needs: ['輪椅'], age: 'abc', day: '2027-13-45' })).toEqual(['age', 'day']);

    const ok = await submit({ diet: '素食', needs: ['輪椅', '嬰兒車'], age: '30', day: '2027-03-01' });
    expect(ok.status).toBe(201);
    expect(ok.body.travelers[0].fieldValues).toMatchObject({ diet: '素食', needs: ['輪椅', '嬰兒車'], age: '30', day: '2027-03-01' });
  });

  it('報名開始前可以登入與查看，但不能報名', async () => {
    const e = await makeEvent({ registrationOpensIn: '3 days' });
    await makeEmployee(e);
    const res = await login(e, 'E001', PASSWORD);
    expect(res.status).toBe(204);
    const cookie = sessionCookie(res);
    const s = await state(e, cookie);
    expect(s.status).toBe(200);
    expect(s.body.event.openState).toBe('not_open');
    expect(s.body.registration).toBeNull();
    const r = await hold(e, cookie);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('REGISTRATION_NOT_OPEN');
  });
});
