import { hashPassword, hashToken } from '@bigtours/shared/crypto';
import pg from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const DEMO_TERMS_PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>>>endobj\n4 0 obj<</Length 66>>stream\nBT /F1 18 Tf 72 720 Td (Demo registration and privacy terms) Tj ET\nendstream endobj\ntrailer<</Root 1 0 R>>\n";

// 本機示範資料。密碼與連結固定，方便開發；只在本機使用。
const DEMO_PASSWORD = 'demo1234';
const hashKey = process.env.TOKEN_HASH_KEY!;
const base = process.env.WEB_BASE_URL!;
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();

const one = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows[0];

await client.query('BEGIN');
try {
  const code = 'demo-travel';
  const old = await one('SELECT id FROM agencies WHERE code = $1', [code]);
  if (old && process.env.SEED_ONLY_IF_EMPTY) {
    // docker compose 每次啟動都會執行，不可覆蓋開發中的資料
    await client.query('ROLLBACK');
    await client.end();
    console.log('示範資料已存在，略過。');
    process.exit(0);
  }
  if (old) {
    for (const t of ['audit_logs', 'export_jobs', 'export_templates', 'email_messages', 'email_templates', 'room_publications', 'agency_user_sessions', 'employee_sessions', 'employee_password_links', 'room_assignments', 'rooms', 'room_preferences', 'registration_revisions', 'traveler_options', 'travelers', 'seat_hold_items', 'seat_holds', 'registration_drafts', 'registrations', 'event_employees', 'event_fields', 'option_session_quotas', 'options', 'option_groups', 'traveler_types', 'event_sessions', 'agency_quota_ledger', 'events', 'company_contacts', 'companies', 'agency_users']) {
      await client.query(`DELETE FROM ${t} WHERE agency_id = $1`, [old.id]);
    }
    await client.query('DELETE FROM agencies WHERE id = $1', [old.id]);
  }
  const agency = (await one(`INSERT INTO agencies (code, name) VALUES ($1, '示範旅行社') RETURNING id`, [code])).id;
  const company = (await one(`INSERT INTO companies (agency_id, name) VALUES ($1, '艾克米科技') RETURNING id`, [agency])).id;

  let tier = await one('SELECT id FROM pricing_tiers WHERE min_travelers = 200 AND max_travelers = 1000');
  if (!tier) {
    const tiers: [number, number, number][] = [[1, 199, 500], [200, 1000, 1000]];
    for (let lo = 1001, price = 1500; lo <= 5000; lo += 500, price += 500) tiers.push([lo, lo + 499, price]);
    for (const [lo, hi, price] of tiers) {
      await client.query(`INSERT INTO pricing_tiers (min_travelers, max_travelers, price_amount) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [lo, hi, price]);
    }
    tier = await one('SELECT id FROM pricing_tiers WHERE min_travelers = 200 AND max_travelers = 1000');
  }

  await client.query(`INSERT INTO agency_quota_ledger (agency_id, pricing_tier_id, change, reason, note)
                      SELECT $1, id, 3, 'grant', '示範額度' FROM pricing_tiers WHERE is_active AND max_travelers <= 1500`, [agency]);

  const event = (await one(
    `INSERT INTO events (agency_id, company_id, slug, name, status, pricing_tier_id, default_subsidy_amount, default_dependent_limit, ends_on,
                         registration_opens_at, registration_closes_at, itinerary)
     VALUES ($1, $2, 'acme-2027', '2027 艾克米員工旅遊・沖繩三日', 'published', $3, 10000, 2, '2027-03-20',
             now() - interval '1 day', now() + interval '60 days', $4) RETURNING id`,
    [agency, company, tier.id, JSON.stringify({
      summary: '三天兩夜的沖繩員工旅遊，第二天可自選行程。',
      days: [
        { title: '第一天', description: '桃園出發，抵達那霸，國際通自由活動。' },
        { title: '第二天', description: '依自選行程分組活動。' },
        { title: '第三天', description: '首里城巡禮，傍晚搭機返台。' },
      ],
    })],
  )).id;

  const s1 = (await one(`INSERT INTO event_sessions (agency_id, event_id, name, departs_on, returns_on, outbound_flight_no, return_flight_no, departure_time, return_arrival_time, capacity, sort_order) VALUES ($1, $2, '第一梯 沖繩三日遊', '2027-03-01', '2027-03-03', 'CX001', 'CX002', '08:30', '19:40', 40, 1) RETURNING id`, [agency, event])).id;
  const s2 = (await one(`INSERT INTO event_sessions (agency_id, event_id, name, departs_on, returns_on, departure_time, return_arrival_time, capacity, sort_order) VALUES ($1, $2, '第二梯 沖繩三日遊', '2027-03-08', '2027-03-10', '13:15', '21:05', 3, 2) RETURNING id`, [agency, event])).id;

  const types: [string, number, boolean][] = [['員工本人', 15000, true], ['成人眷屬', 12000, false], ['兒童眷屬', 8000, false], ['嬰兒眷屬', 1000, false]];
  for (const [i, [name, price, self]] of types.entries()) {
    await client.query(`INSERT INTO traveler_types (agency_id, event_id, name, base_price, is_employee_self, sort_order) VALUES ($1, $2, $3, $4, $5, $6)`, [agency, event, name, price, self, i]);
  }

  await client.query(`UPDATE traveler_types SET note = '含機票與保險' WHERE event_id = $1 AND name = '成人眷屬'`, [event]);
  await client.query(`UPDATE traveler_types SET note = '未滿 2 歲', occupies_bed = false WHERE event_id = $1 AND name = '嬰兒眷屬'`, [event]);

  const group = async (name: string, required: boolean, min: number, max: number, sort: number) =>
    (await one(`INSERT INTO option_groups (agency_id, event_id, name, is_required, min_select, max_select, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [agency, event, name, required, min, max, sort])).id;
  const option = async (g: string, name: string, price: number, quotas: [string, number][], sort: number) => {
    const o = (await one(`INSERT INTO options (agency_id, group_id, name, price, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [agency, g, name, price, sort])).id;
    for (const [session, capacity] of quotas) {
      await client.query(`INSERT INTO option_session_quotas (agency_id, option_id, session_id, capacity) VALUES ($1, $2, $3, $4)`, [agency, o, session, capacity]);
    }
  };
  const day2 = await group('第二天行程', true, 1, 1, 1);
  await client.query(`UPDATE option_groups SET preference_count = 3 WHERE id = $1`, [day2]);
  await option(day2, '美麗海水族館', 2000, [[s1, 25], [s2, 2]], 1);
  await option(day2, '市區觀光', 0, [], 2);
  const addOn = await group('加購活動', false, 0, 2, 2);
  await option(addOn, '溫泉', 500, [], 1);
  await option(addOn, '晚宴升級', 800, [[s1, 10]], 2);
  const rooms: [string, string, number, number, number][] = [
    [s1, '二人房', 2, 0, 60], [s1, '單人房', 1, 3000, 10], [s2, '三人房', 3, 0, 30], [s2, '二人房', 2, 1000, 20],
  ];
  for (const [i, [session, name, capacity, surcharge, beds]] of rooms.entries()) {
    await client.query(`INSERT INTO session_room_types (agency_id, session_id, name, capacity, surcharge, bed_quota, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [agency, session, name, capacity, surcharge, beds, i]);
  }

  for (const [i, [name, phone, scope]] of [['李冠廷', '0912-000-111', '報名與付款問題'], ['吳佩珊', '0912-000-222', '行前說明、出團當天聯繫']].entries()) {
    await client.query(`INSERT INTO event_service_contacts (agency_id, event_id, name, phone, scope, sort_order) VALUES ($1, $2, $3, $4, $5, $6)`, [agency, event, name, phone, scope, i]);
  }
  // 示範用條款：英文內容才不需要嵌入字型
  const termsKey = `${agency}/events/${event}/terms/v1-demo.pdf`;
  const termsPath = join(process.env.STORAGE_DIR ?? join(tmpdir(), 'bigtours-storage'), termsKey);
  await mkdir(dirname(termsPath), { recursive: true });
  await writeFile(termsPath, DEMO_TERMS_PDF);
  await client.query(
    `UPDATE events SET terms_object_key = $2, terms_file_name = '報名與個資條款.pdf',
            payment_instructions = '請於 2/5（五）前匯款至 示範銀行 012-345678，並在備註填寫員工姓名。\n付款問題請洽 02-2345-6789。' WHERE id = $1`,
    [event, termsKey],
  );

  await client.query(`UPDATE options SET pdf_object_key = $1, pdf_file_name = '美麗海水族館行程.pdf' WHERE agency_id = $2 AND name = '美麗海水族館'`, [termsKey, agency]);

  const fields: [string, string, string, unknown, boolean, boolean][] = [
    ['birthday', '生日', 'date', null, true, false],
    ['national_id', '身分證字號', 'text', null, true, true],
    ['diet', '飲食需求', 'select', ['一般', '素食', '不吃牛'], false, false],
    ['height', '身高（公分）', 'number', null, false, false],
    ['needs', '需要的協助（可複選）', 'multiselect', ['輪椅', '嬰兒車', '低樓層房間'], false, false],
  ];
  for (const [i, [k, label, type, choices, required, sensitive]] of fields.entries()) {
    await client.query(`INSERT INTO event_fields (agency_id, event_id, field_key, label, field_type, choices, is_required, is_sensitive, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [agency, event, k, label, type, choices ? JSON.stringify(choices) : null, required, sensitive, i]);
  }

  const people: [string, string, string, number | null, number | null, boolean][] = [
    ['E001', '王小明', 'e001', null, null, true],
    ['E002', '林美惠', 'e002', 20000, 3, true],
    ['E003', '陳志豪', 'e003', 5000, 0, true],
    ['E004', '張雅婷', 'e004', null, null, false],
  ];
  const demoHash = await hashPassword(DEMO_PASSWORD);
  for (const [email, name, role] of [
    ['admin@demo-travel.example', '示範管理員', 'admin'],
    ['operator@demo-travel.example', '示範活動操作員', 'event_operator'],
    ['ops@demo-travel.example', '示範營運人員', 'operations'],
  ] as const) {
    await client.query(`INSERT INTO agency_users (agency_id, email, password_hash, name, role) VALUES ($1, $2, $3, $4, $5)`, [agency, email, demoHash, name, role]);
  }
  console.log(`\n旅行社後台：${base.replace('{agency}', code)}/admin（admin@、operator@、ops@demo-travel.example／${DEMO_PASSWORD}）`);
  const site = `${base.replace('{agency}', code)}/acme-2027`;
  console.log(`\n報名網站：${site}（示範密碼 ${DEMO_PASSWORD}）`);
  for (const [no, name, slugPart, subsidy, limit, hasPassword] of people) {
    const employee = (await one(
      `INSERT INTO event_employees (agency_id, event_id, employee_no, name, email, subsidy_amount, dependent_limit, password_hash, password_set_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [agency, event, no, name, `${slugPart}@example.com`, subsidy, limit, hasPassword ? demoHash : null, hasPassword ? new Date() : null],
    )).id;
    if (hasPassword) {
      console.log(`${no} ${name}：可直接登入`);
      continue;
    }
    const token = `demo-${slugPart}-local-development-only`;
    await client.query(
      `INSERT INTO employee_password_links (agency_id, event_employee_id, token_hash, delivery, created_by_type, expires_at)
       VALUES ($1, $2, $3, 'manual', 'system', now() + interval '14 days')`,
      [agency, employee, hashToken(hashKey, token)],
    );
    console.log(`${no} ${name}：尚未設定密碼，${site}/set-password/${token}`);
  }
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
