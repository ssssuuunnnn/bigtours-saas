import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { isValidTaxId, TRIAL_LIMITS } from '@bigtours/shared';
import { hashPassword } from '@bigtours/shared/crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApp } from '../src/agency-path.ts';
import { AppModule } from '../src/app.module.ts';
import { MailService } from '../src/mail.service.ts';
import { TrialLimitsService } from '../src/trial-limits.service.ts';

let app: INestApplication;
let admin: pg.Client;
let mail: MailService;
let trials: TrialLimitsService;

const http = () => request(app.getHttpServer());
const q1 = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0];

let ipSeq = 0;
const ipBase = Math.floor(Math.random() * 250);
const nextIp = () => `10.${ipBase}.${100 + Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

/** 隨機產生檢查碼正確的統編 */
function taxId(): string {
  for (;;) {
    const head = String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
    for (let d = 0; d < 10; d += 1) if (isValidTaxId(head + d)) return head + d;
  }
}

const application = (over: Record<string, unknown> = {}) => ({
  agencyName: '晴天旅行社',
  code: `t${randomUUID().slice(0, 8)}`,
  taxId: taxId(),
  contactName: '陳小姐',
  phone: '0912-345-678',
  email: `${randomUUID().slice(0, 8)}@example.com`,
  expectedSize: '100～500 人',
  note: '',
  consent: true,
  ...over,
});

const apply = (body: object, ip = nextIp()) => http().post('/api/v1/site/trial-applications').set('x-forwarded-for', ip).send(body);
const tokenFor = (email: string) => {
  const m = [...mail.sent].reverse().find((x) => x.to === email && x.text.includes('/activate/'));
  return /\/activate\/([A-Za-z0-9_-]+)/.exec(m?.text ?? '')?.[1];
};
const setAuto = (on: boolean) => admin.query(`UPDATE platform_settings SET value = $1::jsonb WHERE key = 'trial_auto_approve'`, [JSON.stringify(on)]);

async function login(code: string, email: string, password: string) {
  const res = await http().post(`/api/v1/a/${code}/agency/session`).send({ email, password }).expect(204);
  return (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('bt_agency_session='))!.split(';')[0]!;
}

/** 申請並自助開通，回傳登入後的 Cookie。 */
async function activated(over: Record<string, unknown> = {}) {
  const body = application(over);
  await apply(body).expect(204);
  const token = tokenFor(body.email)!;
  await http().post(`/api/v1/site/activation/${token}`).send({ password: 'trial1234' }).expect(201);
  const agency = await q1(`SELECT * FROM agencies WHERE code = $1`, [body.code]);
  return { body, token, agency, cookie: await login(body.code, body.email, 'trial1234'), prefix: `/api/v1/a/${body.code}` };
}

async function platformCookie() {
  const email = `p-${randomUUID().slice(0, 8)}@example.com`;
  await admin.query(`INSERT INTO platform_users (email, password_hash, name) VALUES ($1, $2, '王平台')`, [email, await hashPassword('platform123')]);
  const res = await http().post('/api/v1/platform/session').send({ email, password: 'platform123' }).expect(204);
  return (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
}

beforeAll(async () => {
  if (process.env.SMTP_URL) throw new Error('測試需要讀取寄出的信，請不要設定 SMTP_URL');
  admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  await setAuto(true);
  app = configureApp(await NestFactory.create(AppModule, { logger: false }));
  await app.init();
  mail = app.get(MailService);
  trials = app.get(TrialLimitsService);
});

afterAll(async () => {
  await setAuto(true);
  await app?.close();
  await admin?.end();
});

describe('試用申請', () => {
  it('送出後等待 Email 驗證，保留網址與統編，寄出驗證信', async () => {
    const body = application();
    await apply(body).expect(204);
    const row = await q1(`SELECT * FROM trial_applications WHERE code = $1`, [body.code]);
    expect(row).toMatchObject({ status: 'unverified', tax_id: body.taxId });
    expect(row.token_hash).not.toBeNull();
    expect(tokenFor(body.email)).toBeTruthy();
    // 進行中的申請佔住網址與統編
    expect((await apply(application({ code: body.code })).expect(409)).body.code).toBe('CODE_UNAVAILABLE');
    expect((await apply(application({ taxId: body.taxId })).expect(409)).body.code).toBe('TAX_ID_USED');
    const check = await http().get(`/api/v1/site/code-check?code=${body.code}`).set('x-forwarded-for', nextIp());
    expect(check.body).toEqual({ available: false, reason: 'taken' });
  });

  it('欄位檢查：統編檢查碼、網址格式、同意條款', async () => {
    const r = await apply(application({ taxId: '12345678', email: 'x', consent: false })).expect(422);
    expect(r.body.detail.fields).toEqual(expect.arrayContaining(['taxId', 'email', 'consent']));
    await apply(application({ code: 'activate' })).expect(422);
    await apply(application({ code: 'A_B' })).expect(422);
  });

  it('陷阱欄位有值時假裝成功但不寫入；同一來源一小時最多 5 筆；同一 Email 一天最多 3 筆', async () => {
    const spam = application({ website: 'http://spam.example' });
    await apply(spam).expect(204);
    expect(await q1(`SELECT 1 AS x FROM trial_applications WHERE code = $1`, [spam.code])).toBeUndefined();

    const ip = nextIp();
    for (let i = 0; i < 5; i += 1) await apply(application(), ip).expect(204);
    expect((await apply(application(), ip).expect(429)).body.code).toBe('TOO_MANY_REQUESTS');

    const email = `${randomUUID().slice(0, 8)}@example.com`;
    for (let i = 0; i < 3; i += 1) await apply(application({ email })).expect(204);
    expect((await apply(application({ email })).expect(429)).body.code).toBe('TOO_MANY_REQUESTS');
  });

  it('跨來源的送出被擋', async () => {
    await apply(application()).set('x-forwarded-host', 'lvh.me').set('origin', 'http://evil.lvh.me').expect(403);
  });

  it('驗證連結過期後不能使用，網址與統編釋出', async () => {
    const body = application();
    await apply(body).expect(204);
    const token = tokenFor(body.email)!;
    await admin.query(`UPDATE trial_applications SET token_expires_at = now() - interval '1 minute' WHERE code = $1`, [body.code]);
    expect((await http().get(`/api/v1/site/activation/${token}`).expect(410)).body.code).toBe('LINK_INVALID');
    await http().post(`/api/v1/site/activation/${token}`).send({ password: 'trial1234' }).expect(410);
    await apply(application({ code: body.code, taxId: body.taxId })).expect(204);
    expect((await q1(`SELECT status FROM trial_applications WHERE token_hash IS NOT NULL AND code = $1 ORDER BY created_at LIMIT 1`, [body.code])).status).toBe('expired');
  });
});

describe('自助開通', () => {
  it('點連結設定密碼即開通：30 天、一場 40 人的活動額度、自己是管理員', async () => {
    const body = application();
    await apply(body).expect(204);
    const token = tokenFor(body.email)!;
    const info = await http().get(`/api/v1/site/activation/${token}`).expect(200);
    expect(info.body).toEqual({ state: 'ready', mode: 'auto', agencyName: body.agencyName, code: body.code, email: body.email, contactName: body.contactName });

    expect((await http().post(`/api/v1/site/activation/${token}`).send({}).expect(422)).body.code).toBe('INVALID_INPUT');
    expect((await http().post(`/api/v1/site/activation/${token}`).send({ password: 'short' }).expect(422)).body.code).toBe('INVALID_PASSWORD');
    const done = await http().post(`/api/v1/site/activation/${token}`).send({ password: 'trial1234' }).expect(201);
    expect(done.body).toEqual({ state: 'activated', code: body.code, email: body.email });

    const agency = await q1(
      `SELECT *, contract_ends_on - contract_starts_on AS span, contract_starts_on = (now() AT TIME ZONE 'Asia/Taipei')::date AS starts_today FROM agencies WHERE code = $1`,
      [body.code],
    );
    expect(agency).toMatchObject({ is_trial: true, tax_id: body.taxId, name: body.agencyName, span: TRIAL_LIMITS.days - 1, starts_today: true });
    const app_ = await q1(`SELECT status, activated_agency_id, verified_at FROM trial_applications WHERE code = $1`, [body.code]);
    expect(app_).toMatchObject({ status: 'approved', activated_agency_id: agency.id });

    const cookie = await login(body.code, body.email, 'trial1234');
    const me = await http().get(`/api/v1/a/${body.code}/agency/me`).set('cookie', cookie).expect(200);
    expect(me.body.user.role).toBe('admin');
    expect(me.body.trial).toMatchObject({ expired: false, daysLeft: TRIAL_LIMITS.days, mail: { total: 0, totalLimit: 100, dailyLimit: 40 }, limits: { events: 1, maxTravelers: 40 } });
    const quota = await http().get(`/api/v1/a/${body.code}/agency/quota`).set('cookie', cookie).expect(200);
    expect(quota.body.filter((t: { remaining: number }) => t.remaining > 0)).toEqual([expect.objectContaining({ minTravelers: 1, maxTravelers: 40, price: 0, remaining: 1 })]);

    // 連結只能用一次；再點顯示已開通
    expect((await http().get(`/api/v1/site/activation/${token}`).expect(200)).body).toEqual({ state: 'activated', code: body.code });
    await http().post(`/api/v1/site/activation/${token}`).send({ password: 'trial1234' }).expect(410);
    // 一個統編只能試用一次
    expect((await apply(application({ taxId: body.taxId })).expect(409)).body.code).toBe('TAX_ID_USED');
  });

  it('同一個連結同時送出兩次只會開通一次', async () => {
    const body = application();
    await apply(body).expect(204);
    const token = tokenFor(body.email)!;
    const results = await Promise.all([1, 2].map(() => http().post(`/api/v1/site/activation/${token}`).send({ password: 'trial1234' })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 410]);
    expect((await q1(`SELECT count(*)::int AS n FROM agencies WHERE code = $1`, [body.code])).n).toBe(1);
  });

  it('只能建立一場活動，人數不能超過 40 人', async () => {
    const t = await activated();
    const company = await http().post(`${t.prefix}/agency/companies`).set('cookie', t.cookie).send({ name: '艾克米' }).expect(201);
    const tier = await q1(`SELECT id FROM pricing_tiers WHERE min_travelers = 1 AND max_travelers = 40 AND price_amount = 0`);
    const event = await http().post(`${t.prefix}/agency/events`).set('cookie', t.cookie)
      .send({ companyId: company.body.id, name: '員工旅遊', slug: 'trip', pricingTierId: tier.id }).expect(201);
    await http().post(`${t.prefix}/agency/events`).set('cookie', t.cookie)
      .send({ companyId: company.body.id, name: '第二場', slug: 'trip2', pricingTierId: tier.id }).expect(409);
    const over = await http().post(`${t.prefix}/agency/events/${event.body.id}/sessions`).set('cookie', t.cookie)
      .send({ name: '第一梯', departsOn: '2027-03-01', returnsOn: '2027-03-03', departureTime: '08:00', returnArrivalTime: '20:00', capacity: 41 });
    expect(over.body.code).toBe('TIER_LIMIT_EXCEEDED');
  });
});

describe('關閉自動開通', () => {
  it('驗證 Email 後等待平台核准；核准時開通並寄設定密碼信', async () => {
    await setAuto(false);
    try {
      const cookie = await platformCookie();
      expect((await http().get('/api/v1/platform/settings').set('cookie', cookie).expect(200)).body).toEqual({ trialAutoApprove: false });
      const body = application();
      await apply(body).expect(204);
      const token = tokenFor(body.email)!;
      expect((await http().get(`/api/v1/site/activation/${token}`).expect(200)).body.mode).toBe('manual');
      expect((await http().post(`/api/v1/site/activation/${token}`).send({}).expect(201)).body).toEqual({ state: 'pending' });
      expect((await http().get(`/api/v1/site/activation/${token}`).expect(200)).body).toEqual({ state: 'pending' });
      expect(await q1(`SELECT 1 AS x FROM agencies WHERE code = $1`, [body.code])).toBeUndefined();

      const list = await http().get('/api/v1/platform/trial-applications?status=pending').set('cookie', cookie).expect(200);
      const row = list.body.find((a: { code: string }) => a.code === body.code);
      expect(row).toMatchObject({ status: 'pending', taxId: body.taxId, agencyId: null });
      expect(row.verifiedAt).not.toBeNull();

      const before = mail.sent.length;
      const approved = await http().post(`/api/v1/platform/trial-applications/${row.id}/approve`).set('cookie', cookie).expect(201);
      expect(approved.body.mailFailed).toBe(false);
      const agency = await q1(`SELECT id, is_trial FROM agencies WHERE code = $1`, [body.code]);
      expect(agency.is_trial).toBe(true);
      expect(approved.body.agencyId).toBe(agency.id);
      expect(mail.sent.slice(before).some((m) => m.to === body.email && m.text.includes(`/${body.code}/admin/set-password/`))).toBe(true);
      // 平台寄的開通信不算在試用寄信數量
      expect((await trials.status(agency.id))!.mail.total).toBe(0);
      await http().post(`/api/v1/platform/trial-applications/${row.id}/approve`).set('cookie', cookie).expect(422);

      // 切回自動開通
      await http().put('/api/v1/platform/settings').set('cookie', cookie).send({ trialAutoApprove: true }).expect(204);
      expect((await http().get('/api/v1/platform/settings').set('cookie', cookie).expect(200)).body).toEqual({ trialAutoApprove: true });
    } finally {
      await setAuto(true);
    }
  });

  it('退回後網址與統編釋出；已驗證的申請可以改回待核准', async () => {
    const cookie = await platformCookie();
    await setAuto(false);
    try {
      const body = application();
      await apply(body).expect(204);
      await http().post(`/api/v1/site/activation/${tokenFor(body.email)}`).send({}).expect(201);
      const row = await q1(`SELECT id FROM trial_applications WHERE code = $1`, [body.code]);
      await http().patch(`/api/v1/platform/trial-applications/${row.id}`).set('cookie', cookie).send({ status: 'rejected' }).expect(204);
      await http().patch(`/api/v1/platform/trial-applications/${row.id}`).set('cookie', cookie).send({ status: 'pending' }).expect(204);
      await http().patch(`/api/v1/platform/trial-applications/${row.id}`).set('cookie', cookie).send({ status: 'rejected' }).expect(204);
      await apply(application({ code: body.code, taxId: body.taxId })).expect(204);
      // 同一個網址已有新的申請，不能改回待核准
      expect(['CODE_UNAVAILABLE', 'TAX_ID_USED']).toContain((await http().patch(`/api/v1/platform/trial-applications/${row.id}`).set('cookie', cookie).send({ status: 'pending' }).expect(409)).body.code);
      await http().patch('/api/v1/platform/trial-applications/not-a-uuid').set('cookie', cookie).send({ status: 'rejected' }).expect(404);
      await http().get('/api/v1/platform/trial-applications').expect(401);
    } finally {
      await setAuto(true);
    }
  });
});

describe('試用限制', () => {
  it('寄信總共 100 封、每天 40 封；一般旅行社不限', async () => {
    const t = await activated();
    for (let i = 0; i < TRIAL_LIMITS.mailPerDay; i += 1) await trials.consumeMail(t.agency.id);
    await expect(trials.consumeMail(t.agency.id)).rejects.toMatchObject({ code: 'TRIAL_MAIL_LIMIT' });
    // 今天的額度用完：邀請人員也會被擋
    const r = await http().post(`${t.prefix}/agency/staff`).set('cookie', t.cookie).send({ name: '小林', email: `${randomUUID().slice(0, 8)}@example.com`, role: 'operations' });
    expect(r.body.code).toBe('TRIAL_MAIL_LIMIT');
    expect(r.status).toBe(429);
    // 換天後可以再寄，直到總數 100 封
    await admin.query(`UPDATE agency_mail_usage SET day = day - 1 WHERE agency_id = $1`, [t.agency.id]);
    await admin.query(`INSERT INTO agency_mail_usage (agency_id, day, sent) VALUES ($1, current_date - 5, $2)`, [t.agency.id, TRIAL_LIMITS.mailTotal - TRIAL_LIMITS.mailPerDay - 1]);
    await trials.consumeMail(t.agency.id);
    await expect(trials.consumeMail(t.agency.id)).rejects.toMatchObject({ code: 'TRIAL_MAIL_LIMIT' });
    expect((await trials.status(t.agency.id))!.mail).toMatchObject({ total: 100, today: 1 });

    await admin.query(`UPDATE agencies SET is_trial = false WHERE id = $1`, [t.agency.id]);
    await trials.consumeMail(t.agency.id);
  });

  it('到期後後台唯讀：可以登入、查看、匯出，不能修改；企業窗口也一樣', async () => {
    const t = await activated();
    await admin.query(`UPDATE agencies SET contract_ends_on = (now() AT TIME ZONE 'Asia/Taipei')::date - 1 WHERE id = $1`, [t.agency.id]);
    const me = await http().get(`${t.prefix}/agency/me`).set('cookie', t.cookie).expect(200);
    expect(me.body.trial).toMatchObject({ expired: true, daysLeft: 0 });
    expect((await http().post(`${t.prefix}/agency/companies`).set('cookie', t.cookie).send({ name: 'X' }).expect(403)).body.code).toBe('TRIAL_EXPIRED');
    await http().put(`${t.prefix}/agency/settings/name`).set('cookie', t.cookie).send({ name: 'Y' }).expect(403);
    await http().get(`${t.prefix}/agency/companies`).set('cookie', t.cookie).expect(200);
    await login(t.body.code, t.body.email, 'trial1234');
    await http().delete(`${t.prefix}/agency/session`).set('cookie', t.cookie).expect(204);
    // 標頭裡自己帶代號也無法繞過（代號只認路徑）
    await http().post('/api/v1/agency/companies').set('x-bt-agency', t.body.code).set('cookie', t.cookie).send({ name: 'Z' }).expect(404);
  });

  it('到期前 7 天、1 天與到期時各通知一次；延長後重新通知', async () => {
    const t = await activated();
    const sentTo = () => mail.sent.filter((m) => m.to === t.body.email && m.subject.includes('免費試用')).length;
    const setEnds = (days: number) => admin.query(`UPDATE agencies SET contract_ends_on = (now() AT TIME ZONE 'Asia/Taipei')::date + $2::int WHERE id = $1`, [t.agency.id, days]);

    await trials.sendNotices();
    expect(sentTo()).toBe(0);
    await setEnds(6);
    await trials.sendNotices();
    await trials.sendNotices();
    expect(sentTo()).toBe(1);
    await setEnds(0);
    await trials.sendNotices();
    expect(sentTo()).toBe(2);
    await setEnds(-1);
    await trials.sendNotices();
    expect(sentTo()).toBe(3);
    expect(mail.sent.filter((m) => m.to === t.body.email).at(-1)!.subject).toContain('已到期');

    // 平台延長試用：重新寄提醒
    const cookie = await platformCookie();
    const today = (await q1(`SELECT to_char((now() AT TIME ZONE 'Asia/Taipei')::date + 3, 'YYYY-MM-DD') AS d`)).d;
    await http().patch(`/api/v1/platform/agencies/${t.agency.id}/contract`).set('cookie', cookie)
      .send({ planNote: '免費試用（延長）', contractStartsOn: '2026-01-01', contractEndsOn: today }).expect(204);
    expect((await q1(`SELECT trial_notice_level FROM agencies WHERE id = $1`, [t.agency.id])).trial_notice_level).toBe(0);
    await trials.sendNotices();
    expect(sentTo()).toBe(4);
  });

  it('到期 30 天後整間刪除；轉正式的不刪；申請紀錄保留，統編不能再申請', async () => {
    const gone = await activated();
    const kept = await activated();
    const cookie = await platformCookie();
    const detail = await http().get(`/api/v1/platform/agencies/${kept.agency.id}`).set('cookie', cookie).expect(200);
    expect(detail.body).toMatchObject({ isTrial: true, taxId: kept.body.taxId });
    await http().post(`/api/v1/platform/agencies/${kept.agency.id}/convert-trial`).set('cookie', cookie).expect(204);

    const old = (days: number) => `(now() AT TIME ZONE 'Asia/Taipei')::date - ${days}`;
    await admin.query(`UPDATE agencies SET contract_ends_on = ${old(TRIAL_LIMITS.retainDays)} WHERE id = ANY($1::uuid[])`, [[gone.agency.id, kept.agency.id]]);
    expect(await trials.purgeExpired()).not.toContain(gone.agency.id); // 剛好第 30 天還保留
    await admin.query(`UPDATE agencies SET contract_ends_on = ${old(TRIAL_LIMITS.retainDays + 1)} WHERE id = ANY($1::uuid[])`, [[gone.agency.id, kept.agency.id]]);
    const purged = await trials.purgeExpired();
    expect(purged).toContain(gone.agency.id);
    expect(purged).not.toContain(kept.agency.id);
    expect(await q1(`SELECT 1 AS x FROM agencies WHERE id = $1`, [gone.agency.id])).toBeUndefined();
    expect(await q1(`SELECT 1 AS x FROM agency_users WHERE agency_id = $1`, [gone.agency.id])).toBeUndefined();
    expect(await q1(`SELECT 1 AS x FROM agencies WHERE id = $1`, [kept.agency.id])).toBeTruthy();
    const app_ = await q1(`SELECT status, activated_agency_id FROM trial_applications WHERE code = $1`, [gone.body.code]);
    expect(app_).toEqual({ status: 'approved', activated_agency_id: null });
    expect((await apply(application({ taxId: gone.body.taxId })).expect(409)).body.code).toBe('TAX_ID_USED');
  });
});
