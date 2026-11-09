'use client';

import { TRIAL_SIZES } from '@bigtours/shared';
import { useEffect, useRef, useState } from 'react';

type Values = { agencyName: string; code: string; contactName: string; phone: string; email: string; expectedSize: string; note: string; consent: boolean; website: string };
type CodeHint = { tone: 'neutral' | 'ok' | 'bad'; text: string };

const LABELS: Record<string, string> = {
  agencyName: '請填寫旅行社名稱',
  code: '網址只能用小寫英文、數字與連字號，3 到 30 個字',
  contactName: '請填寫聯絡人姓名',
  phone: '請填寫正確的手機號碼',
  email: '請填寫正確的 Email',
  expectedSize: '請選擇預計活動人數',
  consent: '請勾選同意',
};
const CODE_REASONS: Record<string, string> = {
  format: '只能用小寫英文、數字與連字號，3 到 30 個字，頭尾不能是連字號',
  reserved: '這個網址保留給系統使用，請換一個',
  taken: '這個網址已經有人使用或申請，請換一個',
};
const DEFAULT_HINT: CodeHint = { tone: 'neutral', text: '小寫英文、數字與連字號；開通後不能更改' };

export function TrialForm({ domain }: { domain: string }) {
  const [v, setV] = useState<Values>({ agencyName: '', code: '', contactName: '', phone: '', email: '', expectedSize: TRIAL_SIZES[0], note: '', consent: false, website: '' });
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [hint, setHint] = useState<CodeHint>(DEFAULT_HINT);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = (key: keyof Values, value: string | boolean) => {
    setV((prev) => ({ ...prev, [key]: value }));
    if (invalid.has(key)) setInvalid((prev) => { const next = new Set(prev); next.delete(key); return next; });
  };

  // 網址即時檢查；送出時伺服器會再檢查一次
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!v.code) { setHint(DEFAULT_HINT); return; }
    const code = v.code;
    timer.current = setTimeout(() => {
      fetch(`/api/v1/site/code-check?code=${encodeURIComponent(code)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { available: boolean; reason?: string } | null) => {
          if (!d) return;
          setHint(d.available ? { tone: 'ok', text: `可以使用：${code}.${domain}` } : { tone: 'bad', text: CODE_REASONS[d.reason ?? 'format'] ?? CODE_REASONS.format! });
        })
        .catch(() => undefined);
    }, 350);
  }, [v.code, domain]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/v1/site/trial-applications', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) });
      if (res.ok) { setDone(true); return; }
      const data = await res.json().catch(() => null);
      if (data?.code === 'INVALID_INPUT' && Array.isArray(data.detail?.fields)) {
        setInvalid(new Set(data.detail.fields));
        setError('請修正標示的欄位後再送出。');
      } else if (data?.code === 'CODE_UNAVAILABLE') {
        setInvalid(new Set(['code']));
        setError('這個網址已經有人使用或申請，請換一個。');
      } else if (data?.code === 'TOO_MANY_REQUESTS') {
        setError('送出次數太多，請一小時後再試，或直接用 LINE 聯絡我們。');
      } else {
        setError('送出失敗，請稍後再試。');
      }
    } catch {
      setError('網路連線失敗，請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="form">
        <div className="done" role="status">
          <h3>已收到你的試用申請</h3>
          <p style={{ color: '#6b6b6b' }}>確認信已寄到 {v.email}。我們確認資料後會開通 {v.code}.{domain}，並用 Email 通知你登入方式。</p>
        </div>
      </div>
    );
  }

  const err = (name: string) => (invalid.has(name) ? <span className="field-error" id={`${name}-error`}>{LABELS[name]}</span> : null);
  const aria = (name: string) => (invalid.has(name) ? { 'aria-invalid': true as const, 'aria-describedby': `${name}-error` } : {});

  return (
    <form className="form" onSubmit={submit} noValidate>
      {error && <p className="form-error" role="alert">{error}</p>}
      <label className="full">旅行社名稱 <span className="req">*</span>
        <input type="text" name="agencyName" maxLength={100} required autoComplete="organization" value={v.agencyName} onChange={(e) => set('agencyName', e.target.value)} {...aria('agencyName')} />
        {err('agencyName')}
      </label>
      <label className="full">想要的網址 <span className="req">*</span>
        <span className="domain">
          <input type="text" name="code" maxLength={30} required placeholder="例如 abc-travel" autoCapitalize="off" spellCheck={false} value={v.code}
            onChange={(e) => set('code', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} {...aria('code')} />
          <span>.{domain}</span>
        </span>
        <span className={`hint ${hint.tone === 'neutral' ? '' : hint.tone}`} aria-live="polite">{hint.text}</span>
        {err('code')}
      </label>
      <label>聯絡人姓名 <span className="req">*</span>
        <input type="text" name="contactName" maxLength={100} required autoComplete="name" value={v.contactName} onChange={(e) => set('contactName', e.target.value)} {...aria('contactName')} />
        {err('contactName')}
      </label>
      <label>手機 <span className="req">*</span>
        <input type="tel" name="phone" maxLength={30} required autoComplete="tel" inputMode="tel" value={v.phone} onChange={(e) => set('phone', e.target.value)} {...aria('phone')} />
        {err('phone')}
      </label>
      <label className="full">Email <span className="req">*</span>
        <input type="email" name="email" maxLength={254} required autoComplete="email" value={v.email} onChange={(e) => set('email', e.target.value)} {...aria('email')} />
        {err('email')}
      </label>
      <label className="full">預計活動人數
        <select name="expectedSize" value={v.expectedSize} onChange={(e) => set('expectedSize', e.target.value)}>
          {TRIAL_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label className="full">想先了解的事（選填）
        <textarea name="note" rows={3} maxLength={1000} value={v.note} onChange={(e) => set('note', e.target.value)} />
      </label>
      <label className="hp" aria-hidden="true">網站<input type="text" name="website" tabIndex={-1} autoComplete="off" value={v.website} onChange={(e) => set('website', e.target.value)} /></label>
      <label className="full check">
        <input type="checkbox" name="consent" checked={v.consent} onChange={(e) => set('consent', e.target.checked)} {...aria('consent')} />
        <span>我同意 Bookdex 使用以上資料聯絡我，並處理試用開通事宜。</span>
      </label>
      {err('consent')}
      <button className="btn btn-dark btn-lg full" type="submit" disabled={busy}>{busy ? '送出中' : '送出試用申請'}</button>
    </form>
  );
}
