import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { generateToken, hashToken } from '@bigtours/shared/crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
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
    `INSERT INTO event_employees (agency_id, event_id, employee_no, name, subsidy_amount, dependent_limit, link_token_hash, link_token_encrypted)
     VALUES ($1, $2, $3, 'N', $4, $5, $6, '\\x00') RETURNING id`,
    [f.agencyId, eventId, randomUUID(), o.subsidy ?? null, o.limit ?? null, hashToken(process.env.TOKEN_HASH_KEY!, token)],
  )).id;
  return { token, id };
}

const call = (f: Fixture, token: string) => {
  const base = `/api/v1/public/events/${f.slug}`;
  const h = (r: request.Test) => r.set('x-forwarded-host', f.host).set('x-employee-token', token);
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
  it('錯誤連結、其他活動、其他旅行社一律 404', async () => {
    const a = await makeFixture();
    const b = await makeFixture();
    const { token } = await makeEmployee(a);
    expect((await call(a, 'wrong-token').state()).status).toBe(404);
    expect((await call(a, token).state()).status).toBe(200);
    expect((await call({ ...a, slug: 'other' }, token).state()).status).toBe(404);
    expect((await call(b, token).state()).status).toBe(404);
    expect((await call({ ...a, host: 'unknown.lvh.me' }, token).state()).status).toBe(404);
    expect((await call({ ...a, host: 'evil.example.com' }, token).state()).status).toBe(404);
  });

  it('重新產生連結後舊連結失效', async () => {
    const f = await makeFixture();
    const { token, id } = await makeEmployee(f);
    await admin.query(`UPDATE event_employees SET link_token_hash = $1 WHERE id = $2`, [hashToken(process.env.TOKEN_HASH_KEY!, generateToken()), id]);
    expect((await call(f, token).state()).status).toBe(404);
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
