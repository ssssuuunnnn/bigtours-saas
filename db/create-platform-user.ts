import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { hashPassword } from '@bigtours/shared/crypto';

/**
 * 建立平台人員帳號：pnpm exec tsx db/create-platform-user.ts <email> <姓名>
 * 帳號已存在時會重設密碼。密碼只顯示這一次。
 */
const [email, name] = process.argv.slice(2);
if (!email || !email.includes('@') || !name) {
  console.error('用法：pnpm exec tsx db/create-platform-user.ts <email> <姓名>');
  process.exit(1);
}
const admin = process.env.DATABASE_ADMIN_URL;
if (!admin) throw new Error('請設定 DATABASE_ADMIN_URL');

const password = `${randomBytes(12).toString('base64url')}7a`;
const client = new pg.Client({ connectionString: admin });
await client.connect();
try {
  await client.query(
    `INSERT INTO platform_users (email, password_hash, name) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name, failed_login_count = 0, locked_until = NULL, status = 'active'`,
    [email, await hashPassword(password), name],
  );
  await client.query(`UPDATE platform_user_sessions SET revoked_at = now() WHERE revoked_at IS NULL AND platform_user_id = (SELECT id FROM platform_users WHERE email = $1)`, [email]);
  console.log(`平台帳號：${email}\n密碼：${password}\n密碼只顯示這一次，請妥善保存。`);
} finally {
  await client.end();
}
