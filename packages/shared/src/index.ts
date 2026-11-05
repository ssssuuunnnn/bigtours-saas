import { z } from 'zod';

const travelerSelection = z.object({
  key: z.string().uuid(), // 前端產生，用於草稿與敏感欄位比對
  travelerTypeId: z.string().uuid(),
  optionIds: z.array(z.string().uuid()).max(50).default([]),
  /** 佔床的旅客在有房型的梯次要選房型；不佔床的旅客一律不選。 */
  roomTypeId: z.string().uuid().nullable().default(null),
  /** 依群組列出第二、第三志願；第一志願就是 optionIds 裡選的選項。 */
  preferences: z.record(z.string().uuid(), z.array(z.string().uuid()).max(2)).default({}),
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
  /** 房型每人加價；不佔床或沒有房型時不用傳。 */
  roomSurcharge?: number;
  optionPrices: number[];
}

export interface FeeResult {
  travelerTotals: number[];
  total: number;
  subsidyAmount: number;
  subsidyApplied: number;
  selfPay: number;
}

/** 每位旅客費用 = 團費 + 房型加價 + 自選行程；補助不找零、不累積。 */
export function calculateFees(travelers: FeeTraveler[], subsidyAmount: number): FeeResult {
  const travelerTotals = travelers.map((t) => t.optionPrices.reduce((sum, p) => sum + p, t.basePrice + (t.roomSurcharge ?? 0)));
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
  'UNAUTHENTICATED', 'INVALID_CREDENTIALS', 'PAGE_CLOSED', 'FORBIDDEN_ORIGIN', 'LINK_INVALID', 'INVALID_PASSWORD',
  'INVALID_INPUT', 'CAPACITY_BELOW_SOLD', 'TIER_LIMIT_EXCEEDED', 'SESSION_IN_USE', 'FIELD_LOCKED',
  'FORBIDDEN', 'QUOTA_EMPTY', 'SLUG_TAKEN', 'EVENT_NOT_DRAFT', 'EVENT_NOT_PUBLISHED', 'PAGE_MODE_MISMATCH',
  'DUPLICATE_NAME', 'TRAVELER_TYPE_IN_USE', 'ROOM_TYPE_IN_USE', 'OPTION_IN_USE', 'QUOTA_IN_USE', 'ROOM_FULL',
  'DUPLICATE_EMPLOYEE_NO', 'EMPLOYEE_NO_LOCKED', 'EMPLOYEE_HAS_REGISTRATION', 'CSV_BAD_HEADER', 'CSV_TOO_MANY_ROWS',
  'PUBLISH_BLOCKED', 'PUBLISH_REQUIREMENT', 'INVALID_FILE', 'FILE_TOO_LARGE',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** 至少 8 個字元，需同時包含英文與數字。上限避免過長的密碼耗用雜湊資源。 */
export const passwordRule = z.string().min(8).max(128).regex(/[A-Za-z]/).regex(/[0-9]/);
export const isValidPassword = (password: string) => passwordRule.safeParse(password).success;

export const loginRequest = z.object({
  employeeNo: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(128),
});
export const passwordLinkRequest = z.object({ token: z.string().min(1).max(200) });
export const setPasswordRequest = passwordLinkRequest.extend({ password: passwordRule });

export type PageState = 'open' | 'not_open' | 'closed';

export interface PageSwitch {
  mode: 'manual' | 'scheduled';
  isOpen: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
}

/** 手動與自動擇一：手動模式只看開關，自動模式只看時間。 */
export function pageState(page: PageSwitch, now: Date = new Date()): PageState {
  if (page.mode === 'manual') return page.isOpen ? 'open' : 'closed';
  if (page.opensAt && now < page.opensAt) return 'not_open';
  if (page.closesAt && now >= page.closesAt) return 'closed';
  return 'open';
}

// ===== 旅行社後台 =====

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)));
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const flightNo = z.string().trim().toUpperCase().max(20).nullable().transform((v) => v || null);

export const agencyLoginRequest = z.object({ email: z.string().trim().min(1).max(200), password: z.string().min(1).max(128) });

const money = z.number().int().min(0).max(10_000_000);

/** 房型名額以床位（人）計算；不帶 id 表示新增。 */
export const roomTypeInput = z.object({
  id: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(50),
  capacity: z.number().int().min(1).max(20),
  surcharge: money,
  bedQuota: z.number().int().min(0).max(5000),
});

/** 回程日期是抵達日期；航班選填。 */
export const sessionInput = z.object({
  name: z.string().trim().min(1).max(100),
  departsOn: isoDate,
  returnsOn: isoDate,
  departureTime: clockTime,
  returnArrivalTime: clockTime,
  outboundFlightNo: flightNo.default(null),
  returnFlightNo: flightNo.default(null),
  capacity: z.number().int().min(0).max(5000),
  /** 不帶表示不變更房型。 */
  roomTypes: z.array(roomTypeInput).max(20).optional(),
}).refine((s) => s.returnsOn >= s.departsOn, { path: ['returnsOn'] });
export type SessionInput = z.infer<typeof sessionInput>;

export const FIELD_TYPES = ['text', 'number', 'date', 'select', 'multiselect'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** 單選與多選必須有選項，其他型態不能有。 */
export const fieldInput = z.object({
  label: z.string().trim().min(1).max(100),
  type: z.enum(FIELD_TYPES),
  choices: z.array(z.string().trim().min(1).max(100)).max(50).nullable().default(null),
  isRequired: z.boolean(),
  isSensitive: z.boolean().default(false),
}).superRefine((f, ctx) => {
  const hasChoices = f.type === 'select' || f.type === 'multiselect';
  const unique = new Set(f.choices ?? []).size === (f.choices ?? []).length;
  if (hasChoices ? !f.choices?.length || !unique : f.choices?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['choices'], message: 'invalid choices' });
  }
  if (hasChoices && f.isSensitive) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['isSensitive'], message: 'choices cannot be sensitive' });
});
export type FieldInput = z.infer<typeof fieldInput>;

/** 整份送出；沒有列出的旅客類型會被刪除，順序依陣列。 */
export const pricingRequest = z.object({
  types: z.array(z.object({
    id: z.string().uuid().nullable().default(null),
    name: z.string().trim().min(1).max(50),
    basePrice: money,
    note: z.string().trim().max(200).nullable().transform((v) => v || null),
    occupiesBed: z.boolean(),
  })).min(1).max(20),
  defaultSubsidyAmount: money,
  defaultDependentLimit: z.number().int().min(0).max(50),
  allowDependentsOnly: z.boolean(),
});
export type PricingInput = z.infer<typeof pricingRequest>;

/** 志願只用於單選的群組；1 表示不開啟，最多到第三志願。 */
export const optionGroupInput = z.object({
  name: z.string().trim().min(1).max(100),
  isRequired: z.boolean(),
  maxSelect: z.number().int().min(1).max(20),
  preferenceCount: z.number().int().min(1).max(3),
}).refine((g) => g.preferenceCount === 1 || g.maxSelect === 1, { path: ['preferenceCount'] });
export type OptionGroupInput = z.infer<typeof optionGroupInput>;

/** 名額依梯次設定；capacity 為 null 表示不限名額，沒有列出的梯次不變更。 */
export const optionInput = z.object({
  name: z.string().trim().min(1).max(100),
  price: money,
  quotas: z.array(z.object({
    sessionId: z.string().uuid(),
    capacity: z.number().int().min(0).max(5000).nullable(),
  })).max(100),
});
export type OptionInput = z.infer<typeof optionInput>;

export const paymentTermsRequest = z.object({
  paymentInstructions: z.string().trim().max(2000).nullable().transform((v) => v || null),
  retentionDays: z.number().int().min(1).max(3650),
});
export type PaymentTermsInput = z.infer<typeof paymentTermsRequest>;

/** 整份送出；順序依陣列，服務人員不是後台帳號。 */
export const contactsRequest = z.object({
  contacts: z.array(z.object({
    id: z.string().uuid().nullable().default(null),
    name: z.string().trim().min(1).max(50),
    phone: z.string().trim().min(1).max(30),
    scope: z.string().trim().min(1).max(100),
  })).max(20),
});
export type ContactsInput = z.infer<typeof contactsRequest>;

/** 員工本人團費為 0 時，要明確確認才能發布。 */
export const publishRequest = z.object({ confirmFreeSelfFee: z.boolean().default(false) });

/** 補助與眷屬上限留空時套用活動預設值。 */
export const employeeInput = z.object({
  employeeNo: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(200).nullable().or(z.literal('').transform(() => null)),
  department: z.string().trim().max(100).nullable().transform((v) => v || null),
  subsidyAmount: z.number().int().min(0).max(10_000_000).nullable(),
  dependentLimit: z.number().int().min(0).max(50).nullable(),
});
export type EmployeeInput = z.infer<typeof employeeInput>;

/** 指定員工，或寄給所有還沒收到信（未寄、失敗、已過期）的員工。 */
export const accountEmailRequest = z.union([
  z.object({ employeeIds: z.array(z.string().uuid()).min(1).max(5000) }),
  z.object({ allPending: z.literal(true) }),
]);

export const rosterCopyRequest = z.object({ fromEventId: z.string().uuid() });

export const orderRequest = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });

// ===== 活動設定 =====

const eventSlug = z.string().trim().toLowerCase().min(2).max(50).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/).refine((v) => v !== 'admin');
const eventName = z.string().trim().min(1).max(100);
const optionalText = (max: number) => z.string().trim().max(max).nullable().transform((v) => v || null);
const isoDateTime = z.string().datetime({ offset: true }).nullable();

export const companyInput = z.object({ name: z.string().trim().min(1).max(100) });

export const createEventRequest = z.object({
  companyId: z.string().uuid(),
  name: eventName,
  slug: eventSlug,
  pricingTierId: z.string().uuid(),
});

export const eventBasicRequest = z.object({
  name: eventName,
  slug: eventSlug,
  days: z.array(z.object({ title: z.string().trim().min(1).max(50), description: z.string().trim().max(500) })).max(30),
  themeColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  supportPhone: optionalText(30),
  supportHours: optionalText(100),
});
export type EventBasicInput = z.infer<typeof eventBasicRequest>;

export const eventScheduleRequest = z.object({
  pageMode: z.enum(['manual', 'scheduled']),
  pageOpensAt: isoDateTime,
  pageClosesAt: isoDateTime,
  registrationOpensAt: isoDateTime,
  registrationClosesAt: isoDateTime,
}).superRefine((v, ctx) => {
  const after = (a: string | null, b: string | null) => !a || !b || Date.parse(b) > Date.parse(a);
  if (v.pageMode === 'scheduled' && (!v.pageOpensAt || !v.pageClosesAt)) ctx.addIssue({ code: 'custom', path: ['pageOpensAt'], message: 'required' });
  if (!after(v.pageOpensAt, v.pageClosesAt)) ctx.addIssue({ code: 'custom', path: ['pageClosesAt'], message: 'order' });
  if (!after(v.registrationOpensAt, v.registrationClosesAt)) ctx.addIssue({ code: 'custom', path: ['registrationClosesAt'], message: 'order' });
});
export type EventScheduleInput = z.infer<typeof eventScheduleRequest>;

export const pageSwitchRequest = z.object({ open: z.boolean() });

/** 主色上的文字顏色：淺色配深字，深色配白字。 */
export function readableOn(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#15202B' : '#FFFFFF';
}

// ===== 旅行社人員權限 =====

export const AGENCY_ROLES = ['admin', 'event_operator', 'operations'] as const;
export type AgencyRole = (typeof AGENCY_ROLES)[number];

/** 各權限開放的角色；後端強制檢查，前端只用來決定要顯示什麼。 */
const PERMISSIONS = {
  /** 建立與設定活動、員工名單與帳號開通、企業窗口、Email 範本、釘選選單 */
  configureEvents: ['admin', 'event_operator'],
  /** 報名總覽（營運人員唯讀）、報名管理、行程改派、分房、匯出不含個資的資料 */
  operateEvents: ['admin', 'event_operator', 'operations'],
  /** 查看完整個資、匯出個資、個資紀錄 */
  viewSensitiveData: ['admin'],
  /** 人員管理、旅行社設定 */
  manageAgency: ['admin'],
} as const satisfies Record<string, readonly AgencyRole[]>;
export type AgencyPermission = keyof typeof PERMISSIONS;

export const can = (role: string, permission: AgencyPermission) =>
  (PERMISSIONS[permission] as readonly string[]).includes(role);

export const EVENT_NAV_KEYS = [
  'basic', 'schedule', 'sessions', 'types', 'options', 'fields', 'payment-terms', 'contacts', 'publish',
  'overview', 'roster', 'registrations', 'emails',
  'rooms', 'export',
] as const;
export type EventNavKey = (typeof EVENT_NAV_KEYS)[number];

export const pinnedNavRequest = z.object({
  items: z.array(z.enum(EVENT_NAV_KEYS)).max(EVENT_NAV_KEYS.length).refine((v) => new Set(v).size === v.length),
});
