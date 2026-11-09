'use client';

import { isValidPassword, TRIAL_LIMITS } from '@bigtours/shared';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { agencyApi } from '../../../lib/agency-path';

type Info =
  | { state: 'ready'; mode: 'auto' | 'manual'; agencyName: string; code: string; email: string; contactName: string }
  | { state: 'pending' }
  | { state: 'activated'; code: string };

const PASSWORD_RULE = '至少 8 個字元，需同時包含英文與數字';

/** 試用申請的 Email 驗證連結：設定密碼即開通並登入後台（關閉自動開通時改為等待審核）。 */
export function ActivateTrial() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<Info | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = `/api/v1/site/activation/${encodeURIComponent(token)}`;

  useEffect(() => {
    fetch(url).then(async (r) => (r.ok ? setInfo(await r.json()) : setInvalid(true))).catch(() => setInvalid(true));
  }, [url]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!info || info.state !== 'ready') return;
    const auto = info.mode === 'auto';
    if (auto && !isValidPassword(password)) { setError(PASSWORD_RULE); return; }
    if (auto && password !== confirm) { setError('兩次輸入的密碼不一樣'); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(auto ? { password } : {}) });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (data?.code === 'LINK_INVALID') setInvalid(true);
        else if (data?.code === 'CODE_UNAVAILABLE') setError('這個網址已經被使用，請重新申請並換一個網址。');
        else if (data?.code === 'INVALID_PASSWORD') setError(PASSWORD_RULE);
        else if (data?.code === 'TOO_MANY_REQUESTS') setError('嘗試次數太多，請 10 分鐘後再試。');
        else setError('開通失敗，請稍後再試。');
        return;
      }
      if (data.state === 'pending') { setInfo({ state: 'pending' }); return; }
      // 用剛設定的密碼直接登入後台
      // 登入失敗時（例如網路中斷）後台會顯示登入頁
      await fetch(agencyApi(data.code, '/agency/session'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: data.email, password }),
      }).catch(() => undefined);
      window.location.replace(`/${data.code}/admin`);
    } catch {
      setError('網路連線失敗，請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="admin-login">
      <div className="block auth-form">
        <h1>開通免費試用</h1>
        {invalid ? (
          <>
            <p className="error" role="alert">這個連結已失效。開通連結在 {TRIAL_LIMITS.verifyHours} 小時內有效、只能使用一次。</p>
            <a className="primary wide" href="/#signup">重新申請</a>
          </>
        ) : !info ? <p aria-busy="true">載入中…</p>
          : info.state === 'activated' ? (
            <>
              <p role="status">這個試用已經開通。</p>
              <a className="primary wide" href={`/${info.code}/admin`}>前往後台登入</a>
            </>
          ) : info.state === 'pending' ? (
            <p role="status">已確認你的 Email。我們審核資料後會開通試用，並寄設定密碼的連結給你。</p>
          ) : (
            <form onSubmit={submit}>
              <p className="muted">{info.contactName} 您好，確認以下資料{info.mode === 'auto' ? '並設定後台密碼，就能開始使用' : '後送出，我們審核後會開通'}。</p>
              <dl className="activate-summary">
                <dt>旅行社</dt><dd>{info.agencyName}</dd>
                <dt>網址</dt><dd>{typeof window === 'undefined' ? '' : window.location.host}/{info.code}</dd>
                <dt>登入 Email</dt><dd>{info.email}</dd>
                <dt>試用內容</dt><dd>{TRIAL_LIMITS.days} 天、{TRIAL_LIMITS.events} 場活動、最多 {TRIAL_LIMITS.maxTravelers} 位旅客、通知信 {TRIAL_LIMITS.mailTotal} 封</dd>
              </dl>
              {error && <p className="error" role="alert">{error}</p>}
              {info.mode === 'auto' && (
                <>
                  <label className="field"><span>後台密碼</span><input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} /><small>{PASSWORD_RULE}</small></label>
                  <label className="field"><span>再輸入一次</span><input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
                </>
              )}
              <button type="submit" className="primary wide" disabled={busy}>{busy ? '處理中…' : info.mode === 'auto' ? '開通並進入後台' : '確認 Email'}</button>
            </form>
          )}
      </div>
    </main>
  );
}
