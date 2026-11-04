import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { hashPassword } from '@bigtours/shared/crypto';
import ExcelJS from 'exceljs';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/configure-app.ts';

let app: INestApplication;
let admin: pg.Client;
let smallTier: string;
let password: string;

const q1 = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0];

async function makeAgency(quota = 5) {
  const code = `a-${randomUUID().slice(0, 8)}`;
  const id = (await q1(`INSERT INTO agencies (code, name) VALUES ($1, 'T') RETURNING id`, [code])).id;
  const email = `${code}@example.com`;
  await admin.query(`INSERT INTO agency_users (agency_id, email, password_hash, name, role) VALUES ($1, $2, $3, 'U', 'admin')`, [id, email, password]);
  if (quota) await admin.query(`INSERT INTO agency_quota_ledger (agency_id, pricing_tier_id, change, reason) VALUES ($1, $2, $3, 'grant')`, [id, smallTier, quota]);
  return { id, code, email, host: `${code}.lvh.me` };
}
type Agency = Awaited<ReturnType<typeof makeAgency>>;

function client(a: Agency, cookie?: string) {
  const http = request(app.getHttpServer());
  const wrap = (r: request.Test) => {
    r.set('x-forwarded-host', a.host);
    if (cookie) r.set('Cookie', cookie);
    return r;
  };
  return {
    get: (p: string) => wrap(http.get(`/api/v1/admin${p}`)),
    post: (p: string, b?: object) => wrap(http.post(`/api/v1/admin${p}`)).send(b),
    put: (p: string, b: object) => wrap(http.put(`/api/v1/admin${p}`)).send(b),
    patch: (p: string, b: object) => wrap(http.patch(`/api/v1/admin${p}`)).send(b),
    del: (p: string) => wrap(http.delete(`/api/v1/admin${p}`)),
  };
}

async function login(a: Agency) {
  const r = await client(a).post('/auth/login', { email: a.email, password: 'correct-horse' });
  expect(r.status).toBe(204);
  return client(a, (r.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]);
}

async function makeEvent(api: Awaited<ReturnType<typeof login>>, slug = `ev-${randomUUID().slice(0, 6)}`) {
  const company = (await api.post('/companies', { name: '艾克米' })).body;
  const r = await api.post('/events', { companyId: company.id, name: '員工旅遊', slug, pricingTierId: smallTier });
  expect(r.status).toBe(201);
  return { id: r.body.id as string, slug };
}

async function xlsxBase64(fill: (ws: ExcelJS.Worksheet) => void) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('s');
  ws.addRow(['員工編號', '姓名', 'Email', '部門', '補助金額', '眷屬人數上限']);
  fill(ws);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  password = await hashPassword('correct-horse');
  smallTier = (await q1(`INSERT INTO pricing_tiers (min_travelers, max_travelers, price_amount, is_active) VALUES (1, 20, 500, false)
                         ON CONFLICT (min_travelers, max_travelers) DO UPDATE SET price_amount = EXCLUDED.price_amount RETURNING id`)).id;
  app = await NestFactory.create(AppModule, { logger: false, bodyParser: false });
  configureApp(app);
  await app.init();
  await app.listen(0);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('登入', () => {
  it('未登入被擋；登出後工作階段失效', async () => {
    const a = await makeAgency();
    expect((await client(a).get('/events')).status).toBe(401);
    const api = await login(a);
    expect((await api.get('/me')).body.user.role).toBe('admin');
    expect((await api.post('/auth/logout')).status).toBe(204);
    expect((await api.get('/me')).status).toBe(401);
  });

  it('Cookie 有 HttpOnly 與 SameSite，密碼錯誤與帳號不存在回應相同', async () => {
    const a = await makeAgency();
    const ok = await client(a).post('/auth/login', { email: a.email, password: 'correct-horse' });
    const cookie = (ok.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    const wrong = await client(a).post('/auth/login', { email: a.email, password: 'nope' });
    const none = await client(a).post('/auth/login', { email: 'x@example.com', password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(none.status).toBe(401);
    expect(wrong.body.code).toBe(none.body.code);
  });

  it('連續失敗 5 次後鎖定，正確密碼也不能登入', async () => {
    const a = await makeAgency();
    for (let i = 0; i < 5; i += 1) await client(a).post('/auth/login', { email: a.email, password: 'bad' });
    const r = await client(a).post('/auth/login', { email: a.email, password: 'correct-horse' });
    expect(r.status).toBe(423);
  });

  it('其他旅行社的 Cookie 無效；帳號不能登入其他旅行社', async () => {
    const a = await makeAgency();
    const b = await makeAgency();
    const api = await login(a);
    const cookie = api;
    expect((await cookie.get('/me')).status).toBe(200);
    const r = await client(b).post('/auth/login', { email: a.email, password: 'correct-horse' });
    expect(r.status).toBe(401);
    const login2 = await client(a).post('/auth/login', { email: a.email, password: 'correct-horse' });
    const c = (login2.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    expect((await client(b, c).get('/me')).status).toBe(401);
  });

  it('跨來源的寫入被擋', async () => {
    const a = await makeAgency();
    const login2 = await client(a).post('/auth/login', { email: a.email, password: 'correct-horse' });
    const c = (login2.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const r = await request(app.getHttpServer()).post('/api/v1/admin/companies').set('x-forwarded-host', a.host).set('Cookie', c)
      .set('Origin', 'http://evil.lvh.me').send({ name: 'x' });
    expect(r.status).toBe(403);
  });
});

describe('租戶隔離', () => {
  it('看不到也改不到其他旅行社的活動', async () => {
    const a = await login(await makeAgency());
    const b = await login(await makeAgency());
    const ev = await makeEvent(a);
    expect((await b.get('/events')).body).toHaveLength(0);
    expect((await b.get(`/events/${ev.id}`)).status).toBe(404);
    expect((await b.patch(`/events/${ev.id}`, { name: 'x' })).status).toBe(404);
    expect((await b.del(`/events/${ev.id}`)).status).toBe(404);
    expect((await b.post(`/events/${ev.id}/sessions`, { name: 's', capacity: 1 })).status).toBeGreaterThanOrEqual(400);
    expect((await b.get('/events/not-a-uuid')).status).toBe(404);
  });
});

describe('額度', () => {
  it('同時建立活動不會超扣；刪除未開放的活動會退回', async () => {
    const a = await makeAgency(2);
    const api = await login(a);
    const company = (await api.post('/companies', { name: 'C' })).body;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => api.post('/events', { companyId: company.id, name: 'E', slug: `s-${i}`, pricingTierId: smallTier })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.body.code === 'QUOTA_EXHAUSTED')).toHaveLength(4);

    const id = results.find((r) => r.status === 201)!.body.id;
    expect((await api.del(`/events/${id}`)).status).toBe(204);
    const balance = await q1(`SELECT sum(change)::int AS b FROM agency_quota_ledger WHERE agency_id = $1`, [a.id]);
    expect(balance.b).toBe(1);
  });

  it('活動代碼不可使用保留字或重複', async () => {
    const api = await login(await makeAgency());
    const ev = await makeEvent(api, 'dup-slug');
    const company = (await api.post('/companies', { name: 'C' })).body;
    expect((await api.post('/events', { companyId: company.id, name: 'E', slug: 'admin', pricingTierId: smallTier })).status).toBe(422);
    const dup = await api.post('/events', { companyId: company.id, name: 'E', slug: ev.slug, pricingTierId: smallTier });
    expect(dup.body.code).toBe('DUPLICATE');
  });
});

describe('活動設定', () => {
  it('梯次總名額不可超過所購級距；發布會列出缺少的設定', async () => {
    const api = await login(await makeAgency());
    const ev = await makeEvent(api);
    const missing = await api.post(`/events/${ev.id}/publish`);
    expect(missing.body.detail.problems).toEqual(expect.arrayContaining(['sessions', 'traveler_types', 'registration_period']));

    expect((await api.post(`/events/${ev.id}/sessions`, { name: 'A', capacity: 15 })).status).toBe(201);
    const over = await api.post(`/events/${ev.id}/sessions`, { name: 'B', capacity: 6 });
    expect(over.body.code).toBe('CAPACITY_EXCEEDS_TIER');
    expect((await api.get(`/events/${ev.id}`)).body.sessions).toHaveLength(1);

    await api.post(`/events/${ev.id}/traveler-types`, { name: '本人', basePrice: 100, isEmployeeSelf: true });
    await api.patch(`/events/${ev.id}`, { registrationOpensAt: '2020-01-01T00:00:00Z', registrationClosesAt: '2099-01-01T00:00:00Z' });
    expect((await api.post(`/events/${ev.id}/publish`)).status).toBe(204);
    expect((await api.del(`/events/${ev.id}`)).body.code).toBe('CANNOT_DELETE');
  });

  it('身分證欄位一定是敏感欄位；下拉選單必須有選項', async () => {
    const api = await login(await makeAgency());
    const ev = await makeEvent(api);
    expect((await api.post(`/events/${ev.id}/fields`, { fieldKey: 'nid', label: '身分證', fieldType: 'national_id' })).status).toBe(201);
    expect((await api.get(`/events/${ev.id}`)).body.fields[0].isSensitive).toBe(true);
    expect((await api.post(`/events/${ev.id}/fields`, { fieldKey: 'x', label: 'X', fieldType: 'select' })).status).toBe(422);
  });
});

describe('員工名單', () => {
  it('匯入先預覽再寫入；標出錯誤；支援 Excel 超連結格式的 Email', async () => {
    const api = await login(await makeAgency());
    const ev = await makeEvent(api);
    const file = await xlsxBase64((ws) => {
      ws.addRow(['E1', '王小明', { text: 'a@example.com', hyperlink: 'mailto:a@example.com' }, '業務', 10000, 2]);
      ws.addRow(['E2', '林美惠', 'not-an-email', '', '', '']);
      ws.addRow(['E1', '重複', '', '', '', '']);
      ws.addRow([]);
      ws.addRow(['E3', '=1+1', '', '', -5, '']);
      ws.addRow(['E4', '=HYPERLINK("http://x")', '', '', '', '']);
    });
    const preview = await api.post(`/events/${ev.id}/employees/import/preview`, { fileBase64: file });
    expect(preview.status).toBe(200);
    expect(preview.body.rows.map((r: { employeeNo: string }) => r.employeeNo)).toEqual(['E1', 'E4']);
    expect(preview.body.rows[0]).toMatchObject({ email: 'a@example.com', subsidyAmount: 10000, dependentLimit: 2 });
    expect(preview.body.errors.map((e: { row: number }) => e.row)).toEqual([3, 4, 6]);
    expect((await api.get(`/events/${ev.id}/employees`)).body).toHaveLength(0);

    const commit = await api.post(`/events/${ev.id}/employees/import/commit`, { rows: preview.body.rows });
    expect(commit.body).toMatchObject({ created: 2, updated: 0 });
    expect((await api.get(`/events/${ev.id}/employees`)).body).toHaveLength(2);
  });

  it('檔案不是 Excel 或缺少欄位時回報；重複匯入是更新，補助變更留紀錄', async () => {
    const a = await makeAgency();
    const api = await login(a);
    const ev = await makeEvent(api);
    const bad = await api.post(`/events/${ev.id}/employees/import/preview`, { fileBase64: Buffer.from('hello').toString('base64') });
    expect(bad.body.detail.reason).toBe('not_xlsx');

    const row = { employeeNo: 'E1', name: 'A', email: null, department: null, subsidyAmount: 100, dependentLimit: null };
    await api.post(`/events/${ev.id}/employees/import/commit`, { rows: [row] });
    const again = await api.post(`/events/${ev.id}/employees/import/commit`, { rows: [{ ...row, subsidyAmount: 200 }] });
    expect(again.body).toMatchObject({ created: 0, updated: 1 });
    const log = await q1(`SELECT metadata FROM audit_logs WHERE agency_id = $1 AND action = 'employee.subsidy_changed'`, [a.id]);
    expect(log.metadata).toEqual({ from: 100, to: 200 });
  });
});

describe('從後台建立活動到員工報名', () => {
  it('匯出的連結可用；重新產生後舊連結失效；後台可處理付款與取消', async () => {
    const a = await makeAgency();
    const api = await login(a);
    const ev = await makeEvent(api);
    const session = (await api.post(`/events/${ev.id}/sessions`, { name: '第一梯', capacity: 10, departsOn: '2027-03-01' })).body;
    const self = (await api.post(`/events/${ev.id}/traveler-types`, { name: '本人', basePrice: 15000, isEmployeeSelf: true })).body;
    const group = (await api.post(`/events/${ev.id}/option-groups`, { name: '加購', maxSelect: 2 })).body;
    const option = (await api.post(`/events/${ev.id}/option-groups/${group.id}/options`, { name: '溫泉', price: 500, quotas: [{ sessionId: session.id, capacity: 3 }] })).body;
    await api.post(`/events/${ev.id}/fields`, { fieldKey: 'nid', label: '身分證', fieldType: 'national_id', isRequired: true });
    await api.patch(`/events/${ev.id}`, { registrationOpensAt: '2020-01-01T00:00:00Z', registrationClosesAt: '2099-01-01T00:00:00Z', defaultSubsidyAmount: 10000, defaultDependentLimit: 1 });
    await api.post(`/events/${ev.id}/employees`, { employeeNo: 'E1', name: '王小明' });
    expect((await api.post(`/events/${ev.id}/employees`, { employeeNo: 'E1', name: '重複' })).body.code).toBe('DUPLICATE');

    const before = await request(app.getHttpServer()).get(`/api/v1/public/events/${ev.slug}`).set('x-forwarded-host', a.host).set('x-employee-token', 'x');
    expect(before.status).toBe(404);
    expect((await api.post(`/events/${ev.id}/publish`)).status).toBe(204);

    const exported = await api.get(`/events/${ev.id}/employees/links`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(exported.body);
    const url = String(wb.worksheets[0]!.getRow(2).getCell(5).value);
    expect(url).toContain(`${a.host}`);
    const token = url.split('/e/')[1]!;
    expect(await q1(`SELECT count(*)::int AS n FROM audit_logs WHERE agency_id = $1 AND action = 'employee.links_exported'`, [a.id])).toEqual({ n: 1 });

    const pub = (m: 'get' | 'post', p: string) => request(app.getHttpServer())[m](`/api/v1/public/events/${ev.slug}${p}`).set('x-forwarded-host', a.host).set('x-employee-token', token);
    const key = randomUUID();
    const sel = { key, travelerTypeId: self.id, optionIds: [option.id] };
    expect((await pub('post', '/holds').send({ sessionId: session.id, travelers: [sel] })).status).toBe(201);
    const done = await pub('post', '/registrations').send({ termsAccepted: true, travelers: [{ ...sel, name: '王小明', fieldValues: { nid: 'A123456789' }, requestedRoomNo: 1 }] });
    expect(done.body).toMatchObject({ totalAmount: 15500, selfPayAmount: 5500 });

    const list = (await api.get(`/events/${ev.id}/registrations`)).body;
    expect(list[0]).toMatchObject({ employeeNo: 'E1', selfPayAmount: 5500, paymentStatus: 'unpaid', travelerCount: 1 });
    const detail = (await api.get(`/events/${ev.id}/registrations/${list[0].id}`)).body;
    expect(JSON.stringify(detail)).not.toContain('A123456789');
    expect(detail.travelers[0].fieldValues.nid).toBe('A1*******9');

    expect((await api.patch(`/events/${ev.id}/registrations/${list[0].id}/payment`, { paymentStatus: 'paid' })).status).toBe(204);
    expect((await api.get(`/events/${ev.id}/registrations`)).body[0].paymentStatus).toBe('paid');

    // 有報名時不可移除員工、刪選項、刪欄位，也不可把名額降到已售以下
    const emp = (await api.get(`/events/${ev.id}/employees`)).body[0];
    expect((await api.del(`/events/${ev.id}/employees/${emp.id}`)).body.code).toBe('IN_USE');
    expect((await api.del(`/events/${ev.id}/options/${option.id}`)).body.code).toBe('IN_USE');
    expect((await api.put(`/events/${ev.id}/sessions/${session.id}`, { name: '第一梯', capacity: 0 })).body.code).toBe('CONSTRAINT_VIOLATION');
    expect((await api.put(`/events/${ev.id}/options/${option.id}`, { name: '溫泉', price: 500, quotas: [] })).body.code).toBe('IN_USE');

    // 改價只影響新報名
    await api.put(`/events/${ev.id}/traveler-types/${self.id}`, { name: '本人', basePrice: 99999, isEmployeeSelf: true });
    expect((await pub('get', '')).body.registration.totalAmount).toBe(15500);

    // 取消
    expect((await api.post(`/events/${ev.id}/registrations/${list[0].id}/confirm-cancel`)).body.code).toBe('NOT_CANCELLABLE');
    await pub('post', '/registrations/current/cancel-request');
    expect((await api.post(`/events/${ev.id}/registrations/${list[0].id}/reject-cancel`)).status).toBe(204);
    await pub('post', '/registrations/current/cancel-request');
    expect((await api.post(`/events/${ev.id}/registrations/${list[0].id}/confirm-cancel`)).status).toBe(204);
    const sessionAfter = (await api.get(`/events/${ev.id}`)).body;
    expect(sessionAfter.sessions[0].soldCount).toBe(0);
    expect(sessionAfter.optionGroups[0].options[0].quotas[0].soldCount).toBe(0);

    // 重新產生連結
    expect((await api.post(`/events/${ev.id}/employees/${emp.id}/regenerate-link`)).status).toBe(204);
    expect((await pub('get', '')).status).toBe(404);
  });

  it('移除員工後連結立即失效並釋出保留', async () => {
    const a = await makeAgency();
    const api = await login(a);
    const ev = await makeEvent(api);
    const session = (await api.post(`/events/${ev.id}/sessions`, { name: 'S', capacity: 5 })).body;
    await api.post(`/events/${ev.id}/traveler-types`, { name: '本人', basePrice: 1, isEmployeeSelf: true });
    await api.patch(`/events/${ev.id}`, { registrationOpensAt: '2020-01-01T00:00:00Z', registrationClosesAt: '2099-01-01T00:00:00Z' });
    await api.post(`/events/${ev.id}/publish`);
    const emp = (await api.post(`/events/${ev.id}/employees`, { employeeNo: 'E1', name: 'A' })).body;
    expect((await api.del(`/events/${ev.id}/employees/${emp.id}`)).status).toBe(204);
    expect((await api.get(`/events/${ev.id}/employees`)).body).toHaveLength(0);
    expect(session.id).toBeTruthy();
  });
});
