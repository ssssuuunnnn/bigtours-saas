import { ApiError } from './api';

export interface AdminEventSummary { id: string; slug: string; name: string; status: string; companyName: string }
export interface AdminEvent { id: string; slug: string; name: string; tierMax: number; hasRegistrations: boolean }
export interface AdminMe { agencyName: string; user: { name: string; role: string } }
export interface SessionValues {
  name: string;
  departsOn: string;
  returnsOn: string;
  departureTime: string;
  returnArrivalTime: string;
  outboundFlightNo: string | null;
  returnFlightNo: string | null;
  capacity: number;
}
export interface AdminSession extends SessionValues { id: string; soldCount: number }
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
  events: () => call<AdminEventSummary[]>('GET', '/events'),
  event: (id: string) => call<AdminEvent>('GET', `/events/${id}`),
  sessions: (id: string) => call<AdminSession[]>('GET', `/events/${id}/sessions`),
  createSession: (id: string, v: SessionValues) => call<AdminSession>('POST', `/events/${id}/sessions`, v),
  updateSession: (id: string, sid: string, v: SessionValues) => call<AdminSession>('PATCH', `/events/${id}/sessions/${sid}`, v),
  deleteSession: (id: string, sid: string) => call<void>('DELETE', `/events/${id}/sessions/${sid}`),
  orderSessions: (id: string, ids: string[]) => call<void>('PUT', `/events/${id}/sessions/order`, { ids }),
  fields: (id: string) => call<AdminField[]>('GET', `/events/${id}/fields`),
  createField: (id: string, v: FieldValues) => call<AdminField>('POST', `/events/${id}/fields`, v),
  updateField: (id: string, fid: string, v: FieldValues) => call<AdminField>('PATCH', `/events/${id}/fields/${fid}`, v),
  deleteField: (id: string, fid: string) => call<void>('DELETE', `/events/${id}/fields/${fid}`),
  orderFields: (id: string, ids: string[]) => call<void>('PUT', `/events/${id}/fields/order`, { ids }),
};
