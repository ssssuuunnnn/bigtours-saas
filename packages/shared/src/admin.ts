import { z } from 'zod';

const money = z.number().int().min(0).max(100_000_000);
const slug = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/);
const RESERVED_SLUGS = new Set(['admin', 'api', '_next', 'static', 'public']);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const name = z.string().trim().min(1).max(200);

export const loginRequest = z.object({ email: z.string().trim().email().max(200), password: z.string().min(1).max(200) });

export const companyRequest = z.object({ name });

export const createEventRequest = z.object({
  companyId: z.string().uuid(),
  name,
  slug: slug.refine((s) => !RESERVED_SLUGS.has(s)),
  pricingTierId: z.string().uuid(),
});

export const updateEventRequest = z
  .object({
    name,
    registrationOpensAt: z.string().datetime({ offset: true }).nullable(),
    registrationClosesAt: z.string().datetime({ offset: true }).nullable(),
    endsOn: isoDate.nullable(),
    defaultSubsidyAmount: money,
    defaultDependentLimit: z.number().int().min(0).max(50),
    allowDependentsOnly: z.boolean(),
    retentionDays: z.number().int().min(1).max(3650),
    itinerary: z.object({
      summary: z.string().max(2000).optional(),
      days: z.array(z.object({ title: z.string().max(100), description: z.string().max(2000) })).max(60).optional(),
    }),
  })
  .partial();

export const sessionRequest = z.object({
  name,
  departsOn: isoDate.nullable().default(null),
  returnsOn: isoDate.nullable().default(null),
  capacity: z.number().int().min(0).max(5000),
  sortOrder: z.number().int().default(0),
});

export const travelerTypeRequest = z.object({
  name,
  basePrice: money,
  isEmployeeSelf: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});

export const optionGroupRequest = z
  .object({
    name,
    isRequired: z.boolean().default(false),
    minSelect: z.number().int().min(0).max(50).default(0),
    maxSelect: z.number().int().min(1).max(50).default(1),
    sortOrder: z.number().int().default(0),
  })
  .refine((g) => g.maxSelect >= g.minSelect && (!g.isRequired || g.minSelect >= 1));

export const optionRequest = z.object({
  name,
  description: z.string().max(2000).nullable().default(null),
  price: money,
  sortOrder: z.number().int().default(0),
  quotas: z.array(z.object({ sessionId: z.string().uuid(), capacity: z.number().int().min(0).max(5000) })).max(100).default([]),
});

const FIELD_TYPES = ['text', 'number', 'date', 'select', 'multiselect', 'checkbox', 'national_id', 'passport'] as const;

export const fieldRequest = z
  .object({
    fieldKey: z.string().regex(/^[a-z][a-z0-9_]{0,48}$/),
    label: name,
    fieldType: z.enum(FIELD_TYPES),
    choices: z.array(z.string().trim().min(1).max(100)).max(100).nullable().default(null),
    isRequired: z.boolean().default(false),
    isSensitive: z.boolean().default(false),
    sortOrder: z.number().int().default(0),
  })
  .transform((f) => ({ ...f, isSensitive: f.isSensitive || f.fieldType === 'national_id' || f.fieldType === 'passport' }))
  .refine((f) => !['select', 'multiselect'].includes(f.fieldType) || (f.choices?.length ?? 0) > 0);

export const employeeRequest = z.object({
  employeeNo: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(200).nullable().default(null),
  department: z.string().trim().max(100).nullable().default(null),
  subsidyAmount: money.nullable().default(null),
  dependentLimit: z.number().int().min(0).max(50).nullable().default(null),
});
export type EmployeeRow = z.infer<typeof employeeRequest>;

export const importPreviewRequest = z.object({ fileBase64: z.string().min(1).max(10_000_000) });
export const importCommitRequest = z.object({ rows: z.array(employeeRequest).min(1).max(5000) });

export const paymentRequest = z.object({ paymentStatus: z.enum(['unpaid', 'paid', 'refunded']) });

export const ROSTER_COLUMNS = ['員工編號', '姓名', 'Email', '部門', '補助金額', '眷屬人數上限'] as const;
