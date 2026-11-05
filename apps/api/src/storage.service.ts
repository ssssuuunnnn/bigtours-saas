import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 上傳檔案的存放位置。目前存在磁碟目錄；正式環境確定部署方式後，
 * 改用 S3 時只需替換這個類別。key 一律由系統產生，不含使用者輸入。
 */
@Injectable()
export class StorageService {
  private readonly dir: string;

  constructor() {
    const dir = process.env.STORAGE_DIR;
    if (!dir && process.env.NODE_ENV === 'production') throw new Error('缺少 STORAGE_DIR');
    this.dir = dir ?? join(tmpdir(), 'bigtours-storage');
  }

  async put(key: string, content: Buffer) {
    const path = join(this.dir, key);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, content);
    await rename(temp, path);
  }

  get(key: string) {
    return readFile(join(this.dir, key));
  }
}
