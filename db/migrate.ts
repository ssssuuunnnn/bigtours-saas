import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const admin = process.env.DATABASE_ADMIN_URL;
const app = process.env.DATABASE_URL;
if (!admin || !app) throw new Error('請設定 DATABASE_ADMIN_URL 與 DATABASE_URL');

const appUrl = new URL(app);
const role = decodeURIComponent(appUrl.username);
const password = decodeURIComponent(appUrl.password);
if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error('資料庫角色名稱不合法');

const client = new pg.Client({ connectionString: admin });
await client.connect();
try {
  // 應用程式角色不可略過 RLS
  const quotedPassword = (await client.query('SELECT quote_literal($1) AS v', [password])).rows[0].v;
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  await client.query(
    `${exists.rowCount ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${quotedPassword}`,
  );

  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`已套用 ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await client.query(`REVOKE ALL ON schema_migrations FROM ${role}`);
  console.log('資料庫已是最新版本');
} finally {
  await client.end();
}
