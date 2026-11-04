export class AdminError extends Error {
  constructor(public status: number, public code: string, public detail: any) {
    super(code);
  }
}

export async function adminFetch<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1/admin${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.location.href = '/admin/login';
    throw new AdminError(401, 'UNAUTHORIZED', null);
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new AdminError(res.status, data?.code ?? 'fallback', data?.detail);
  return data as T;
}

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: '帳號或密碼不正確。',
  ACCOUNT_LOCKED: '登入失敗太多次，帳號已暫時鎖定，請 15 分鐘後再試。',
  QUOTA_EXHAUSTED: '這個級距的活動額度已用完，請聯繫平台開通。',
  DUPLICATE: '這個代碼或編號已經存在，請改用其他值。',
  IN_USE: '已有報名或保留資料使用這筆設定，無法變更或刪除。',
  CONSTRAINT_VIOLATION: '名額不能低於已售數量，且數值必須符合規則。',
  CANNOT_DELETE: '活動已開放報名或已有報名資料，無法刪除。',
  INVALID_INPUT: '有欄位格式不正確，請檢查後再試。',
  NOT_CANCELLABLE: '這筆報名目前不在待確認取消的狀態。',
  NOT_FOUND: '找不到這筆資料，請重新整理頁面。',
  FORBIDDEN: '沒有權限執行這個操作。',
};

const PUBLISH_PROBLEMS: Record<string, string> = {
  sessions: '至少建立一個梯次',
  traveler_types: '至少建立一個旅客類型',
  self_type: '建立「員工本人」旅客類型，或開放只有眷屬參加',
  registration_period: '設定報名開始與截止時間',
  capacity: '梯次總名額不可超過所購級距',
};

export function errorMessage(e: unknown): string {
  if (!(e instanceof AdminError)) return '操作失敗，請再試一次。';
  if (e.code === 'CAPACITY_EXCEEDS_TIER') return `梯次總名額 ${e.detail?.total} 超過所購級距上限 ${e.detail?.maxTravelers} 人。`;
  if (e.code === 'NOT_PUBLISHABLE') return `發布前請先：${(e.detail?.problems ?? []).map((p: string) => PUBLISH_PROBLEMS[p] ?? p).join('、')}。`;
  if (e.code === 'INVALID_INPUT' && e.detail?.reason === 'not_xlsx') return '檔案不是 Excel（.xlsx）格式。';
  if (e.code === 'INVALID_INPUT' && e.detail?.reason === 'missing_columns') return `檔案缺少欄位：${e.detail.columns.join('、')}。`;
  if (e.code === 'INVALID_INPUT' && e.detail?.reason === 'too_many_rows') return '單次最多匯入 5,000 位員工。';
  return MESSAGES[e.code] ?? '操作失敗，請再試一次。';
}

export const money = (n: number) => `$${n.toLocaleString('en-US')}`;
