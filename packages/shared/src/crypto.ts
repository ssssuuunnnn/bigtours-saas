import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

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
