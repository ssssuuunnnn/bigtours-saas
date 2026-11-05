import { hashPassword, hashToken } from '@bigtours/shared/crypto';
import pg from 'pg';

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
    for (const t of ['audit_logs', 'agency_user_sessions', 'employee_sessions', 'employee_password_links', 'room_assignments', 'rooms', 'room_preferences', 'registration_revisions', 'traveler_options', 'travelers', 'seat_hold_items', 'seat_holds', 'registration_drafts', 'registrations', 'event_employees', 'event_fields', 'option_session_quotas', 'options', 'option_groups', 'traveler_types', 'event_sessions', 'agency_quota_ledger', 'events', 'company_contacts', 'companies', 'agency_users']) {
      await client.query(`DELETE FROM ${t} WHERE agency_id = $1`, [old.id]);
    }
    await client.query('DELETE FROM agencies WHERE id = $1', [old.id]);
  }
  const agency = (await one(`INSERT INTO agencies (code, name, primary_color) VALUES ($1, '示範旅行社', '#0f766e') RETURNING id`, [code])).id;
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

  const group = async (name: string, required: boolean, min: number, max: number, sort: number) =>
    (await one(`INSERT INTO option_groups (agency_id, event_id, name, is_required, min_select, max_select, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [agency, event, name, required, min, max, sort])).id;
  const option = async (g: string, name: string, price: number, quotas: [string, number][], sort: number) => {
    const o = (await one(`INSERT INTO options (agency_id, group_id, name, price, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [agency, g, name, price, sort])).id;
    for (const [session, capacity] of quotas) {
      await client.query(`INSERT INTO option_session_quotas (agency_id, option_id, session_id, capacity) VALUES ($1, $2, $3, $4)`, [agency, o, session, capacity]);
    }
  };
  const day2 = await group('第二天行程', true, 1, 1, 1);
  await option(day2, '美麗海水族館', 2000, [[s1, 25], [s2, 2]], 1);
  await option(day2, '市區觀光', 0, [], 2);
  const addOn = await group('加購活動', false, 0, 2, 2);
  await option(addOn, '溫泉', 500, [], 1);
  await option(addOn, '晚宴升級', 800, [[s1, 10]], 2);
  const room = await group('房型', true, 1, 1, 3);
  await option(room, '雙人房', 0, [], 1);
  await option(room, '單人房差', 3000, [], 2);

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
