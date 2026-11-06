/** 系統預設範本。信中不放身分證、護照等敏感資料，所以也沒有對應的欄位可以插入。 */
const COMMON = ['活動名稱', '旅行社名稱', '報名網站連結'];
const EMPLOYEE = ['員工姓名', ...COMMON];

export interface TemplateDefinition {
  key: string;
  label: string;
  audience: 'employee' | 'agency';
  subject: string;
  body: string;
  placeholders: string[];
  /** 少了就失去這封信的用途，不能刪掉。 */
  required: string[];
}

export const EMAIL_TEMPLATES: TemplateDefinition[] = [
  {
    key: 'account', label: '帳號信', audience: 'employee',
    subject: '【[活動名稱]】請設定報名網站密碼',
    body: '[員工姓名] 您好：\n\n「[活動名稱]」已開放帳號設定，請點下方連結設定密碼，之後以員工編號與這組密碼登入報名網站。\n\n[設定密碼連結]\n\n這個連結 14 天內有效，只能使用一次。如果您不需要報名，可以忽略這封信。',
    placeholders: [...EMPLOYEE, '設定密碼連結'], required: ['設定密碼連結'],
  },
  {
    key: 'link_notice', label: '已產生設定密碼連結', audience: 'employee',
    subject: '【[活動名稱]】設定密碼連結已產生',
    body: '[員工姓名] 您好：\n\n有人為您產生了「[活動名稱]」的設定密碼連結，連結會由承辦人員另外提供給您，這封信不含連結。\n\n如果您不知道這件事，請聯繫公司的活動窗口。',
    placeholders: EMPLOYEE, required: [],
  },
  {
    key: 'registration_success', label: '報名成功通知', audience: 'employee',
    subject: '【[活動名稱]】報名成功',
    body: '[員工姓名] 您好：\n\n您已完成「[活動名稱]」的報名。\n\n梯次：[梯次]，旅客 [旅客人數] 位。整筆費用 [整筆費用]，企業補助 [補助金額]，您需自付 [自付金額]。\n\n[付款說明]\n\n報名明細請見：\n\n[報名網站連結]',
    placeholders: [...EMPLOYEE, '梯次', '旅客人數', '整筆費用', '補助金額', '自付金額', '付款說明'], required: [],
  },
  {
    key: 'modified', label: '修改報名通知', audience: 'employee',
    subject: '【[活動名稱]】您的報名內容已修改',
    body: '[員工姓名] 您好：\n\n[修改說明]\n\n修改後整筆費用 [整筆費用]，您需自付 [自付金額]。已付款的差額由旅行社處理。\n\n完整內容請登入報名網站查看：\n\n[報名網站連結]',
    placeholders: [...EMPLOYEE, '修改說明', '整筆費用', '自付金額'], required: [],
  },
  {
    key: 'cancel_confirmed', label: '取消申請結果：已生效', audience: 'employee',
    subject: '【[活動名稱]】您的報名已取消',
    body: '[員工姓名] 您好：\n\n您申請取消「[活動名稱]」的報名已生效，名額已釋出。退費請依合約由旅行社處理。\n\n如果還想參加，可以登入重新報名，但名額以當下剩餘為準：\n\n[報名網站連結]',
    placeholders: EMPLOYEE, required: [],
  },
  {
    key: 'cancel_rejected', label: '取消申請結果：已退回', audience: 'employee',
    subject: '【[活動名稱]】您的取消申請未通過',
    body: '[員工姓名] 您好：\n\n旅行社退回了您取消「[活動名稱]」報名的申請，您的報名仍然有效。如有疑問，請聯繫活動的服務人員。\n\n[報名網站連結]',
    placeholders: EMPLOYEE, required: [],
  },
  {
    key: 'deadline_reminder', label: '截止前提醒', audience: 'employee',
    subject: '【[活動名稱]】報名即將截止',
    body: '[員工姓名] 您好：\n\n「[活動名稱]」的報名將於 [截止時間] 截止，您還沒有完成報名。如果要參加，請在截止前登入報名：\n\n[報名網站連結]',
    placeholders: [...EMPLOYEE, '截止時間'], required: [],
  },
  {
    key: 'reassigned', label: '行程改派通知', audience: 'employee',
    subject: '【[活動名稱]】您的自選行程已改派',
    body: '[員工姓名] 您好：\n\n因為「[改派原因]」，旅行社調整了以下旅客的自選行程：\n\n[改派內容]\n\n調整後整筆費用 [整筆費用]，您需自付 [自付金額]。已付款的差額由旅行社處理。\n\n如果不滿意改派結果，報名截止前可以登入修改，截止後請聯繫旅行社：\n\n[報名網站連結]',
    placeholders: [...EMPLOYEE, '改派原因', '改派內容', '整筆費用', '自付金額'], required: [],
  },
  {
    key: 'agency_cancel_requested', label: '新的取消申請（寄給旅行社）', audience: 'agency',
    subject: '【[活動名稱]】有新的取消申請',
    body: '[員工姓名]（[員工編號]）申請取消「[活動名稱]」[梯次] 的報名，請到後台處理：\n\n[後台連結]',
    placeholders: ['員工姓名', '員工編號', '活動名稱', '旅行社名稱', '梯次', '後台連結'], required: [],
  },
  {
    key: 'agency_modified', label: '員工修改報名（寄給旅行社）', audience: 'agency',
    subject: '【[活動名稱]】員工修改了報名',
    body: '[員工姓名]（[員工編號]）修改了「[活動名稱]」的報名，整筆費用 [原費用] → [整筆費用]。已付款的差額請另外處理。\n\n[後台連結]',
    placeholders: ['員工姓名', '員工編號', '活動名稱', '旅行社名稱', '原費用', '整筆費用', '後台連結'], required: [],
  },
];

export const templateDefinition = (key: string) => EMAIL_TEMPLATES.find((t) => t.key === key);

/** 回傳不認得的方括號文字與少掉的必要欄位。 */
export function checkTemplate(def: TemplateDefinition, subject: string, body: string) {
  const text = `${subject}\n${body}`;
  const used = [...text.matchAll(/\[([^\[\]\n]{1,30})\]/g)].map((m) => m[1]!);
  return {
    unknown: [...new Set(used.filter((x) => !def.placeholders.includes(x)))],
    missing: def.required.filter((x) => !used.includes(x)),
  };
}

export const fill = (text: string, values: Record<string, string>) => text.replace(/\[([^\[\]\n]{1,30})\]/g, (whole, name: string) => values[name] ?? whole);
