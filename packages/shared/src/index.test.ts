import { describe, expect, it } from 'vitest';
import { AGENCY_ROLES, calculateFees, can, createEventRequest, eventScheduleRequest, isValidPassword, maskValue, pageState, pinnedNavRequest, readableOn, seatStatus } from './index.ts';
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

describe('旅行社角色權限', () => {
  it('活動設定只開放管理員與活動操作員', () => {
    expect(can('admin', 'configureEvents')).toBe(true);
    expect(can('event_operator', 'configureEvents')).toBe(true);
    expect(can('operations', 'configureEvents')).toBe(false);
  });
  it('營運工作三種角色都可以', () => {
    for (const role of AGENCY_ROLES) expect(can(role, 'operateEvents')).toBe(true);
  });
  it('個資與人員管理只開放管理員', () => {
    expect(can('event_operator', 'viewSensitiveData')).toBe(false);
    expect(can('operations', 'manageAgency')).toBe(false);
    expect(can('admin', 'manageAgency')).toBe(true);
  });
  it('未知角色沒有任何權限', () => expect(can('operator', 'operateEvents')).toBe(false));
});

describe('釘選選單', () => {
  it('接受已知項目', () => expect(pinnedNavRequest.safeParse({ items: ['rooms', 'roster'] }).success).toBe(true));
  it('拒絕未知項目與重複項目', () => {
    expect(pinnedNavRequest.safeParse({ items: ['nope'] }).success).toBe(false);
    expect(pinnedNavRequest.safeParse({ items: ['rooms', 'rooms'] }).success).toBe(false);
  });
});

describe('活動設定', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const event = (slug: string) => ({ companyId: id, pricingTierId: id, name: 'E', slug });
  it('活動代碼轉小寫，且不能用保留字或特殊符號', () => {
    expect(createEventRequest.parse(event('Tokyo-2027')).slug).toBe('tokyo-2027');
    expect(createEventRequest.safeParse(event('admin')).success).toBe(false);
    expect(createEventRequest.safeParse(event('a b')).success).toBe(false);
  });
  const schedule = (o: object) => ({ pageMode: 'manual', pageOpensAt: null, pageClosesAt: null, registrationOpensAt: null, registrationClosesAt: null, ...o });
  const t1 = '2027-01-04T01:00:00.000Z', t2 = '2027-01-29T10:00:00.000Z';
  it('自動開關必須有開始與結束時間', () => {
    expect(eventScheduleRequest.safeParse(schedule({ pageMode: 'scheduled' })).success).toBe(false);
    expect(eventScheduleRequest.safeParse(schedule({ pageMode: 'scheduled', pageOpensAt: t1, pageClosesAt: t2 })).success).toBe(true);
  });
  it('結束時間要晚於開始時間', () => {
    expect(eventScheduleRequest.safeParse(schedule({ registrationOpensAt: t2, registrationClosesAt: t1 })).success).toBe(false);
    expect(eventScheduleRequest.safeParse(schedule({ pageOpensAt: t2, pageClosesAt: t1 })).success).toBe(false);
  });
  it('主色上的文字顏色會依深淺調整', () => {
    expect(readableOn('#0E6B72')).toBe('#FFFFFF');
    expect(readableOn('#F2B705')).toBe('#15202B');
  });
});
