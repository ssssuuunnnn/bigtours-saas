export class ApiError extends Error {
  constructor(public status: number, public code: string, public detail: any) {
    super(code);
  }
}

export interface SessionAvailability {
  id: string;
  name: string;
  departsOn: string | null;
  returnsOn: string | null;
  outboundFlightNo: string | null;
  returnFlightNo: string | null;
  departureTime: string | null;
  returnArrivalTime: string | null;
  remaining: number;
  status: 'available' | 'held' | 'sold_out';
  /** shared：這組名額與其他梯次共用。 */
  options: { optionId: string; remaining: number; status: 'available' | 'held' | 'sold_out'; shared: boolean }[];
  roomTypes: RoomTypeChoice[];
  /** 梯次另外設定的每日行程；null 表示沿用活動預設。 */
  itineraryDays: { title: string; description: string }[] | null;
}
export interface RoomTypeChoice { id: string; name: string; capacity: number; surcharge: number; remaining: number; status: 'available' | 'held' | 'sold_out' }
export interface Option { id: string; groupId: string; name: string; price: number; hasPdf: boolean }
export interface EventFrontImages { login: string | null; loginMobile: string | null; home: string | null }
export interface OptionGroup { id: string; name: string; isRequired: boolean; minSelect: number; maxSelect: number; preferenceCount: number; activityDate: string | null; options: Option[] }
export interface TravelerType { id: string; name: string; basePrice: number; isEmployeeSelf: boolean; note: string | null; occupiesBed: boolean }
export interface Field { key: string; label: string; type: string; choices: string[] | null; isRequired: boolean; isSensitive: boolean }
export interface Hold { id: string; sessionId: string; quantity: number; expiresAt: string; modifying: boolean }
export interface Traveler {
  key: string;
  travelerTypeId: string;
  optionIds: string[];
  roomTypeId: string | null;
  preferences: Record<string, string[]>;
  name: string;
  fieldValues: Record<string, any>;
  requestedRoomNo: number | null;
  masks?: Record<string, string>;
}
export interface RoomPreference { requestedRoomNo: number; preferredCoworkerName: string | null; note: string | null }
export interface Registration {
  id: string;
  sessionId: string;
  status: string;
  totalAmount: number;
  subsidyAmount: number;
  subsidyApplied: number;
  selfPayAmount: number;
  paymentStatus: string;
  roomPreferences: RoomPreference[];
  finalRooms: { label: string; typeName: string | null; names: string[] }[] | null;
  travelers: { id: string; travelerTypeId: string; roomTypeId: string | null; plainValues: Record<string, any>; masks: Record<string, string>; preferenceIds: Record<string, string[]>; name: string; travelerTypeName: string; basePrice: number; fieldValues: Record<string, any>; requestedRoomNo: number | null; roomType: { name: string; surcharge: number } | null; preferences: { rank: number; groupName: string; optionName: string }[]; options: { optionId: string; name: string; hasPdf: boolean; price: number }[] }[];
}
export interface EventState {
  agency: { name: string };
  company: { name: string; logoUrl: string | null };
  serviceContacts: { name: string; phone: string; scope: string }[];
  event: { slug: string; name: string; hasTerms: boolean; paymentInstructions: string | null; images: EventFrontImages; themeColor: string; itinerary: { summary?: string; days?: { title: string; description: string }[] }; openState: 'not_open' | 'open' | 'closed'; registrationOpensAt: string | null; registrationClosesAt: string | null; allowDependentsOnly: boolean };
  employee: { name: string; subsidyAmount: number; dependentLimit: number };
  travelerTypes: TravelerType[];
  optionGroups: OptionGroup[];
  fields: Field[];
  availability: SessionAvailability[];
  hold: Hold | null;
  registration: Registration | null;
  draft: { travelers: Traveler[]; roomPreferences: RoomPreference[] } | null;
  modificationSessionId: string | null;
  serverTime: string;
}

export interface Landing {
  agency: { name: string };
  event: { slug: string; name: string; themeColor: string; registrationOpensAt: string | null; registrationClosesAt: string | null; pageState: 'open' | 'not_open' | 'closed'; pageOpensAt: string | null; images: EventFrontImages; };
}
export interface PasswordLink {
  agency: { name: string };
  event: { name: string; themeColor: string };
  employee: { name: string };
}

export function createClient(slug: string) {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`/api/v1/public/events/${encodeURIComponent(slug)}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data?.code ?? 'fallback', data?.detail);
    return data as T;
  };
  return {
    landing: () => call<Landing>('GET', '/landing'),
    login: (employeeNo: string, password: string) => call<void>('POST', '/session', { employeeNo, password }),
    logout: () => call<void>('DELETE', '/session'),
    lookupPasswordLink: (token: string) => call<PasswordLink>('POST', '/password-links/lookup', { token }),
    setPassword: (token: string, password: string) => call<{ employeeNo: string; lineUrl: string | null }>('POST', '/password-links/set', { token, password }),
    lineLogin: (idToken: string) => call<void>('POST', '/line-session', { idToken }),
    lineBind: (idToken: string, employeeNo: string, password: string) => call<void>('POST', '/line-binding', { idToken, employeeNo, password }),
    lineStatus: () => call<{ available: boolean; bound: boolean; boundAt: string | null }>('GET', '/line-binding'),
    lineUnbind: () => call<void>('DELETE', '/line-binding'),
    state: () => call<EventState>('GET', ''),
    availability: () => call<SessionAvailability[]>('GET', '/availability'),
    hold: (sessionId: string, travelers: unknown[]) => call<Hold>('POST', '/holds', { sessionId, travelers }),
    updateHold: (travelers: unknown[]) => call<Hold>('PATCH', '/holds/current', { travelers }),
    releaseHold: () => call<void>('DELETE', '/holds/current'),
    saveDraft: (body: unknown) => call<void>('PUT', '/draft', body),
    submit: (body: unknown) => call<Registration>('POST', '/registrations', body),
    modificationHold: (sessionId: string, travelers: unknown[]) => call<Hold>('POST', '/registrations/current/modification-hold', { sessionId, travelers }),
    submitModification: (body: unknown) => call<Registration>('PUT', '/registrations/current', body),
    requestCancel: () => call<Registration>('POST', '/registrations/current/cancel-request'),
  };
}

/** LINE 登入：旅行社層級，不屬於單一活動。 */
export const lineApi = {
  async config(): Promise<{ liffId: string; agencyName: string }> {
    const res = await fetch('/api/v1/public/line/config');
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data?.code ?? 'fallback', data?.detail);
    return data;
  },
  async events(idToken: string): Promise<{ slug: string; name: string; companyName: string }[]> {
    const res = await fetch('/api/v1/public/line/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data?.code ?? 'fallback', data?.detail);
    return data;
  },
};
