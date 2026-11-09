import type { EventNavKey } from '@bigtours/shared';
import { agencyApi, currentAgency } from './agency-path';
import { ApiError } from './api';

export interface AdminEventSummary { id: string; slug: string; name: string; status: string; companyName: string; registrationOpensAt: string | null; registrationClosesAt: string | null; tierMax: number; travelerCount: number }
export interface AdminEvent {
  id: string; slug: string; name: string; tierMax: number; hasRegistrations: boolean; status: string; companyName: string;
  days: { title: string; description: string }[]; themeColor: string; supportPhone: string | null; supportHours: string | null;
  pageMode: 'manual' | 'scheduled'; pageIsOpen: boolean; pageOpensAt: string | null; pageClosesAt: string | null;
  registrationOpensAt: string | null; registrationClosesAt: string | null; paymentInstructions: string | null; retentionDays: number; termsFileName: string | null; termsVersion: number;
  images: { login: string | null; loginMobile: string | null; home: string | null };
  pageState: 'open' | 'not_open' | 'closed'; activeHolds: number; heldTravelers: number;
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
export interface ExportColumn { key: string; label: string; sensitive: boolean }
export interface ExportTemplate { id: string; name: string; scope: 'travelers' | 'registrations'; columns: string[]; builtin: boolean }
export interface ExportJob { id: string; name: string; sessionName: string | null; scope: string; status: 'pending' | 'running' | 'completed' | 'failed'; rowCount: number | null; containsSensitive: boolean; createdAt: string; expiresAt: string | null; createdByName: string | null }
export interface ExportOverview {
  catalog: { travelers: ExportColumn[]; registrations: ExportColumn[] };
  canExportSensitive: boolean;
  sessions: { id: string; name: string }[];
  templates: ExportTemplate[];
  jobs: ExportJob[];
}
export interface DataLogRow {
  id: string; at: string; action: string; actorName: string | null; eventName: string | null; employeeName: string | null; employeeNo: string | null;
  travelerCount: number | null; name: string | null; sessionName: string | null; rows: number | null; fields: string[];
}
export interface DataLogPage { rows: DataLogRow[]; hasMore: boolean; events: { id: string; name: string }[]; actors: { id: string; name: string }[] }
export interface StaffMember { id: string; name: string; email: string; role: string; status: 'active' | 'disabled'; activated: boolean; lastLoginAt: string | null; isSelf: boolean }
export interface AgencySettings { name: string; code: string; logoUrl: string | null }
export interface TierOption { id: string; minTravelers: number; maxTravelers: number; price: number; remaining: number }
export interface TierOptions { current: TierOption; options: TierOption[]; recommendedId: string | null; contractExpired: boolean }
export interface CompanyContact { id: string; name: string; email: string; status: 'active' | 'disabled'; activated: boolean }
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
export interface AdminCompany { id: string; name: string; eventCount: number; logoUrl: string | null }
export interface TrialStatus {
  endsOn: string;
  expired: boolean;
  daysLeft: number;
  deletesOn: string;
  mail: { total: number; today: number; totalLimit: number; dailyLimit: number };
  limits: { events: number; maxTravelers: number };
}
export interface AdminMe { agencyName: string; user: { name: string; role: string }; pinnedNavItems: EventNavKey[]; trial: TrialStatus | null }
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

const clientFor = (base: string | (() => string)) => {
  const prefixOf = () => (typeof base === 'string' ? base : base());
  const call: Call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${prefixOf()}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.code ?? 'fallback', data?.detail);
  return data as T;
  };
  /** 檔案以原始內容送出，不走 JSON。 */
  const upload: Upload = async <T,>(path: string, file: File, contentType: string, method = 'PUT'): Promise<T> => {
  const res = await fetch(`${prefixOf()}${path}`, { method, headers: { 'content-type': contentType }, body: file });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.code ?? 'fallback', data?.detail);
  return data as T;
  };
  return { call, upload };
};
const { call, upload } = clientFor(() => agencyApi(currentAgency(), '/agency'));

export type ImageKind = 'login' | 'login-mobile' | 'home';


type Call = <T>(method: string, path: string, body?: unknown) => Promise<T>;
type Upload = <T>(path: string, file: File, contentType: string, method?: string) => Promise<T>;

/** 旅行社和企業窗口的員工名單操作相同，只有網址前綴不同。 */
const rosterMethods = (call: Call, upload: Upload) => ({
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
});
export type RosterApi = ReturnType<typeof rosterMethods>;

export const adminApi = {
  login: (email: string, password: string) => call<void>('POST', '/session', { email, password }),
  logout: () => call<void>('DELETE', '/session'),
  me: () => call<AdminMe>('GET', '/me'),
  setPinnedNav: (items: EventNavKey[]) => call<void>('PUT', '/me/pinned-nav', { items }),
  events: () => call<AdminEventSummary[]>('GET', '/events'),
  event: (id: string) => call<AdminEvent>('GET', `/events/${id}`),
  quota: () => call<QuotaTier[]>('GET', '/quota'),
  companies: () => call<AdminCompany[]>('GET', '/companies'),
  renameCompany: (id: string, name: string) => call<void>('PATCH', `/companies/${id}`, { name }),
  uploadCompanyLogo: (id: string, file: File) => upload<void>(`/companies/${id}/logo`, file, file.type),
  removeCompanyLogo: (id: string) => call<void>('DELETE', `/companies/${id}/logo`),
  createCompany: (name: string) => call<AdminCompany>('POST', '/companies', { name }),
  staff: () => call<StaffMember[]>('GET', '/staff'),
  createStaff: (v: { name: string; email: string; role: string }) => call<{ id: string }>('POST', '/staff', v),
  sendStaffLink: (id: string) => call<void>('POST', `/staff/${id}/link`, {}),
  setStaffRole: (id: string, role: string) => call<void>('PATCH', `/staff/${id}/role`, { role }),
  setStaffStatus: (id: string, status: 'active' | 'disabled') => call<void>('PATCH', `/staff/${id}/status`, { status }),
  staffLink: (token: string) => call<{ name: string; agencyName: string }>('GET', `/password-links/${encodeURIComponent(token)}`),
  staffSetPassword: (token: string, password: string) => call<void>('POST', `/password-links/${encodeURIComponent(token)}`, { password }),
  settings: () => call<AgencySettings>('GET', '/settings'),
  saveAgencyName: (name: string) => call<void>('PUT', '/settings/name', { name }),
  uploadLogo: (file: File) => upload<{ ok: boolean }>('/settings/logo', file, file.type),
  removeLogo: () => call<void>('DELETE', '/settings/logo'),
  branding: () => call<{ name: string; logoUrl: string | null }>('GET', '/branding'),
  companyContacts: (companyId: string) => call<CompanyContact[]>('GET', `/companies/${companyId}/contacts`),
  createContact: (companyId: string, v: { name: string; email: string }) => call<{ id: string }>('POST', `/companies/${companyId}/contacts`, v),
  sendContactLink: (companyId: string, id: string) => call<void>('POST', `/companies/${companyId}/contacts/${id}/link`, {}),
  setContactStatus: (companyId: string, id: string, status: 'active' | 'disabled') => call<void>('PATCH', `/companies/${companyId}/contacts/${id}`, { status }),
  createEvent: (v: { companyId: string; name: string; slug: string; pricingTierId: string }) => call<{ id: string }>('POST', '/events', v),
  tierOptions: (id: string, needed: number) => call<TierOptions>('GET', `/events/${id}/tier-options?needed=${needed}`),
  upgradeTier: (id: string, tierId: string) => call<void>('POST', `/events/${id}/tier-upgrade`, { tierId }),
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
  ...rosterMethods(call, upload),
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
  exports: (id: string) => call<ExportOverview>('GET', `/events/${id}/exports`),
  createExport: (id: string, body: { name: string; scope: string; sessionId: string | null; columns: string[] }) => call<{ id: string }>('POST', `/events/${id}/exports`, body),
  saveExportTemplate: (id: string, body: { name: string; scope: string; columns: string[] }) => call<{ id: string }>('POST', `/events/${id}/export-templates`, body),
  deleteExportTemplate: (id: string, templateId: string) => call<void>('DELETE', `/events/${id}/export-templates/${templateId}`),
  dataLog: (query: string) => call<DataLogPage>('GET', `/data-log?${query}`),
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

// ===== 企業窗口 =====

export interface ContactMe { agencyName: string; companyName: string; user: { name: string; email: string }; trialExpired: boolean }
export interface ContactEvent {
  id: string; name: string; state: 'draft' | 'not_open' | 'open' | 'closed'; registrationOpensAt: string | null; registrationClosesAt: string | null;
  roster: number; registered: number; sessionCount: number; firstDay: string | null; lastDay: string | null;
}
export interface ContactOverview extends ContactEvent {
  accountsPending: number; subsidyTotal: number;
  sessions: { id: string; name: string; departsOn: string | null; returnsOn: string | null; travelers: number }[];
}
export interface ContactRegistrationRow { id: string; employeeName: string; employeeNo: string; sessionName: string; travelerCount: number; totalAmount: number; subsidyAmount: number; selfPayAmount: number; paymentStatus: string; status: string }
export interface ContactRegistrationPage { rows: ContactRegistrationRow[]; total: number; page: number; pageSize: number; registrations: number; travelers: number; sessions: { id: string; name: string }[] }
export interface ContactRegistration {
  id: string; employeeName: string; employeeNo: string; sessionName: string; status: string; totalAmount: number; subsidyApplied: number; selfPayAmount: number; paymentStatus: string;
  cancelRequestedAt: string | null; cancelledAt: string | null;
  travelers: { id: string; name: string; typeName: string; roomTypeName: string | null; options: string[]; fee: number }[];
}

const contact = clientFor(() => agencyApi(currentAgency(), '/company'));
export const contactApi = {
  me: () => contact.call<ContactMe>('GET', '/me'),
  logout: () => contact.call<void>('DELETE', '/session'),
  events: () => contact.call<ContactEvent[]>('GET', '/events'),
  overview: (id: string) => contact.call<ContactOverview>('GET', `/events/${id}/overview`),
  registrations: (id: string, q: { search?: string; session?: string; payment?: string; page?: number }) => {
    const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v).map(([k, v]) => [k, String(v)]));
    return contact.call<ContactRegistrationPage>('GET', `/events/${id}/registrations?${params}`);
  },
  registration: (id: string, rid: string) => contact.call<ContactRegistration>('GET', `/events/${id}/registrations/${rid}`),
  lookupLink: (token: string) => contact.call<{ name: string; companyName: string; agencyName: string }>('GET', `/password-links/${encodeURIComponent(token)}`),
  setPassword: (token: string, password: string) => contact.call<void>('POST', `/password-links/${encodeURIComponent(token)}`, { password }),
  ...rosterMethods(contact.call, contact.upload),
};
export const feeReportUrl = (agency: string, id: string) => agencyApi(agency, `/company/events/${id}/fee-report`);

// ===== 平台後台 =====

export interface PlatformTier { id: string; minTravelers: number; maxTravelers: number; price: number }
export type AgencyState = 'active' | 'expiring' | 'expired' | 'admin_pending' | 'suspended';
export interface PlatformAgencyRow { id: string; name: string; code: string; isTrial: boolean; contractStartsOn: string | null; contractEndsOn: string | null; state: AgencyState; opened: number; used: number; remaining: number }
export interface PlatformAgency {
  id: string; name: string; code: string; state: AgencyState; suspended: boolean; isTrial: boolean; taxId: string | null; planNote: string | null; contractStartsOn: string | null; contractEndsOn: string | null;
  admin: { id: string; name: string; email: string; activated: boolean } | null;
  quota: (PlatformTier & { opened: number; used: number; remaining: number })[];
  ledger: { id: string; at: string; by: string | null; change: number; note: string | null; minTravelers: number; maxTravelers: number }[];
}
export interface PlatformUsage {
  events: { id: string; name: string; slug: string; agencyId: string; agencyName: string; people: number; limit: number; full: boolean; percent: number }[];
  followUps: { agencyId: string; agencyName: string; kind: 'contract_expired' | 'contract_expiring' | 'quota_empty' | 'admin_pending'; date?: string | null; days?: number }[];
}
export interface ContractValues { planNote: string; contractStartsOn: string; contractEndsOn: string }
const plat = clientFor('/api/v1/platform');
export const platformApi = {
  login: (email: string, password: string) => plat.call<void>('POST', '/session', { email, password }),
  logout: () => plat.call<void>('DELETE', '/session'),
  me: () => plat.call<{ user: { id: string; name: string }; domain: string }>('GET', '/me'),
  tiers: () => plat.call<PlatformTier[]>('GET', '/tiers'),
  agencies: (search: string) => plat.call<PlatformAgencyRow[]>('GET', `/agencies?search=${encodeURIComponent(search)}`),
  agency: (id: string) => plat.call<PlatformAgency>('GET', `/agencies/${id}`),
  create: (v: ContractValues & { name: string; code: string; adminName: string; adminEmail: string }) => plat.call<{ id: string; mailFailed: boolean }>('POST', '/agencies', v),
  updateContract: (id: string, v: ContractValues) => plat.call<void>('PATCH', `/agencies/${id}/contract`, v),
  adjustQuota: (id: string, v: { tierId: string; change: number; note: string }) => plat.call<void>('POST', `/agencies/${id}/quota`, v),
  setStatus: (id: string, status: 'active' | 'suspended') => plat.call<void>('PATCH', `/agencies/${id}/status`, { status }),
  sendAdminLink: (id: string) => plat.call<void>('POST', `/agencies/${id}/admin-link`, {}),
  usage: () => plat.call<PlatformUsage>('GET', '/usage'),
  trialApplications: (status: string) => plat.call<TrialApplication[]>('GET', `/trial-applications${status ? `?status=${status}` : ''}`),
  setTrialStatus: (id: string, status: 'pending' | 'rejected') => plat.call<void>('PATCH', `/trial-applications/${id}`, { status }),
  approveTrial: (id: string) => plat.call<{ agencyId: string; mailFailed: boolean }>('POST', `/trial-applications/${id}/approve`, {}),
  convertTrial: (id: string) => plat.call<void>('POST', `/agencies/${id}/convert-trial`, {}),
  settings: () => plat.call<{ trialAutoApprove: boolean }>('GET', '/settings'),
  saveSettings: (v: { trialAutoApprove: boolean }) => plat.call<void>('PUT', '/settings', v),
};

export interface TrialApplication {
  id: string;
  agencyName: string;
  code: string;
  taxId: string | null;
  contactName: string;
  phone: string;
  email: string;
  expectedSize: string;
  note: string | null;
  status: 'unverified' | 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
  verifiedAt: string | null;
  agencyId: string | null;
  handledAt: string | null;
  handledByName: string | null;
  codeTaken: boolean;
}
