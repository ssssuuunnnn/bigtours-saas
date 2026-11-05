import { describe, expect, it } from 'vitest';
import { calculateFees, isValidPassword, maskValue, pageState, seatStatus } from './index.ts';
import { decrypt, encrypt, hashPassword, loadKey, verifyPassword } from './crypto.ts';

describe('calculateFees', () => {
  it('依 PRD 範例計算自付金額', () => {
    const r = calculateFees([{ basePrice: 15000, optionPrices: [500] }, { basePrice: 12000, optionPrices: [500] }], 10000);
    expect(r).toMatchObject({ total: 28000, subsidyApplied: 10000, selfPay: 18000 });
  });
  it('補助用不完時不找零', () => {
    expect(calculateFees([{ basePrice: 8000, optionPrices: [] }], 10000)).toMatchObject({ selfPay: 0, subsidyApplied: 8000 });
  });
});

describe('seatStatus', () => {
  it('區分已額滿與名額保留中', () => {
    expect(seatStatus(10, 10, 0)).toBe('sold_out');
    expect(seatStatus(10, 8, 2)).toBe('held');
    expect(seatStatus(10, 8, 1)).toBe('available');
  });
});

describe('maskValue', () => {
  it('遮罩身分證字號', () => expect(maskValue('A123456789')).toBe('A1*******9'));
  it('短內容全部遮罩', () => expect(maskValue('abcd')).toBe('****'));
});

describe('crypto', () => {
  const key = loadKey(Buffer.alloc(32, 1).toString('base64'));
  it('可還原，且每次密文不同', () => {
    const a = encrypt(key, '身分證');
    expect(decrypt(key, a)).toBe('身分證');
    expect(a.equals(encrypt(key, '身分證'))).toBe(false);
  });
  it('密文遭竄改時失敗', () => {
    const a = encrypt(key, 'x');
    a[a.length - 1]! ^= 1;
    expect(() => decrypt(key, a)).toThrow();
  });
});

describe('isValidPassword', () => {
  it('至少 8 個字元，需同時包含英文與數字', () => {
    expect(isValidPassword('abcd1234')).toBe(true);
    expect(isValidPassword('abc1234')).toBe(false);
    expect(isValidPassword('abcdefgh')).toBe(false);
    expect(isValidPassword('12345678')).toBe(false);
  });
});

describe('密碼雜湊', () => {
  it('正確密碼通過，其他都不通過，相同密碼雜湊不同', async () => {
    const a = await hashPassword('abcd1234');
    const b = await hashPassword('abcd1234');
    expect(a).not.toBe(b);
    expect(a).not.toContain('abcd1234');
    expect(await verifyPassword('abcd1234', a)).toBe(true);
    expect(await verifyPassword('abcd12345', a)).toBe(false);
    expect(await verifyPassword('abcd1234', 'broken')).toBe(false);
  });
});

describe('pageState', () => {
  const opensAt = new Date('2027-01-01T00:00:00Z');
  const closesAt = new Date('2027-02-01T00:00:00Z');
  const at = (s: string) => new Date(s);
  it('手動模式只看開關，不看時間', () => {
    expect(pageState({ mode: 'manual', isOpen: true, opensAt, closesAt }, at('2030-01-01T00:00:00Z'))).toBe('open');
    expect(pageState({ mode: 'manual', isOpen: false, opensAt, closesAt }, at('2027-01-15T00:00:00Z'))).toBe('closed');
  });
  it('自動模式只看時間，結束時間當下已關閉', () => {
    const page = { mode: 'scheduled' as const, isOpen: false, opensAt, closesAt };
    expect(pageState(page, at('2026-12-31T23:59:59Z'))).toBe('not_open');
    expect(pageState(page, opensAt)).toBe('open');
    expect(pageState(page, closesAt)).toBe('closed');
  });
});
