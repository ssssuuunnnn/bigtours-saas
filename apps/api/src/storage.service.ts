import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const IMAGE_KINDS = ['login', 'login-mobile', 'home'] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];
export type EventImages = Record<ImageKind, string | null>;
export const isImageKind = (kind: string): kind is ImageKind => (IMAGE_KINDS as readonly string[]).includes(kind);

const IMAGE_TYPES: Record<string, string> = { svg: 'image/svg+xml', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
export const imageContentType = (key: string) => IMAGE_TYPES[key.split('.').pop()!] ?? 'application/octet-stream';

/** 依檔案內容判斷格式，不相信瀏覽器送來的類型；不是支援的格式回傳 null。 */
export function imageExtension(c: Buffer): string | null {
  if (c.length >= 3 && c[0] === 0xff && c[1] === 0xd8 && c[2] === 0xff) return 'jpg';
  if (c.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (c.subarray(0, 4).toString('latin1') === 'RIFF' && c.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/**
 * 企業 Logo 只收 PNG 與 SVG。SVG 能夾帶程式，含腳本或事件屬性的一律不收；
 * 送出時另外加上沙箱標頭（見 sendImage）。
 */
export function companyLogoExtension(c: Buffer): string | null {
  if (imageExtension(c) === 'png') return 'png';
  const head = c.subarray(0, 2048).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (!/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return null;
  const text = c.toString('utf8');
  if (/<script|<foreignObject|<!ENTITY|\son[a-z]+\s*=|javascript:|(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|data:text)/i.test(text)) return null;
  return 'svg';
}

const version = (key: string) => key.split('/').pop()!.split('.')[0]!;

/** 員工前台用的圖片網址；首頁圖片沒上傳時沿用登入頁背景。 */
export function publicCompanyLogo(slug: string, key: string | null) {
  return key ? `/api/v1/public/events/${slug}/company-logo?v=${version(key)}` : null;
}

export function publicImages(slug: string, images: EventImages) {
  const url = (kind: ImageKind, key: string | null) => (key ? `/api/v1/public/events/${slug}/images/${kind}?v=${version(key)}` : null);
  return {
    login: url('login', images.login),
    loginMobile: url('login-mobile', images['login-mobile']),
    home: url('home', images.home) ?? url('login', images.login),
  };
}

/** 後台用的圖片網址，草稿活動也看得到。 */
export function agencyImages(eventId: string, images: EventImages) {
  const url = (kind: ImageKind, key: string | null) => (key ? `/api/v1/agency/events/${eventId}/images/${kind}?v=${version(key)}` : null);
  return { login: url('login', images.login), loginMobile: url('login-mobile', images['login-mobile']), home: url('home', images.home) };
}

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

  delete(key: string) {
    return rm(join(this.dir, key), { force: true });
  }
}
