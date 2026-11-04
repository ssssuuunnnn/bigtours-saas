import { z } from 'zod';

const travelerSelection = z.object({
  key: z.string().uuid(), // 前端產生，用於草稿與敏感欄位比對
  travelerTypeId: z.string().uuid(),
  optionIds: z.array(z.string().uuid()).max(50).default([]),
});

export const holdRequest = z.object({
  sessionId: z.string().uuid(),
  travelers: z.array(travelerSelection).min(1).max(50),
});
export type HoldRequest = z.infer<typeof holdRequest>;

export const updateHoldRequest = holdRequest.omit({ sessionId: true });

const fieldValue = z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(200)).max(50), z.null()]);

const travelerDetails = travelerSelection.extend({
  name: z.string().trim().max(100).default(''),
  fieldValues: z.record(z.string(), fieldValue).default({}),
  requestedRoomNo: z.number().int().min(1).max(50).nullable().default(null),
});

const roomPreference = z.object({
  requestedRoomNo: z.number().int().min(1).max(50),
  preferredCoworkerName: z.string().trim().max(100).nullable().default(null),
  note: z.string().trim().max(500).nullable().default(null),
});

export const draftRequest = z.object({
  travelers: z.array(travelerDetails).max(50),
  roomPreferences: z.array(roomPreference).max(50).default([]),
});
export type DraftRequest = z.infer<typeof draftRequest>;

export const submitRequest = draftRequest.extend({
  travelers: z.array(travelerDetails).min(1).max(50),
  termsAccepted: z.literal(true),
});
export type SubmitRequest = z.infer<typeof submitRequest>;

export type SeatStatus = 'available' | 'held' | 'sold_out';

/** 已額滿：全部售出；名額保留中：尚有人保留未送出，之後可能釋出。 */
export function seatStatus(capacity: number, sold: number, held: number): SeatStatus {
  if (sold >= capacity) return 'sold_out';
  if (sold + held >= capacity) return 'held';
  return 'available';
}

export interface FeeTraveler {
  basePrice: number;
  optionPrices: number[];
}

export interface FeeResult {
  travelerTotals: number[];
  total: number;
  subsidyAmount: number;
  subsidyApplied: number;
  selfPay: number;
}

/** 每位旅客費用 = 團費 + 自選行程；補助不找零、不累積。 */
export function calculateFees(travelers: FeeTraveler[], subsidyAmount: number): FeeResult {
  const travelerTotals = travelers.map((t) => t.optionPrices.reduce((sum, p) => sum + p, t.basePrice));
  const total = travelerTotals.reduce((sum, t) => sum + t, 0);
  const subsidyApplied = Math.min(total, subsidyAmount);
  return { travelerTotals, total, subsidyAmount, subsidyApplied, selfPay: total - subsidyApplied };
}

/** 敏感欄位只顯示部分內容。 */
export function maskValue(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(value.length - 3)}${value.slice(-1)}`;
}

export const ERROR_CODES = [
  'NOT_FOUND', 'REGISTRATION_NOT_OPEN', 'REGISTRATION_CLOSED', 'ALREADY_REGISTERED', 'HOLD_EXISTS', 'HOLD_EXPIRED',
  'HOLD_MISMATCH', 'SESSION_FULL', 'OPTION_FULL', 'INVALID_SELECTION', 'INVALID_DETAILS', 'NOT_CANCELLABLE',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
