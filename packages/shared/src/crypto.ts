import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** 本機以環境變數提供金鑰；正式環境改由金鑰管理服務提供。 */
export function loadKey(base64: string | undefined): Buffer {
  const key = Buffer.from(base64 ?? '', 'base64');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY 必須是 32 位元組金鑰的 base64');
  return key;
}

export function encrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decrypt(key: Buffer, data: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

export function hashToken(hashKey: string, token: string): Buffer {
  return createHmac('sha256', hashKey).update(token).digest();
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

// OWASP 建議的 scrypt 參數之一；參數存在雜湊中，之後可調整
const SCRYPT = { N: 2 ** 15, r: 8, p: 3 };
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAX_MEMORY = 128 * SCRYPT.N * SCRYPT.r * 2;

function deriveKey(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, { ...params, maxmem: SCRYPT_MAX_MEMORY }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !N || !r || !p || !salt || !expected) return false;
  const key = await deriveKey(password, Buffer.from(salt, 'base64'), { N: Number(N), r: Number(r), p: Number(p) });
  return timingSafeEqual(key, Buffer.from(expected, 'base64'));
}
