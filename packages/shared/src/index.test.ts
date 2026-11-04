import { describe, expect, it } from 'vitest';
import { calculateFees, maskValue, seatStatus } from './index.ts';
import { decrypt, encrypt, loadKey } from './crypto.ts';

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
