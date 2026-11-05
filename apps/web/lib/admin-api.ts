import type { EventNavKey } from '@bigtours/shared';
import { ApiError } from './api';

export interface AdminEventSummary { id: string; slug: string; name: string; status: string; companyName: string; registrationOpensAt: string | null; registrationClosesAt: string | null; tierMax: number; travelerCount: number }
export interface AdminEvent {
  id: string; slug: string; name: string; tierMax: number; hasRegistrations: boolean; status: string; companyName: string;
  days: { title: string; description: string }[]; themeColor: string; supportPhone: string | null; supportHours: string | null;
  pageMode: 'manual' | 'scheduled'; pageIsOpen: boolean; pageOpensAt: string | null; pageClosesAt: string | null;
  registrationOpensAt: string | null; registrationClosesAt: string | null; paymentInstructions: string | null; retentionDays: number; termsFileName: string | null; termsVersion: number;
  pageState: 'open' | 'not_open' | 'closed'; activeHolds: number;
}
export interface ContactValues { id: string | null; name: string; phone: string; scope: string }
export type PublishCheckKey = 'basic' | 'heroImage' | 'schedule' | 'sessions' | 'types' | 'options' | 'fields' | 'terms' | 'payment' | 'contacts' | 'roster';
export interface PublishCheck { key: PublishCheckKey; state: 'ok' | 'warn' | 'block' | 'confirm'; data: Record<string, any> }
export interface QuotaTier { id: string; minTravelers: number; maxTravelers: number; price: number; remaining: number }
export interface AdminCompany { id: string; name: string; eventCount: number }
export interface AdminMe { agencyName: string; user: { name: string; role: string }; pinnedNavItems: EventNavKey[] }
export interface SessionValues {
  name: string;
  departsOn: string;
  returnsOn: string;
  departureTime: string;
  returnArrivalTime: string;
  outboundFlightNo: string | null;
  returnFlightNo: string | null;
  capacity: number;
  roomTypes: RoomTypeValues[];
}
export interface RoomTypeValues { id: string | null; name: string; capacity: number; surcharge: number; bedQuota: number; soldCount?: number }
export interface AdminSession extends SessionValues { id: string; soldCount: number }
export interface TravelerTypeValues { id: string | null; name: string; basePrice: number; note: string | null; occupiesBed: boolean; isEmployeeSelf?: boolean }
export interface PricingValues { types: TravelerTypeValues[]; defaultSubsidyAmount: number; defaultDependentLimit: number; allowDependentsOnly: boolean }
export interface OptionGroupValues { name: string; isRequired: boolean; maxSelect: number; preferenceCount: number }
export interface OptionValues { name: string; price: number; quotas: { sessionId: string; capacity: number | null }[] }
export interface AdminOption { id: string; name: string; price: number; quotas: Record<string, { capacity: number; soldCount: number }> }
export interface AdminOptionGroup extends OptionGroupValues { id: string; options: AdminOption[] }
export interface FieldValues { label: string; type: string; choices: string[] | null; isRequired: boolean; isSensitive: boolean }
export interface AdminField extends FieldValues { id: string }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1/agency${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.code ?? 'fallback', data?.detail);
  return data as T;
}

export const adminApi = {
  login: (email: string, password: string) => call<void>('POST', '/session', { email, password }),
  logout: () => call<void>('DELETE', '/session'),
  me: () => call<AdminMe>('GET', '/me'),
  setPinnedNav: (items: EventNavKey[]) => call<void>('PUT', '/me/pinned-nav', { items }),
  events: () => call<AdminEventSummary[]>('GET', '/events'),
  event: (id: string) => call<AdminEvent>('GET', `/events/${id}`),
  quota: () => call<QuotaTier[]>('GET', '/quota'),
  companies: () => call<AdminCompany[]>('GET', '/companies'),
  createCompany: (name: string) => call<AdminCompany>('POST', '/companies', { name }),
  createEvent: (v: { companyId: string; name: string; slug: string; pricingTierId: string }) => call<{ id: string }>('POST', '/events', v),
  deleteEvent: (id: string) => call<void>('DELETE', `/events/${id}`),
  updateBasic: (id: string, v: Pick<AdminEvent, 'name' | 'slug' | 'days' | 'themeColor' | 'supportPhone' | 'supportHours'>) => call<void>('PUT', `/events/${id}/basic`, v),
  updateSchedule: (id: string, v: Pick<AdminEvent, 'pageMode' | 'pageOpensAt' | 'pageClosesAt' | 'registrationOpensAt' | 'registrationClosesAt'>) => call<void>('PUT', `/events/${id}/schedule`, v),
  setPageOpen: (id: string, open: boolean) => call<void>('PUT', `/events/${id}/page`, { open }),
  sessions: (id: string) => call<AdminSession[]>('GET', `/events/${id}/sessions`),
  createSession: (id: string, v: SessionValues) => call<AdminSession>('POST', `/events/${id}/sessions`, v),
  updateSession: (id: string, sid: string, v: SessionValues) => call<AdminSession>('PATCH', `/events/${id}/sessions/${sid}`, v),
  deleteSession: (id: string, sid: string) => call<void>('DELETE', `/events/${id}/sessions/${sid}`),
  orderSessions: (id: string, ids: string[]) => call<void>('PUT', `/events/${id}/sessions/order`, { ids }),
  savePaymentTerms: (id: string, v: { paymentInstructions: string | null; retentionDays: number }) => call<void>('PUT', `/events/${id}/payment-terms`, v),
  uploadTerms: async (id: string, file: File) => {
    const res = await fetch(`/api/v1/agency/events/${id}/terms?name=${encodeURIComponent(file.name)}`, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: file });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data?.code ?? 'fallback', data?.detail);
    return data as { termsFileName: string; termsVersion: number };
  },
  contacts: (id: string) => call<ContactValues[]>('GET', `/events/${id}/contacts`),
  saveContacts: (id: string, contacts: ContactValues[]) => call<ContactValues[]>('PUT', `/events/${id}/contacts`, { contacts }),
  publishCheck: (id: string) => call<{ status: string; checks: PublishCheck[] }>('GET', `/events/${id}/publish-check`),
  publish: (id: string, confirmFreeSelfFee: boolean) => call<void>('POST', `/events/${id}/publish`, { confirmFreeSelfFee }),
  orderOptionGroups: (id: string, ids: string[]) => call<void>('PUT', `/events/${id}/option-groups/order`, { ids }),
  orderOptions: (id: string, gid: string, ids: string[]) => call<void>('PUT', `/events/${id}/option-groups/${gid}/options/order`, { ids }),
  pricing: (id: string) => call<PricingValues>('GET', `/events/${id}/pricing`),
  savePricing: (id: string, v: PricingValues) => call<PricingValues>('PUT', `/events/${id}/pricing`, v),
  optionGroups: (id: string) => call<AdminOptionGroup[]>('GET', `/events/${id}/option-groups`),
  createOptionGroup: (id: string, v: OptionGroupValues) => call<{ id: string }>('POST', `/events/${id}/option-groups`, v),
  updateOptionGroup: (id: string, gid: string, v: OptionGroupValues) => call<void>('PATCH', `/events/${id}/option-groups/${gid}`, v),
  deleteOptionGroup: (id: string, gid: string) => call<void>('DELETE', `/events/${id}/option-groups/${gid}`),
  createOption: (id: string, gid: string, v: OptionValues) => call<{ id: string }>('POST', `/events/${id}/option-groups/${gid}/options`, v),
  updateOption: (id: string, oid: string, v: OptionValues) => call<void>('PATCH', `/events/${id}/options/${oid}`, v),
  deleteOption: (id: string, oid: string) => call<void>('DELETE', `/events/${id}/options/${oid}`),
  fields: (id: string) => call<AdminField[]>('GET', `/events/${id}/fields`),
  createField: (id: string, v: FieldValues) => call<AdminField>('POST', `/events/${id}/fields`, v),
  updateField: (id: string, fid: string, v: FieldValues) => call<AdminField>('PATCH', `/events/${id}/fields/${fid}`, v),
  deleteField: (id: string, fid: string) => call<void>('DELETE', `/events/${id}/fields/${fid}`),
  orderFields: (id: string, ids: string[]) => call<void>('PUT', `/events/${id}/fields/order`, { ids }),
};
