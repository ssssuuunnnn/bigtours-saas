import type { EventNavKey } from '@bigtours/shared';
import { ApiError } from './api';

export interface AdminEventSummary { id: string; slug: string; name: string; status: string; companyName: string; registrationOpensAt: string | null; registrationClosesAt: string | null; tierMax: number; travelerCount: number }
export interface AdminEvent {
  id: string; slug: string; name: string; tierMax: number; hasRegistrations: boolean; status: string; companyName: string;
  days: { title: string; description: string }[]; themeColor: string; supportPhone: string | null; supportHours: string | null;
  pageMode: 'manual' | 'scheduled'; pageIsOpen: boolean; pageOpensAt: string | null; pageClosesAt: string | null;
  registrationOpensAt: string | null; registrationClosesAt: string | null; paymentInstructions: string | null; retentionDays: number; termsFileName: string | null; termsVersion: number;
  images: { login: string | null; loginMobile: string | null; home: string | null };
  pageState: 'open' | 'not_open' | 'closed'; activeHolds: number;
}
export type AccountState = 'activated' | 'sending' | 'link_issued' | 'failed' | 'sent' | 'expired' | 'no_email' | 'none';
export interface EmployeeValues { employeeNo: string; name: string; email: string | null; department: string | null; subsidyAmount: number | null; dependentLimit: number | null }
export interface AdminEmployee extends EmployeeValues { id: string; accountState: AccountState; registered: boolean; activated: boolean }
export interface RosterPage {
  rows: AdminEmployee[]; total: number; page: number; pageSize: number; rosterTotal: number;
  summary: Record<AccountState, number>;
  defaults: { subsidyAmount: number; dependentLimit: number };
}
export interface ImportIssue { row: number; employeeNo: string; name: string; code: string; value?: string; firstRow?: number }
export interface ImportPreview { newCount: number; updateCount: number; errorCount: number; duplicateCount: number; issues: ImportIssue[]; issuesTruncated: boolean }
export interface PasswordLink { token: string; slug: string; expiresAt: string; notified: boolean; issuedBy: string }
export interface EventOverview {
  status: string; registrationOpensAt: string | null; registrationClosesAt: string | null; tierMax: number;
  roster: number; registered: number; pendingCancels: number; unpaid: number; travelers: number;
  sessions: { id: string; name: string; capacity: number; sold: number; held: number; remaining: number }[];
}
export interface RegistrationRow {
  id: string; employeeName: string; employeeNo: string; sessionName: string; travelerCount: number;
  totalAmount: number; subsidyAmount: number; selfPayAmount: number; paymentStatus: string; paymentDiff: number; status: string; submittedAt: string;
}
export interface RegistrationPage { rows: RegistrationRow[]; total: number; page: number; pageSize: number; registrations: number; travelers: number; sessions: { id: string; name: string }[] }
export type RevisionSummary =
  | { action: 'created' | 'cancel_requested' | 'cancel_confirmed' | 'cancel_rejected' }
  | { action: 'payment'; from: string; to: string }
  | { action: 'fee_adjusted'; from: number; to: number; reason: string }
  | { action: 'reassigned'; from: number; to: number; reason: string; changes: { traveler: string; from: string; to: string }[] };
export interface RegistrationDetail {
  id: string; employeeName: string; employeeNo: string; sessionName: string; status: string;
  totalAmount: number; subsidyAmount: number; subsidyApplied: number; selfPayAmount: number; paymentStatus: string; paidAmount: number | null; paymentDiff: number;
  submittedAt: string; cancelRequestedAt: string | null; cancelledAt: string | null; canViewSensitive: boolean;
  travelers: {
    id: string; name: string; typeName: string; isEmployeeSelf: boolean; basePrice: number; requestedRoomNo: number | null; fee: number;
    roomType: { name: string; surcharge: number } | null;
    fields: { key: string; label: string; value: string; sensitive: boolean }[];
    options: { name: string; price: number }[];
    preferences: { rank: number; optionName: string }[];
  }[];
  coworkers: { requestedRoomNo: number; name: string }[];
  revisions: { no: number; hasContent: boolean; at: string; actorName: string | null; actorType: string; summary: RevisionSummary }[];
}
export interface RoomTraveler { id: string; name: string; typeName: string; occupiesBed: boolean; employeeName: string; selectedRoom: string | null; roomTypeId: string | null }
export interface RoomView {
  id: string; label: string; note: string | null; roomTypeId: string | null; typeName: string | null; capacity: number; beds: number;
  status: 'ok' | 'over' | 'under' | 'empty'; travelers: RoomTraveler[]; mismatched: { name: string; selectedRoom: string | null }[]; wishes: string[];
}
export interface RoomSessionView {
  id: string; name: string; roomTypes: { id: string; name: string; capacity: number }[];
  rooms: RoomView[];
  unassigned: { key: string; employeeName: string; travelers: RoomTraveler[]; selectedRoom: string | null; wish: string | null }[];
  stats: { total: number; assigned: number; over: number; under: number; wishes: number };
  publication: { publishedAt: string; changes: { label: string; typeName: string | null; before: string[]; after: string[] }[] } | null;
  notifyCount: number;
}
export interface RoomOverview { sessions: { id: string; name: string }[]; session: RoomSessionView | null }
export interface RoomValues { label: string; roomTypeId: string | null; capacity?: number; note: string | null }
export interface EmailTemplateView {
  key: string; label: string; audience: 'employee' | 'agency'; placeholders: string[]; required: string[];
  defaultSubject: string; defaultBody: string; subject: string; body: string; senderName: string | null; customized: boolean;
}
export interface EmailOverview {
  notifyEmails: string[];
  templates: EmailTemplateView[];
  stats: { total: number; failed: number };
  failures: { id: string; templateKey: string; label: string; email: string; employeeName: string | null; employeeNo: string | null; isEmployee: boolean; reason: 'mailbox' | 'server'; at: string }[];
  reminder: { pending: number; noEmail: number; lastSentAt: string | null; sendable: boolean };
}
export interface EmailTemplateValues { senderName: string | null; subject: string; body: string }
export interface RevisionSnapshot {
  session: string;
  total: number;
  travelers: { id: string; name: string; type: string; basePrice: number; roomType: string | null; roomSurcharge: number; fields: { label: string; value: string }[]; options: { name: string; price: number }[]; preferences: string[] }[];
}
export interface EditableTraveler {
  id: string; travelerTypeId: string; roomTypeId: string | null; plainValues: Record<string, any>; masks: Record<string, string>; preferenceIds: Record<string, string[]>;
  name: string; basePrice: number; requestedRoomNo: number | null; roomType: { name: string; surcharge: number } | null; options: { optionId: string; name: string; price: number }[];
}
export interface RegistrationEditData {
  travelerTypes: { id: string; name: string; basePrice: number; isEmployeeSelf: boolean; occupiesBed: boolean }[];
  optionGroups: { id: string; name: string; minSelect: number; maxSelect: number; isRequired: boolean; preferenceCount: number; options: { id: string; name: string; price: number }[] }[];
  fields: { key: string; label: string; type: string; choices: string[] | null; isRequired: boolean; isSensitive: boolean }[];
  availability: { id: string; name: string; remaining: number; roomTypes: { id: string; name: string; capacity: number; surcharge: number; remaining: number }[] }[];
  registration: { id: string; sessionId: string; status: string; totalAmount: number; subsidyAmount: number; paymentStatus: string; roomPreferences: { requestedRoomNo: number; preferredCoworkerName: string | null; note: string | null }[]; travelers: EditableTraveler[] };
}
export interface ReassignSource { sessionId: string; sessionName: string; optionId: string; optionName: string; groupName: string; travelers: number }
export interface ReassignPlan {
  option: { id: string; name: string };
  targets: { id: string; name: string; price: number; remaining: number | null }[];
  travelers: { id: string; name: string; isEmployeeSelf: boolean; employeeName: string; employeeNo: string; currentPrice: number; preferences: string[]; excluded: string[]; suggested: string | null }[];
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
export interface AdminOption { id: string; name: string; price: number; pdfFileName: string | null; quotas: Record<string, { capacity: number; soldCount: number }> }
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

export type ImageKind = 'login' | 'login-mobile' | 'home';

/** 檔案以原始內容送出，不走 JSON。 */
async function upload<T>(path: string, file: File, contentType: string, method = 'PUT'): Promise<T> {
  const res = await fetch(`/api/v1/agency${path}`, { method, headers: { 'content-type': contentType }, body: file });
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
  uploadTerms: (id: string, file: File) => upload<{ termsFileName: string; termsVersion: number }>(`/events/${id}/terms?name=${encodeURIComponent(file.name)}`, file, 'application/pdf'),
  uploadImage: (id: string, kind: ImageKind, file: File) => upload<{ ok: boolean }>(`/events/${id}/images/${kind}`, file, file.type),
  deleteImage: (id: string, kind: ImageKind) => call<void>('DELETE', `/events/${id}/images/${kind}`),
  uploadOptionPdf: (id: string, oid: string, file: File) => upload<{ pdfFileName: string }>(`/events/${id}/options/${oid}/pdf?name=${encodeURIComponent(file.name)}`, file, 'application/pdf'),
  deleteOptionPdf: (id: string, oid: string) => call<void>('DELETE', `/events/${id}/options/${oid}/pdf`),
  copyEvent: (id: string, v: { companyId: string; name: string; slug: string; pricingTierId: string }) => call<{ id: string }>('POST', `/events/${id}/copy`, v),
  employees: (id: string, q: { search?: string; account?: string; registration?: string; page?: number }) => {
    const params = new URLSearchParams(Object.entries(q).flatMap(([k, v]) => (v ? [[k, String(v)]] : [])));
    return call<RosterPage>('GET', `/events/${id}/employees?${params}`);
  },
  createEmployee: (id: string, v: EmployeeValues) => call<{ id: string }>('POST', `/events/${id}/employees`, v),
  updateEmployee: (id: string, eid: string, v: EmployeeValues) => call<void>('PATCH', `/events/${id}/employees/${eid}`, v),
  removeEmployee: (id: string, eid: string) => call<void>('DELETE', `/events/${id}/employees/${eid}`),
  previewImport: (id: string, file: File) => upload<ImportPreview>(`/events/${id}/employees/import/preview`, file, 'text/csv', 'POST'),
  importEmployees: (id: string, file: File) => upload<{ created: number; updated: number; errorCount: number; duplicateCount: number }>(`/events/${id}/employees/import`, file, 'text/csv', 'POST'),
  rosterSources: (id: string) => call<{ id: string; name: string; employees: number }[]>('GET', `/events/${id}/employees/copy-sources`),
  copyRoster: (id: string, fromEventId: string) => call<{ added: number; skipped: number }>('POST', `/events/${id}/employees/copy`, { fromEventId }),
  sendAccountEmails: (id: string, body: { employeeIds: string[] } | { allPending: true }) => call<{ queued: number; skipped: number }>('POST', `/events/${id}/employees/account-emails`, body),
  passwordLink: (id: string, eid: string) => call<PasswordLink>('POST', `/events/${id}/employees/${eid}/password-link`, {}),
  overview: (id: string) => call<EventOverview>('GET', `/events/${id}/overview`),
  registrations: (id: string, q: { search?: string; session?: string; payment?: string; status?: string; page?: number }) => {
    const params = new URLSearchParams(Object.entries(q).flatMap(([k, v]) => (v ? [[k, String(v)]] : [])));
    return call<RegistrationPage>('GET', `/events/${id}/registrations?${params}`);
  },
  registration: (id: string, rid: string) => call<RegistrationDetail>('GET', `/events/${id}/registrations/${rid}`),
  revealSensitive: (id: string, rid: string) => call<Record<string, Record<string, unknown>>>('POST', `/events/${id}/registrations/${rid}/sensitive`, {}),
  rooms: (id: string, session?: string) => call<RoomOverview>('GET', `/events/${id}/rooms${session ? `?session=${session}` : ''}`),
  createRoom: (id: string, body: { sessionId: string; roomTypeId: string | null; capacity?: number; label?: string }) => call<{ id: string; label: string }>('POST', `/events/${id}/rooms`, body),
  updateRoom: (id: string, roomId: string, body: RoomValues) => call<void>('PATCH', `/events/${id}/rooms/${roomId}`, body),
  deleteRoom: (id: string, roomId: string) => call<void>('DELETE', `/events/${id}/rooms/${roomId}`),
  draftRooms: (id: string, sessionId: string) => call<{ created: number; placed: number }>('POST', `/events/${id}/rooms/draft`, { sessionId }),
  assignRoom: (id: string, sessionId: string, roomId: string | null, travelerIds: string[]) => call<void>('PUT', `/events/${id}/rooms/assignments`, { sessionId, roomId, travelerIds }),
  publishRooms: (id: string, sessionId: string) => call<{ notified: number }>('POST', `/events/${id}/rooms/publish`, { sessionId }),
  emails: (id: string) => call<EmailOverview>('GET', `/events/${id}/emails`),
  saveNotifyEmails: (id: string, emails: string[]) => call<void>('PUT', `/events/${id}/emails/notify-emails`, { emails }),
  saveEmailTemplate: (id: string, key: string, body: EmailTemplateValues) => call<void>('PUT', `/events/${id}/emails/templates/${key}`, body),
  resetEmailTemplate: (id: string, key: string) => call<void>('DELETE', `/events/${id}/emails/templates/${key}`),
  testEmailTemplate: (id: string, key: string, body: EmailTemplateValues) => call<{ to: string }>('POST', `/events/${id}/emails/templates/${key}/test`, body),
  sendDeadlineReminder: (id: string) => call<{ queued: number }>('POST', `/events/${id}/emails/deadline-reminder`, {}),
  resendEmail: (id: string, messageId: string, email?: string) => call<void>('POST', `/events/${id}/emails/messages/${messageId}/resend`, email ? { email } : {}),
  registrationEdit: (id: string, rid: string) => call<RegistrationEditData>('GET', `/events/${id}/registrations/${rid}/edit`),
  modifyRegistration: (id: string, rid: string, body: unknown) => call<void>('PUT', `/events/${id}/registrations/${rid}`, body),
  registrationRevision: (id: string, rid: string, no: number) => call<{ before: RevisionSnapshot; after: RevisionSnapshot }>('GET', `/events/${id}/registrations/${rid}/revisions/${no}`),
  setPayment: (id: string, rid: string, status: string) => call<void>('PUT', `/events/${id}/registrations/${rid}/payment`, { status }),
  adjustFee: (id: string, rid: string, totalAmount: number, reason: string) => call<void>('PUT', `/events/${id}/registrations/${rid}/fee`, { totalAmount, reason }),
  confirmCancel: (id: string, rid: string) => call<void>('POST', `/events/${id}/registrations/${rid}/cancel/confirm`, {}),
  rejectCancel: (id: string, rid: string) => call<void>('POST', `/events/${id}/registrations/${rid}/cancel/reject`, {}),
  reassignSources: (id: string) => call<ReassignSource[]>('GET', `/events/${id}/reassign/sources`),
  reassignPlan: (id: string, sessionId: string, optionId: string) => call<ReassignPlan>('GET', `/events/${id}/reassign/plan?sessionId=${sessionId}&optionId=${optionId}`),
  reassign: (id: string, body: { sessionId: string; optionId: string; reason: string; assignments: { travelerId: string; toOptionId: string }[] }) => call<{ moved: number; registrations: number }>('POST', `/events/${id}/reassign`, body),
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
