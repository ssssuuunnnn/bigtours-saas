import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { generateToken, hashToken } from '@bigtours/shared/crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { MailService } from '../src/mail.service.ts';
import { RegistrationService } from '../src/registration.service.ts';

let app: INestApplication;
let admin: pg.Client;
let service: RegistrationService;
let tierId: string;

interface Fixture {
  agencyId: string;
  code: string;
  slug: string;
  host: string;
  sessionId: string;
  sessionFull: string;
  selfType: string;
  depType: string;
  limitedOption: string;
  freeOption: string;
  quotaId: string;
}

const q1 = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0];

async function makeFixture(opts: { capacity?: number; optionCapacity?: number; allowDependentsOnly?: boolean; closed?: boolean } = {}): Promise<Fixture> {
  const code = `t-${randomUUID().slice(0, 8)}`;
  const slug = 'evt';
  const agencyId = (await q1(`INSERT INTO agencies (code, name) VALUES ($1, 'T') RETURNING id`, [code])).id;
  const company = (await q1(`INSERT INTO companies (agency_id, name) VALUES ($1, 'C') RETURNING id`, [agencyId])).id;
  const event = (await q1(
    `INSERT INTO events (agency_id, company_id, slug, name, status, pricing_tier_id, default_subsidy_amount, default_dependent_limit, allow_dependents_only,
                         registration_opens_at, registration_closes_at)
     VALUES ($1, $2, $3, 'E', 'published', $4, 10000, 2, $5, now() - interval '2 days', now() + ($6 || ' days')::interval) RETURNING id`,
    [agencyId, company, slug, tierId, opts.allowDependentsOnly ?? false, opts.closed ? '-1' : '30'],
  )).id;
  const sessionId = (await q1(`INSERT INTO event_sessions (agency_id, event_id, name, capacity) VALUES ($1, $2, 'S1', $3) RETURNING id`, [agencyId, event, opts.capacity ?? 20])).id;
  const sessionFull = (await q1(`INSERT INTO event_sessions (agency_id, event_id, name, capacity) VALUES ($1, $2, 'S2', 1) RETURNING id`, [agencyId, event])).id;
  const selfType = (await q1(`INSERT INTO traveler_types (agency_id, event_id, name, base_price, is_employee_self) VALUES ($1, $2, '本人', 15000, true) RETURNING id`, [agencyId, event])).id;
  const depType = (await q1(`INSERT INTO traveler_types (agency_id, event_id, name, base_price) VALUES ($1, $2, '眷屬', 12000) RETURNING id`, [agencyId, event])).id;
  const group = (await q1(`INSERT INTO option_groups (agency_id, event_id, name, min_select, max_select) VALUES ($1, $2, 'G', 0, 2) RETURNING id`, [agencyId, event])).id;
  const limitedOption = (await q1(`INSERT INTO options (agency_id, group_id, name, price) VALUES ($1, $2, '限量', 500) RETURNING id`, [agencyId, group])).id;
  const freeOption = (await q1(`INSERT INTO options (agency_id, group_id, name, price) VALUES ($1, $2, '不限', 0) RETURNING id`, [agencyId, group])).id;
  const quotaId = (await q1(`INSERT INTO option_session_quotas (agency_id, option_id, session_id, capacity) VALUES ($1, $2, $3, $4) RETURNING id`, [agencyId, limitedOption, sessionId, opts.optionCapacity ?? 5])).id;
  await admin.query(`INSERT INTO event_fields (agency_id, event_id, field_key, label, field_type, is_required, is_sensitive) VALUES ($1, $2, 'nid', '身分證', 'national_id', true, true)`, [agencyId, event]);
  return { agencyId, code, slug, host: `${code}.lvh.me`, sessionId, sessionFull, selfType, depType, limitedOption, freeOption, quotaId };
}

async function makeEmployee(f: Fixture, o: { subsidy?: number | null; limit?: number | null } = {}) {
  const token = generateToken();
  const eventId = (await q1(`SELECT id FROM events WHERE agency_id = $1`, [f.agencyId])).id;
  const id = (await q1(
    `INSERT INTO event_employees (agency_id, event_id, employee_no, name, subsidy_amount, dependent_limit)
     VALUES ($1, $2, $3, 'N', $4, $5) RETURNING id`,
    [f.agencyId, eventId, randomUUID(), o.subsidy ?? null, o.limit ?? null],
  )).id;
  await admin.query(
    `INSERT INTO employee_sessions (agency_id, event_employee_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [f.agencyId, id, hashToken(process.env.TOKEN_HASH_KEY!, token)],
  );
  return { token, id };
}

const call = (f: Fixture, token: string) => {
  const base = `/api/v1/public/events/${f.slug}`;
  const h = (r: request.Test) => r.set('x-forwarded-host', f.host).set('cookie', `bt_session=${token}`);
  const http = request(app.getHttpServer());
  return {
    state: () => h(http.get(base)),
    availability: () => h(http.get(`${base}/availability`)),
    hold: (body: unknown) => h(http.post(`${base}/holds`)).send(body as object),
    update: (body: unknown) => h(http.patch(`${base}/holds/current`)).send(body as object),
    release: () => h(http.delete(`${base}/holds/current`)),
    draft: (body: unknown) => h(http.put(`${base}/draft`)).send(body as object),
    submit: (body: unknown) => h(http.post(`${base}/registrations`)).send(body as object),
    cancel: () => h(http.post(`${base}/registrations/current/cancel-request`)),
    modifyHold: (body: unknown) => h(http.post(`${base}/registrations/current/modification-hold`)).send(body as object),
    modify: (body: unknown) => h(http.put(`${base}/registrations/current`)).send(body as object),
  };
};

const sel = (typeId: string, optionIds: string[] = []) => ({ key: randomUUID(), travelerTypeId: typeId, optionIds });
const details = (t: ReturnType<typeof sel>, nid: string | null = 'A123456789') => ({
  ...t,
  name: '王小明',
  fieldValues: nid ? { nid } : {},
  requestedRoomNo: 1,
});

async function inBatches<T>(items: (() => Promise<T>)[], size = 40): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map((f) => f()))));
  return out;
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  tierId = (await q1(`INSERT INTO pricing_tiers (min_travelers, max_travelers, price_amount) VALUES (1, 5000, 500)
                      ON CONFLICT (min_travelers, max_travelers) DO UPDATE SET price_amount = EXCLUDED.price_amount RETURNING id`)).id;
  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  await app.listen(0);
  service = app.get(RegistrationService);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('完整流程', () => {
  it('保留後送出，費用、名額與保留狀態都正確', async () => {
    const f = await makeFixture();
    const { token, id } = await makeEmployee(f);
    const api = call(f, token);
    const self = sel(f.selfType, [f.limitedOption]);
    const dep = sel(f.depType, [f.limitedOption]);

    const held = await api.hold({ sessionId: f.sessionId, travelers: [self, dep] });
    expect(held.status).toBe(201);
    expect(new Date(held.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);

    const during = await api.availability();
    expect(during.body[0]).toMatchObject({ remaining: 18 });
    expect(during.body[0].options[0]).toMatchObject({ remaining: 3 });

    const done = await api.submit({ travelers: [details(self), details(dep, 'B223456789')], roomPreferences: [], termsAccepted: true });
    expect(done.status).toBe(201);
    expect(done.body).toMatchObject({ totalAmount: 28000, subsidyApplied: 10000, selfPayAmount: 18000, paymentStatus: 'unpaid', status: 'confirmed' });
    expect(done.body.travelers[0].fieldValues.nid).toBe('A1*******9');

    expect((await q1(`SELECT sold_count FROM event_sessions WHERE id = $1`, [f.sessionId])).sold_count).toBe(2);
    expect((await q1(`SELECT sold_count FROM option_session_quotas WHERE id = $1`, [f.quotaId])).sold_count).toBe(2);
    expect((await q1(`SELECT status FROM seat_holds WHERE event_employee_id = $1`, [id])).status).toBe('converted');

    const after = await api.availability();
    expect(after.body[0]).toMatchObject({ remaining: 18 }); // 只算一次
    expect(after.body[0].options[0]).toMatchObject({ remaining: 3 });

    const stored = await q1(`SELECT sensitive_values_encrypted, field_values FROM travelers WHERE registration_id = $1 LIMIT 1`, [done.body.id]);
    expect(stored.sensitive_values_encrypted.toString('latin1')).not.toContain('A123456789');
    expect(JSON.stringify(stored.field_values)).not.toContain('A123456789');
  });

  it('出發日期不受時區影響', async () => {
    const f = await makeFixture();
    const { token } = await makeEmployee(f);
    await admin.query(`UPDATE event_sessions SET departs_on = '2027-03-08' WHERE id = $1`, [f.sessionId]);
    const session = (await call(f, token).availability()).body.find((s: { id: string }) => s.id === f.sessionId);
    expect(session.departsOn).toBe('2027-03-08');
  });

  it('補助大於費用時自付為 0，付款狀態為無需付款', async () => {
    const f = await makeFixture();
    const { token } = await makeEmployee(f, { subsidy: 50000 });
    const api = call(f, token);
    const self = sel(f.selfType);
    await api.hold({ sessionId: f.sessionId, travelers: [self] });
    const done = await api.submit({ travelers: [details(self)], termsAccepted: true });
    expect(done.body).toMatchObject({ selfPayAmount: 0, paymentStatus: 'not_required' });
  });
});

describe('存取控制', () => {
  it('登入狀態錯誤或屬於其他旅行社時需要登入；其他活動、未知旅行社一律 404', async () => {
    const a = await makeFixture();
    const b = await makeFixture();
    const { token } = await makeEmployee(a);
    expect((await call(a, 'wrong-token').state()).status).toBe(401);
    expect((await call(a, token).state()).status).toBe(200);
    expect((await call({ ...a, slug: 'other' }, token).state()).status).toBe(404);
    expect((await call(b, token).state()).status).toBe(401);
    expect((await call({ ...a, host: 'unknown.lvh.me' }, token).state()).status).toBe(404);
    expect((await call({ ...a, host: 'evil.example.com' }, token).state()).status).toBe(404);
  });

  it('登入狀態過期或被撤銷後需要重新登入', async () => {
    const f = await makeFixture();
    const expired = await makeEmployee(f);
    await admin.query(`UPDATE employee_sessions SET expires_at = now() - interval '1 second' WHERE event_employee_id = $1`, [expired.id]);
    expect((await call(f, expired.token).state()).status).toBe(401);
    const revoked = await makeEmployee(f);
    await admin.query(`UPDATE employee_sessions SET revoked_at = now() WHERE event_employee_id = $1`, [revoked.id]);
    expect((await call(f, revoked.token).state()).status).toBe(401);
  });

  it('報名截止後不能保留', async () => {
    const f = await makeFixture({ closed: true });
    const { token } = await makeEmployee(f);
    const r = await call(f, token).hold({ sessionId: f.sessionId, travelers: [sel(f.selfType)] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('REGISTRATION_CLOSED');
  });
});

describe('報名資格', () => {
  it('員工本人預設必須參加；開放後可只有眷屬', async () => {
    const f = await makeFixture();
    const e = await makeEmployee(f);
    const r = await call(f, e.token).hold({ sessionId: f.sessionId, travelers: [sel(f.depType)] });
    expect(r.status).toBe(422);
    expect(r.body.detail.reason).toBe('self_required');

    const g = await makeFixture({ allowDependentsOnly: true });
    const e2 = await makeEmployee(g);
    const dep = sel(g.depType);
    expect((await call(g, e2.token).hold({ sessionId: g.sessionId, travelers: [dep] })).status).toBe(201);
    const done = await call(g, e2.token).submit({ travelers: [details(dep)], termsAccepted: true });
    expect(done.body).toMatchObject({ totalAmount: 12000, subsidyApplied: 10000, selfPayAmount: 2000 });
  });

  it('眷屬人數依員工設定，留空時套用活動預設', async () => {
    const f = await makeFixture();
    const none = await makeEmployee(f, { limit: 0 });
    const r1 = await call(f, none.token).hold({ sessionId: f.sessionId, travelers: [sel(f.selfType), sel(f.depType)] });
    expect(r1.body.detail.reason).toBe('dependent_limit');
    const dflt = await makeEmployee(f);
    const r2 = await call(f, dflt.token).hold({ sessionId: f.sessionId, travelers: [sel(f.selfType), sel(f.depType), sel(f.depType), sel(f.depType)] });
    expect(r2.body.detail.reason).toBe('dependent_limit');
    expect((await call(f, dflt.token).hold({ sessionId: f.sessionId, travelers: [sel(f.selfType), sel(f.depType), sel(f.depType)] })).status).toBe(201);
  });

  it('必填欄位未填時不能送出，且名額不變', async () => {
    const f = await makeFixture();
    const { token } = await makeEmployee(f);
    const api = call(f, token);
    const self = sel(f.selfType);
    await api.hold({ sessionId: f.sessionId, travelers: [self] });
    const r = await api.submit({ travelers: [details(self, null)], termsAccepted: true });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('INVALID_DETAILS');
    expect((await q1(`SELECT sold_count FROM event_sessions WHERE id = $1`, [f.sessionId])).sold_count).toBe(0);
  });

  it('未同意條款不能送出', async () => {
    const f = await makeFixture();
    const { token } = await makeEmployee(f);
    const api = call(f, token);
    const self = sel(f.selfType);
    await api.hold({ sessionId: f.sessionId, travelers: [self] });
    expect((await api.submit({ travelers: [details(self)], termsAccepted: false })).status).toBe(422);
  });
});

describe('防超賣', () => {
  it('100 人同時搶 10 個名額，只成功 10 位', async () => {
    const f = await makeFixture({ capacity: 10 });
    const employees = await inBatches(Array.from({ length: 100 }, () => () => makeEmployee(f)), 1);
    const results = await inBatches(employees.map((e) => () => call(f, e.token).hold({ sessionId: f.sessionId, travelers: [sel(f.selfType)] })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.body.code === 'SESSION_FULL')).toHaveLength(90);
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
  });

  it('選項名額不超賣', async () => {
    const f = await makeFixture({ capacity: 100, optionCapacity: 5 });
    const employees = await inBatches(Array.from({ length: 40 }, () => () => makeEmployee(f)), 1);
    const results = await inBatches(employees.map((e) => () => call(f, e.token).hold({ sessionId: f.sessionId, travelers: [sel(f.selfType, [f.limitedOption])] })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.body.code === 'OPTION_FULL')).toHaveLength(35);
  });

  it('同一員工同時送出多次，只有一份保留與一筆報名', async () => {
    const f = await makeFixture();
    const { token, id } = await makeEmployee(f);
    const api = call(f, token);
    const self = sel(f.selfType);
    const holds = await Promise.all(Array.from({ length: 8 }, () => api.hold({ sessionId: f.sessionId, travelers: [self] })));
    expect(holds.filter((r) => r.status === 201)).toHaveLength(1);
    const submits = await Promise.all(Array.from({ length: 8 }, () => api.submit({ travelers: [details(self)], termsAccepted: true })));
    expect(submits.filter((r) => r.status === 201)).toHaveLength(1);
    expect(submits.filter((r) => r.status >= 500)).toHaveLength(0);
    expect((await q1(`SELECT count(*)::int AS n FROM registrations WHERE event_employee_id = $1`, [id])).n).toBe(1);
    expect((await q1(`SELECT sold_count FROM event_sessions WHERE id = $1`, [f.sessionId])).sold_count).toBe(1);
  });
});

describe('保留規則', () => {
  it('同一員工同時保留不同梯次，只有一份保留且不會出現伺服器錯誤', async () => {
    const f = await makeFixture();
    const { token, id } = await makeEmployee(f);
    const api = call(f, token);
    const results = await Promise.all(
      [f.sessionId, f.sessionFull, f.sessionId, f.sessionFull].map((sessionId) => api.hold({ sessionId, travelers: [sel(f.selfType)] })),
    );
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    expect((await q1(`SELECT count(*)::int AS n FROM seat_holds WHERE event_employee_id = $1 AND status = 'active'`, [id])).n).toBe(1);
  });

  it('區分已額滿與名額保留中', async () => {
    const f = await makeFixture();
    const a = await makeEmployee(f);
    const b = await makeEmployee(f);
    const self = sel(f.selfType);
    await call(f, a.token).hold({ sessionId: f.sessionFull, travelers: [self] });
    const status = async () => (await call(f, b.token).availability()).body.find((s: { id: string }) => s.id === f.sessionFull).status;
    expect(await status()).toBe('held');
    const r = await call(f, b.token).hold({ sessionId: f.sessionFull, travelers: [sel(f.selfType)] });
    expect(r.body).toMatchObject({ code: 'SESSION_FULL', detail: { status: 'held' } });
    await call(f, a.token).submit({ travelers: [details(self)], termsAccepted: true });
    expect(await status()).toBe('sold_out');
  });

  it('逾時後名額釋出、不能送出；草稿保留，可重新保留', async () => {
    const f = await makeFixture();
    const a = await makeEmployee(f);
    const api = call(f, a.token);
    const self = sel(f.selfType);
    await api.hold({ sessionId: f.sessionFull, travelers: [self] });
    expect((await api.draft({ travelers: [details(self)], roomPreferences: [] })).status).toBe(204);
    await admin.query(`UPDATE seat_holds SET expires_at = now() - interval '1 second' WHERE event_employee_id = $1`, [a.id]);

    const b = await makeEmployee(f);
    const stateB = await call(f, b.token).availability();
    expect(stateB.body.find((s: { id: string }) => s.id === f.sessionFull).remaining).toBe(1);

    const late = await api.submit({ travelers: [details(self)], termsAccepted: true });
    expect(late.status).toBe(410);
    expect(late.body.code).toBe('HOLD_EXPIRED');

    const state = await api.state();
    expect(state.body.hold).toBeNull();
    expect(state.body.draft.travelers[0].name).toBe('王小明');
    expect((await api.hold({ sessionId: f.sessionFull, travelers: [self] })).status).toBe(201);
  });

  it('重新開啟連結時草稿不回傳敏感欄位原值，送出時仍能用已存的值', async () => {
    const f = await makeFixture();
    const { token } = await makeEmployee(f);
    const api = call(f, token);
    const self = sel(f.selfType);
    await api.hold({ sessionId: f.sessionId, travelers: [self] });
    await api.draft({ travelers: [details(self, 'A123456789')], roomPreferences: [] });

    const state = await api.state();
    expect(JSON.stringify(state.body)).not.toContain('A123456789');
    expect(state.body.draft.travelers[0].masks.nid).toBe('A1*******9');

    // 再次儲存草稿但未重填敏感欄位，不應被清空
    await api.draft({ travelers: [details(self, null)], roomPreferences: [] });
    const done = await api.submit({ travelers: [details(self, null)], termsAccepted: true });
    expect(done.status).toBe(201);
    expect(done.body.travelers[0].fieldValues.nid).toBe('A1*******9');
  });

  it('修改人數不重新計時；增加時檢查名額，減少時立即釋出', async () => {
    const f = await makeFixture({ capacity: 3 });
    const a = await makeEmployee(f);
    const b = await makeEmployee(f);
    const api = call(f, a.token);
    const self = sel(f.selfType);
    const first = await api.hold({ sessionId: f.sessionId, travelers: [self, sel(f.depType)] });
    expect((await call(f, b.token).hold({ sessionId: f.sessionId, travelers: [sel(f.selfType)] })).status).toBe(201);

    const tooMany = await api.update({ travelers: [self, sel(f.depType), sel(f.depType)] });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.code).toBe('SESSION_FULL');

    const fewer = await api.update({ travelers: [self] });
    expect(fewer.status).toBe(200);
    expect(fewer.body.quantity).toBe(1);
    expect(fewer.body.expiresAt).toBe(first.body.expiresAt);
    expect((await api.availability()).body[0].remaining).toBe(1);
  });

  it('送出內容與保留不符時拒絕', async () => {
    const f = await makeFixture();
    const { token } = await makeEmployee(f);
    const api = call(f, token);
    const self = sel(f.selfType);
    await api.hold({ sessionId: f.sessionId, travelers: [self] });
    const r = await api.submit({ travelers: [details(self), details(sel(f.depType))], termsAccepted: true });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('HOLD_MISMATCH');
    const r2 = await api.submit({ travelers: [details({ ...self, optionIds: [f.limitedOption] })], termsAccepted: true });
    expect(r2.body.code).toBe('HOLD_MISMATCH');
  });

  it('手動釋出後名額立即回復', async () => {
    const f = await makeFixture();
    const { token } = await makeEmployee(f);
    const api = call(f, token);
    await api.hold({ sessionId: f.sessionId, travelers: [sel(f.selfType, [f.limitedOption])] });
    expect((await api.release()).status).toBe(204);
    const av = (await api.availability()).body[0];
    expect(av.remaining).toBe(20);
    expect(av.options[0].remaining).toBe(5);
  });
});

describe('取消', () => {
  it('員工申請不釋出，旅行社確認後才釋出梯次與選項名額，並可重新報名', async () => {
    const f = await makeFixture();
    const { token } = await makeEmployee(f);
    const api = call(f, token);
    const self = sel(f.selfType, [f.limitedOption]);
    await api.hold({ sessionId: f.sessionId, travelers: [self] });
    const reg = (await api.submit({ travelers: [details(self)], termsAccepted: true })).body;

    const requested = await api.cancel();
    expect(requested.body.status).toBe('cancel_requested');
    expect((await api.availability()).body[0].remaining).toBe(19);
    const blocked = await api.hold({ sessionId: f.sessionId, travelers: [self] });
    expect(blocked.body.code).toBe('ALREADY_REGISTERED');

    await service.confirmCancel(f.agencyId, reg.id, null);
    const av = (await api.availability()).body[0];
    expect(av.remaining).toBe(20);
    expect(av.options[0].remaining).toBe(5);
    expect((await api.state()).body.registration).toBeNull();

    const again = sel(f.selfType);
    expect((await api.hold({ sessionId: f.sessionId, travelers: [again] })).status).toBe(201);
    expect((await api.submit({ travelers: [details(again)], termsAccepted: true })).status).toBe(201);
  });

  it('未申請取消的報名不能直接確認取消', async () => {
    const f = await makeFixture();
    const { token } = await makeEmployee(f);
    const api = call(f, token);
    const self = sel(f.selfType);
    await api.hold({ sessionId: f.sessionId, travelers: [self] });
    const reg = (await api.submit({ travelers: [details(self)], termsAccepted: true })).body;
    await expect(service.confirmCancel(f.agencyId, reg.id, null)).rejects.toThrow();
    expect((await api.availability()).body[0].remaining).toBe(19);
  });
});

describe('房型、不佔床與志願', () => {
  const withRooms = async (beds = 4, opts: { limit?: number } = {}) => {
    const f = await makeFixture();
    const room = async (name: string, capacity: number, surcharge: number, bedQuota: number) =>
      (await q1(`INSERT INTO session_room_types (agency_id, session_id, name, capacity, surcharge, bed_quota) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [f.agencyId, f.sessionId, name, capacity, surcharge, bedQuota])).id as string;
    const twin = await room('二人房', 2, 0, 20);
    const single = await room('單人房', 1, 3000, beds);
    const eventId = (await q1(`SELECT id FROM events WHERE agency_id = $1`, [f.agencyId])).id;
    const infant = (await q1(`INSERT INTO traveler_types (agency_id, event_id, name, base_price, occupies_bed, note) VALUES ($1, $2, '嬰兒', 500, false, '未滿 2 歲') RETURNING id`, [f.agencyId, eventId])).id as string;
    return { f, twin, single, infant, eventId, limit: opts.limit };
  };
  const roomSel = (typeId: string, roomTypeId: string | null, optionIds: string[] = []) => ({ ...sel(typeId, optionIds), roomTypeId });

  it('佔床的旅客要選房型，不佔床的不能選；前台看得到備註與房型', async () => {
    const { f, single, infant } = await withRooms();
    const { token } = await makeEmployee(f);
    const api = call(f, token);
    const state = (await api.state().expect(200)).body;
    expect(state.travelerTypes.find((t: any) => t.name === '嬰兒')).toMatchObject({ note: '未滿 2 歲', occupiesBed: false });
    expect(state.availability[0].roomTypes.map((r: any) => [r.name, r.capacity, r.surcharge, r.remaining, r.status])).toEqual([['二人房', 2, 0, 20, 'available'], ['單人房', 1, 3000, 4, 'available']]);
    expect(state.availability[1].roomTypes).toEqual([]);

    const noRoom = await api.hold({ sessionId: f.sessionId, travelers: [sel(f.selfType, [f.freeOption])] }).expect(422);
    expect(noRoom.body.detail.reason).toBe('room_type_required');
    const bedless = await api.hold({ sessionId: f.sessionId, travelers: [roomSel(f.selfType, single, [f.freeOption]), roomSel(infant, single, [f.freeOption])] }).expect(422);
    expect(bedless.body.detail.reason).toBe('invalid_room_type');
    const other = await api.hold({ sessionId: f.sessionFull, travelers: [roomSel(f.selfType, single, [f.freeOption])] }).expect(422);
    expect(other.body.detail.reason).toBe('invalid_room_type');
  });

  it('房型床位一起保留與售出，費用含房型加價，不佔床不佔床位', async () => {
    const { f, single, infant } = await withRooms();
    const { token, id } = await makeEmployee(f, { subsidy: 0 });
    const api = call(f, token);
    const self = roomSel(f.selfType, single, [f.freeOption]);
    const baby = roomSel(infant, null, [f.freeOption]);
    await api.hold({ sessionId: f.sessionId, travelers: [self, baby] }).expect(201);
    const during = (await api.availability().expect(200)).body[0].roomTypes.find((r: any) => r.id === single);
    expect(during).toMatchObject({ remaining: 3 });
    const reg = (await api.submit({ travelers: [details(self), details(baby)], termsAccepted: true }).expect(201)).body;
    const selfFee = (await q1(`SELECT base_price FROM traveler_types WHERE id = $1`, [f.selfType])).base_price as number;
    expect(reg.totalAmount).toBe(selfFee + 3000 + 500);
    expect(reg.travelers[0].roomType).toEqual({ name: '單人房', surcharge: 3000 });
    expect(reg.travelers[1].roomType).toBeNull();
    expect((await q1(`SELECT sold_count FROM session_room_types WHERE id = $1`, [single])).sold_count).toBe(1);

    // 之後改價不影響已送出的報名
    await admin.query(`UPDATE session_room_types SET surcharge = 9999 WHERE id = $1`, [single]);
    expect((await api.state().expect(200)).body.registration.travelers[0].roomType.surcharge).toBe(3000);

    await api.cancel().expect(200);
    await service.confirmCancel(f.agencyId, reg.id, null);
    expect((await q1(`SELECT sold_count FROM session_room_types WHERE id = $1`, [single])).sold_count).toBe(0);
    expect(id).toBeTruthy();
  });

  it('床位不足時回傳 ROOM_FULL；同時搶最後的床位不會超賣', async () => {
    const { f, single } = await withRooms(3);
    const people = await Promise.all(Array.from({ length: 8 }, () => makeEmployee(f)));
    const results = await inBatches(people.map((p) => () => call(f, p.token).hold({ sessionId: f.sessionId, travelers: [roomSel(f.selfType, single, [f.freeOption])] })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    const failed = results.filter((r) => r.status !== 201);
    expect(failed.every((r) => r.body.code === 'ROOM_FULL')).toBe(true);
    expect(failed[0]!.body.detail).toMatchObject({ roomTypeId: single, remaining: 0, status: 'held' });
  });

  it('修改保留時換房型會釋出舊床位；與保留不符時不能送出', async () => {
    const { f, single, twin } = await withRooms(1);
    const a = await makeEmployee(f);
    const b = await makeEmployee(f);
    const self = roomSel(f.selfType, single, [f.freeOption]);
    await call(f, a.token).hold({ sessionId: f.sessionId, travelers: [self] }).expect(201);
    expect((await call(f, b.token).hold({ sessionId: f.sessionId, travelers: [roomSel(f.selfType, single, [f.freeOption])] }).expect(409)).body.code).toBe('ROOM_FULL');
    const mismatch = await call(f, a.token).submit({ travelers: [{ ...details(self), roomTypeId: twin }], termsAccepted: true }).expect(409);
    expect(mismatch.body.code).toBe('HOLD_MISMATCH');
    await call(f, a.token).update({ travelers: [{ ...self, roomTypeId: twin }] }).expect(200);
    await call(f, b.token).hold({ sessionId: f.sessionId, travelers: [roomSel(f.selfType, single, [f.freeOption])] }).expect(201);
  });

  it('沒有房型的梯次不用選房型', async () => {
    const f = await makeFixture();
    const { token } = await makeEmployee(f);
    await call(f, token).hold({ sessionId: f.sessionId, travelers: [sel(f.selfType, [f.freeOption])] }).expect(201);
  });

  it('第二、第三志願可選已額滿的選項，不佔名額也不計費', async () => {
    const f = await makeFixture({ optionCapacity: 0 });
    await admin.query(`UPDATE option_groups SET max_select = 1, preference_count = 3 WHERE agency_id = $1`, [f.agencyId]);
    const group = (await q1(`SELECT id FROM option_groups WHERE agency_id = $1`, [f.agencyId])).id as string;
    const third = (await q1(`INSERT INTO options (agency_id, group_id, name, price) VALUES ($1, $2, '第三個', 900) RETURNING id`, [f.agencyId, group])).id as string;
    const { token } = await makeEmployee(f, { subsidy: 0 });
    const api = call(f, token);
    const bad = async (preferences: object) => (await api.hold({ sessionId: f.sessionId, travelers: [{ ...sel(f.selfType, [f.freeOption]), preferences }] }).expect(422)).body.detail.reason;
    expect(await bad({ [group]: [f.freeOption] })).toBe('option_preferences');
    expect(await bad({ [group]: [third, third] })).toBe('option_preferences');
    expect(await bad({ [randomUUID()]: [third] })).toBe('option_preferences');

    const self = { ...sel(f.selfType, [f.freeOption]), preferences: { [group]: [f.limitedOption, third] } };
    await api.hold({ sessionId: f.sessionId, travelers: [self] }).expect(201);
    const reg = (await api.submit({ travelers: [details(self)], termsAccepted: true }).expect(201)).body;
    const selfFee = (await q1(`SELECT base_price FROM traveler_types WHERE id = $1`, [f.selfType])).base_price as number;
    expect(reg.totalAmount).toBe(selfFee);
    expect(reg.travelers[0].preferences).toEqual([{ rank: 2, groupName: expect.any(String), optionName: '限量' }, { rank: 3, groupName: expect.any(String), optionName: '第三個' }]);
    expect((await q1(`SELECT sold_count FROM option_session_quotas WHERE id = $1`, [f.quotaId])).sold_count).toBe(0);
  });

  it('群組沒開志願時不能填，超過開放的志願數也不行', async () => {
    const f = await makeFixture();
    const group = (await q1(`SELECT id FROM option_groups WHERE agency_id = $1`, [f.agencyId])).id as string;
    const { token } = await makeEmployee(f);
    const api = call(f, token);
    const r = await api.hold({ sessionId: f.sessionId, travelers: [{ ...sel(f.selfType, [f.freeOption]), preferences: { [group]: [f.limitedOption] } }] }).expect(422);
    expect(r.body.detail.reason).toBe('option_preferences');
  });
});

describe('修改報名', () => {
  /** 已報名一位本人（選限量選項）的員工。 */
  const registered = async (f: Fixture, o: { subsidy?: number; extra?: boolean } = {}) => {
    const { token, id } = await makeEmployee(f, { subsidy: o.subsidy ?? 0, limit: 3 });
    const api = call(f, token);
    const self = sel(f.selfType, [f.limitedOption]);
    const travelers = o.extra ? [self, sel(f.depType)] : [self];
    await api.hold({ sessionId: f.sessionId, travelers });
    const reg = (await api.submit({ travelers: travelers.map((t) => details(t)), termsAccepted: true })).body;
    return { api, reg, id, self };
  };
  /** 用既有旅客 ID 當 key，敏感欄位留空。 */
  const keep = (t: { id: string; travelerTypeId: string; options: { optionId: string }[] }, patch: Record<string, unknown> = {}) => ({
    key: t.id, travelerTypeId: t.travelerTypeId, optionIds: t.options.map((o) => o.optionId), name: '王小明', fieldValues: {}, requestedRoomNo: 1, ...patch,
  });
  const pick = ({ key, travelerTypeId, optionIds }: { key: string; travelerTypeId: string; optionIds: string[] }) => ({ key, travelerTypeId, optionIds });
  const seats = async (f: Fixture, sessionId = f.sessionId) => (await q1(`SELECT sold_count FROM event_sessions WHERE id = $1`, [sessionId])).sold_count;
  const quotaSold = async (f: Fixture) => (await q1(`SELECT sold_count FROM option_session_quotas WHERE id = $1`, [f.quotaId])).sold_count;

  it('送出前原報名不變，加人只保留多出來的名額，送出後名額與費用才更新', async () => {
    const f = await makeFixture({ capacity: 2 });
    const { api, reg } = await registered(f);
    const t = reg.travelers[0];
    const dep = sel(f.depType);
    const edit = [keep(t, { name: '新名字' }), { ...details(dep), name: '眷屬' }];

    const hold = await api.modifyHold({ sessionId: f.sessionId, travelers: edit.map(pick) });
    expect(hold.status).toBe(201);
    expect(hold.body.quantity).toBe(1);
    expect(hold.body.modifying).toBe(true);
    expect((await api.availability()).body[0].remaining).toBe(0);
    const during = (await api.state()).body.registration;
    expect(during.totalAmount).toBe(15500);
    expect(during.travelers).toHaveLength(1);
    expect(during.travelers[0].name).toBe('王小明');
    expect(await seats(f)).toBe(1);

    const done = await api.modify({ travelers: edit, roomPreferences: [] });
    expect(done.status).toBe(200);
    expect(done.body.totalAmount).toBe(27500);
    expect(done.body.travelers.map((x: { name: string }) => x.name)).toEqual(['新名字', '眷屬']);
    expect(done.body.travelers[0].id).toBe(t.id);
    expect(await seats(f)).toBe(2);
    expect((await api.state()).body.hold).toBeNull();
    expect((await api.state()).body.draft).toBeNull();
  });

  it('沒改動時保留 0 位也可以；減少人數和選項在送出後才釋出', async () => {
    const f = await makeFixture();
    const { api, reg } = await registered(f, { extra: true });
    const [a, b] = reg.travelers;
    const same = await api.modifyHold({ sessionId: f.sessionId, travelers: [keep(a), keep(b)].map(pick) });
    expect(same.status).toBe(201);
    expect(same.body.quantity).toBe(0);
    expect(await quotaSold(f)).toBe(1);

    const less = [keep(a, { optionIds: [] })];
    expect((await api.update({ travelers: less.map(pick) })).status).toBe(200);
    expect(await seats(f)).toBe(2);
    expect(await quotaSold(f)).toBe(1);
    expect((await api.availability()).body[0].remaining).toBe(18);

    const done = await api.modify({ travelers: less, roomPreferences: [] });
    expect(done.status).toBe(200);
    expect(done.body.totalAmount).toBe(15000);
    expect(await seats(f)).toBe(1);
    expect(await quotaSold(f)).toBe(0);
    expect((await q1(`SELECT count(*)::int AS n FROM travelers WHERE registration_id = $1`, [reg.id])).n).toBe(1);
  });

  it('放棄或逾時不影響原報名；放棄會清掉修改中的內容', async () => {
    const f = await makeFixture();
    const { api, reg } = await registered(f);
    const t = reg.travelers[0];
    const edit = [keep(t, { name: '改了' })];
    await api.modifyHold({ sessionId: f.sessionId, travelers: edit.map(pick) });
    await api.draft({ travelers: edit, roomPreferences: [] });
    expect((await api.state()).body.draft.travelers[0].name).toBe('改了');
    await api.release();
    const after = (await api.state()).body;
    expect(after.draft).toBeNull();
    expect(after.registration.travelers[0].name).toBe('王小明');

    await api.modifyHold({ sessionId: f.sessionId, travelers: edit.map(pick) });
    await admin.query(`UPDATE seat_holds SET expires_at = now() - interval '1 second' WHERE registration_id IS NULL AND status = 'active' AND agency_id = $1`, [f.agencyId]);
    const late = await api.modify({ travelers: edit, roomPreferences: [] });
    expect(late.body.code).toBe('HOLD_EXPIRED');
    expect((await api.state()).body.registration.travelers[0].name).toBe('王小明');
    expect(await seats(f)).toBe(1);
  });

  it('換梯次要有新梯次的全部名額，送出後才釋出原梯次，保留時間不重新計算', async () => {
    const f = await makeFixture();
    const { api, reg } = await registered(f);
    const t = reg.travelers[0];
    const edit = [keep(t, { optionIds: [] })];
    const first = await api.modifyHold({ sessionId: f.sessionId, travelers: edit.map(pick) });

    const other = await makeEmployee(f);
    const otherApi = call(f, other.token);
    const blocker = sel(f.selfType);
    await otherApi.hold({ sessionId: f.sessionFull, travelers: [blocker] });
    const full = await api.modifyHold({ sessionId: f.sessionFull, travelers: edit.map(pick) });
    expect(full.body.code).toBe('SESSION_FULL');
    expect((await api.state()).body.hold.sessionId).toBe(f.sessionId);
    await otherApi.release();

    const moved = await api.modifyHold({ sessionId: f.sessionFull, travelers: edit.map(pick) });
    expect(moved.status).toBe(201);
    expect(moved.body.quantity).toBe(1);
    expect(moved.body.expiresAt).toBe(first.body.expiresAt);
    expect(await seats(f)).toBe(1);

    const done = await api.modify({ travelers: edit, roomPreferences: [] });
    expect(done.body.sessionId).toBe(f.sessionFull);
    expect(await seats(f)).toBe(0);
    expect(await seats(f, f.sessionFull)).toBe(1);
    expect(await quotaSold(f)).toBe(0);
  });

  it('多佔的選項名額不足時不能保留；自己佔的名額可以繼續用', async () => {
    const f = await makeFixture({ optionCapacity: 1 });
    const { api, reg } = await registered(f, { extra: true });
    const [a, b] = reg.travelers;
    expect((await api.modifyHold({ sessionId: f.sessionId, travelers: [keep(a), keep(b, { optionIds: [f.limitedOption] })].map(pick) })).body.code).toBe('OPTION_FULL');
    expect((await api.modifyHold({ sessionId: f.sessionId, travelers: [keep(a), keep(b)].map(pick) })).status).toBe(201);
  });

  it('沒改動的項目維持原價，新選的用目前價格，手動調整的差額保留，補助不變', async () => {
    const f = await makeFixture();
    const { api, reg } = await registered(f, { subsidy: 1000 });
    const t = reg.travelers[0];
    await admin.query(`UPDATE options SET price = 900 WHERE id = $1`, [f.limitedOption]);
    await admin.query(`UPDATE traveler_types SET base_price = 16000 WHERE id = $1`, [f.selfType]);
    await admin.query(`UPDATE options SET price = 100 WHERE id = $1`, [f.freeOption]);
    await admin.query(`UPDATE registrations SET total_amount = total_amount - 200 WHERE id = $1`, [reg.id]);
    await admin.query(`UPDATE event_employees SET subsidy_amount = 9000 WHERE id = (SELECT event_employee_id FROM registrations WHERE id = $1)`, [reg.id]);

    const edit = [keep(t, { optionIds: [f.limitedOption, f.freeOption] })];
    await api.modifyHold({ sessionId: f.sessionId, travelers: edit.map(pick) });
    const done = (await api.modify({ travelers: edit, roomPreferences: [] })).body;
    // 15500 - 200 手動調整 + 100 新選項
    expect(done.totalAmount).toBe(15400);
    expect(done.subsidyAmount).toBe(1000);
    expect(done.selfPayAmount).toBe(14400);
    expect(done.travelers[0].basePrice).toBe(15000);
  });

  it('已付款維持已付；自付變 0 時未付款改為不用付款', async () => {
    const f = await makeFixture();
    const { api, reg } = await registered(f);
    await admin.query(`UPDATE registrations SET payment_status = 'paid', paid_amount = self_pay_amount WHERE id = $1`, [reg.id]);
    const edit = [keep(reg.travelers[0], { optionIds: [] })];
    await api.modifyHold({ sessionId: f.sessionId, travelers: edit.map(pick) });
    const done = (await api.modify({ travelers: edit, roomPreferences: [] })).body;
    expect(done.paymentStatus).toBe('paid');
    expect(done.selfPayAmount).toBe(15000);
    expect((await q1(`SELECT paid_amount FROM registrations WHERE id = $1`, [reg.id])).paid_amount).toBe(15500);

    const free = await makeFixture();
    const paidBySubsidy = await registered(free, { subsidy: 15000 });
    const clear = [keep(paidBySubsidy.reg.travelers[0], { optionIds: [] })];
    await paidBySubsidy.api.modifyHold({ sessionId: free.sessionId, travelers: clear.map(pick) });
    expect((await paidBySubsidy.api.modify({ travelers: clear, roomPreferences: [] })).body.paymentStatus).toBe('not_required');
  });

  it('敏感欄位留空保留原值，有填才更新；修改紀錄只存遮罩', async () => {
    const f = await makeFixture();
    const { api, reg } = await registered(f);
    const t = reg.travelers[0];
    const stored = () => q1(`SELECT sensitive_values_encrypted AS e, sensitive_masks AS m FROM travelers WHERE id = $1`, [t.id]);
    const original = await stored();

    const unchanged = [keep(t)];
    await api.modifyHold({ sessionId: f.sessionId, travelers: unchanged.map(pick) });
    const first = await api.modify({ travelers: unchanged, roomPreferences: [] });
    expect(first.status).toBe(200);
    expect((await stored()).m).toEqual(original.m);

    const changed = [keep(t, { fieldValues: { nid: 'B123456789' } })];
    await api.modifyHold({ sessionId: f.sessionId, travelers: changed.map(pick) });
    await api.modify({ travelers: changed, roomPreferences: [] });
    expect((await stored()).m).not.toEqual(original.m);

    const rev = await q1(`SELECT summary, before_encrypted, after_encrypted FROM registration_revisions WHERE registration_id = $1 ORDER BY revision_no DESC LIMIT 1`, [reg.id]);
    expect(rev.summary.action).toBe('modified');
    expect(rev.after_encrypted).not.toBeNull();
  });

  it('截止後、申請取消中、沒有報名都不能修改；眷屬上限一樣有效', async () => {
    const f = await makeFixture();
    const { api, reg, self } = await registered(f);
    const t = reg.travelers[0];
    const three = [keep(t), sel(f.depType), sel(f.depType), sel(f.depType), sel(f.depType)];
    expect((await api.modifyHold({ sessionId: f.sessionId, travelers: three.map((x) => pick(x as never)) })).body.code).toBe('INVALID_SELECTION');

    await api.cancel();
    expect((await api.modifyHold({ sessionId: f.sessionId, travelers: [keep(t)].map(pick) })).body.code).toBe('NOT_MODIFIABLE');

    const none = call(f, (await makeEmployee(f)).token);
    expect((await none.modifyHold({ sessionId: f.sessionId, travelers: [self] })).body.code).toBe('NOT_MODIFIABLE');

    const g = await makeFixture();
    const open = await registered(g);
    await open.api.modifyHold({ sessionId: g.sessionId, travelers: [keep(open.reg.travelers[0])].map(pick) });
    await admin.query(`UPDATE events SET registration_closes_at = now() - interval '1 minute' WHERE agency_id = $1`, [g.agencyId]);
    expect((await open.api.modify({ travelers: [keep(open.reg.travelers[0])], roomPreferences: [] })).body.code).toBe('REGISTRATION_CLOSED');
  });

  it('旅行社幫員工加到超過眷屬上限時，員工仍可修改但不能再加', async () => {
    const f = await makeFixture();
    const { api, reg, id } = await registered(f, { extra: true });
    await admin.query(`UPDATE event_employees SET dependent_limit = 0 WHERE id = $1`, [id]);
    const kept = reg.travelers.map((t: never) => keep(t));
    expect((await api.modifyHold({ sessionId: f.sessionId, travelers: kept.map(pick) })).status).toBe(201);
    expect((await api.update({ travelers: [...kept.map(pick), sel(f.depType)] })).body.code).toBe('INVALID_SELECTION');
  });

  it('保留後內容和送出的不一致時不能送出', async () => {
    const f = await makeFixture();
    const { api, reg } = await registered(f);
    const t = reg.travelers[0];
    await api.modifyHold({ sessionId: f.sessionId, travelers: [keep(t)].map(pick) });
    const more = await api.modify({ travelers: [keep(t), { ...details(sel(f.depType)), name: '多' }], roomPreferences: [] });
    expect(more.body.code).toBe('HOLD_MISMATCH');
    expect(await seats(f)).toBe(1);
  });

  it('已分房的旅客沒換梯次時保留分房，換梯次才清除', async () => {
    const f = await makeFixture();
    const { api, reg } = await registered(f);
    const t = reg.travelers[0];
    const hasRow = async () => (await q1(`SELECT count(*)::int AS n FROM room_assignments WHERE traveler_id = $1`, [t.id])).n;
    const room = (await q1(`INSERT INTO rooms (agency_id, session_id, label, capacity) VALUES ($1, $2, '101', 2) RETURNING id`, [f.agencyId, f.sessionId])).id;
    await admin.query(`INSERT INTO room_assignments (agency_id, traveler_id, room_id) VALUES ($1, $2, $3)`, [f.agencyId, t.id, room]);
    const edit = [keep(t)];
    await api.modifyHold({ sessionId: f.sessionId, travelers: edit.map(pick) });
    await api.modify({ travelers: edit, roomPreferences: [] });
    expect(await hasRow()).toBe(1);
    await api.modifyHold({ sessionId: f.sessionFull, travelers: edit.map(pick) });
    await api.modify({ travelers: edit, roomPreferences: [] });
    expect(await hasRow()).toBe(0);
  });
});

describe('報名相關通知信', () => {
  const sent = () => app.get(MailService).sent;
  const until = async (fn: () => boolean) => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error('等待逾時'); };

  it('報名成功寄給員工；申請取消與員工修改寄給旅行社通知信箱，信中沒有身分證', async () => {
    const f = await makeFixture();
    const tag = randomUUID().slice(0, 8);
    const team = `team-${tag}@example.com`;
    const me = `me-${tag}@example.com`;
    await admin.query(`UPDATE events SET notify_emails = $2, payment_instructions = '請匯款到 123' WHERE agency_id = $1`, [f.agencyId, [team]]);
    const { token, id } = await makeEmployee(f, { subsidy: 1000 });
    await admin.query(`UPDATE event_employees SET email = $2 WHERE id = $1`, [id, me]);
    const api = call(f, token);
    const self = sel(f.selfType);
    await api.hold({ sessionId: f.sessionId, travelers: [self] });
    const reg = (await api.submit({ travelers: [details(self)], termsAccepted: true })).body;
    await until(() => sent().some((m) => m.to === me));
    const success = sent().find((m) => m.to === me)!;
    expect(success.subject).toContain('報名成功');
    expect(success.text).toContain('S1');
    expect(success.text).toContain('$14,000');
    expect(success.text).toContain('請匯款到 123');
    expect(success.text).not.toContain('A123456789');

    const t = reg.travelers[0];
    const edit = [{ key: t.id, travelerTypeId: t.travelerTypeId, optionIds: [f.freeOption], name: '王', fieldValues: {}, requestedRoomNo: 1 }];
    await api.modifyHold({ sessionId: f.sessionId, travelers: edit.map(({ key, travelerTypeId, optionIds }) => ({ key, travelerTypeId, optionIds })) });
    expect((await api.modify({ travelers: edit, roomPreferences: [] })).status).toBe(200);
    await until(() => sent().some((m) => m.to === team && m.subject.includes('修改')));
    expect(sent().find((m) => m.to === team)!.text).toContain(`registration=${reg.id}`);

    await api.cancel();
    await until(() => sent().some((m) => m.to === team && m.subject.includes('取消申請')));
    expect(sent().find((m) => m.to === team && m.subject.includes('取消申請'))!.text).toContain('S1');
  });

  it('報名送出後人數達級距 80% 通知旅行社，同一門檻只寄一次', async () => {
    const f = await makeFixture();
    const team = `tier-${randomUUID().slice(0, 8)}@example.com`;
    const { max } = await q1(`SELECT t.max_travelers AS max FROM events e JOIN pricing_tiers t ON t.id = e.pricing_tier_id WHERE e.agency_id = $1`, [f.agencyId]);
    const start = Math.ceil(max * 0.8) - 1;
    await admin.query(`UPDATE events SET notify_emails = $2 WHERE agency_id = $1`, [f.agencyId, [team]]);
    await admin.query(`UPDATE event_sessions SET capacity = $2, sold_count = $3 WHERE id = $1`, [f.sessionId, max, start]);
    const register = async () => {
      const { token } = await makeEmployee(f, { subsidy: 1000 });
      const api = call(f, token);
      const self = sel(f.selfType);
      await api.hold({ sessionId: f.sessionId, travelers: [self] });
      expect((await api.submit({ travelers: [details(self)], termsAccepted: true })).status).toBe(201);
    };
    await register();
    await until(() => sent().some((m) => m.to === team));
    expect(sent().find((m) => m.to === team)!.subject).toContain('80%');
    await register();
    await new Promise((r) => setTimeout(r, 200));
    expect(sent().filter((m) => m.to === team)).toHaveLength(1);
  });
});
