import { hashPassword, hashToken } from '@bigtours/shared/crypto';
import pg from 'pg';
import { AGENCY_TABLES, buildDemoEvent } from '../apps/api/src/demo-event.ts';
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
    for (const t of AGENCY_TABLES) {
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

  const { eventId: event } = await buildDemoEvent((sql, params) => client.query(sql, params), agency, company, tier.id, {
    slug: 'acme-2027', firstSessionCapacity: 40, aquariumCapacity: 25, dinnerCapacity: 10,
  });

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
  await client.query(
    `INSERT INTO platform_users (email, password_hash, name) VALUES ('platform@bigtours.example', $1, '示範平台人員')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [demoHash],
  );
  await client.query(`INSERT INTO company_contacts (agency_id, company_id, email, password_hash, name) VALUES ($1, $2, 'contact@acme.example', $3, '示範窗口')`, [agency, company, demoHash]);
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
