import { Injectable } from '@nestjs/common';
import { decrypt, encrypt, hashToken, loadKey } from '@bigtours/shared/crypto';

@Injectable()
export class EncryptionService {
  private readonly key = loadKey(process.env.DATA_ENCRYPTION_KEY);
  private readonly hashKey = process.env.TOKEN_HASH_KEY ?? '';

  constructor() {
    if (!this.hashKey) throw new Error('請設定 TOKEN_HASH_KEY');
  }

  encryptJson(value: unknown): Buffer {
    return encrypt(this.key, JSON.stringify(value));
  }

  decryptJson<T>(data: Buffer): T {
    return JSON.parse(decrypt(this.key, data)) as T;
  }

  hashToken(token: string): Buffer {
    return hashToken(this.hashKey, token);
  }
}
