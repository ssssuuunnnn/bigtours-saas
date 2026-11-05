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
  options: { optionId: string; remaining: number; status: 'available' | 'held' | 'sold_out' }[];
}
export interface Option { id: string; groupId: string; name: string; price: number }
export interface OptionGroup { id: string; name: string; isRequired: boolean; minSelect: number; maxSelect: number; options: Option[] }
export interface TravelerType { id: string; name: string; basePrice: number; isEmployeeSelf: boolean }
export interface Field { key: string; label: string; type: string; choices: string[] | null; isRequired: boolean; isSensitive: boolean }
export interface Hold { id: string; sessionId: string; quantity: number; expiresAt: string }
export interface Traveler {
  key: string;
  travelerTypeId: string;
  optionIds: string[];
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
  subsidyApplied: number;
  selfPayAmount: number;
  paymentStatus: string;
  travelers: { name: string; travelerTypeName: string; basePrice: number; fieldValues: Record<string, any>; requestedRoomNo: number | null; options: { name: string; price: number }[] }[];
}
export interface EventState {
  agency: { name: string; primaryColor: string | null };
  event: { name: string; itinerary: { summary?: string; days?: { title: string; description: string }[] }; openState: 'not_open' | 'open' | 'closed'; registrationOpensAt: string | null; registrationClosesAt: string | null; allowDependentsOnly: boolean };
  employee: { name: string; subsidyAmount: number; dependentLimit: number };
  travelerTypes: TravelerType[];
  optionGroups: OptionGroup[];
  fields: Field[];
  availability: SessionAvailability[];
  hold: Hold | null;
  registration: Registration | null;
  draft: { travelers: Traveler[]; roomPreferences: RoomPreference[] } | null;
  serverTime: string;
}

export interface Landing {
  agency: { name: string; primaryColor: string | null };
  event: { slug: string; name: string; registrationOpensAt: string | null; registrationClosesAt: string | null; pageState: 'open' | 'not_open' | 'closed'; pageOpensAt: string | null };
}
export interface PasswordLink {
  agency: { name: string; primaryColor: string | null };
  event: { name: string };
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
    setPassword: (token: string, password: string) => call<{ employeeNo: string }>('POST', '/password-links/set', { token, password }),
    state: () => call<EventState>('GET', ''),
    availability: () => call<SessionAvailability[]>('GET', '/availability'),
    hold: (sessionId: string, travelers: unknown[]) => call<Hold>('POST', '/holds', { sessionId, travelers }),
    updateHold: (travelers: unknown[]) => call<Hold>('PATCH', '/holds/current', { travelers }),
    releaseHold: () => call<void>('DELETE', '/holds/current'),
    saveDraft: (body: unknown) => call<void>('PUT', '/draft', body),
    submit: (body: unknown) => call<Registration>('POST', '/registrations', body),
    requestCancel: () => call<Registration>('POST', '/registrations/current/cancel-request'),
  };
}
