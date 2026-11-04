'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { adminFetch, errorMessage, money } from '../../../../lib/admin-api';
import { ConfirmButton } from '../../shell';

const REG_STATUS: Record<string, string> = { confirmed: '已報名', cancel_requested: '待確認取消', cancelled: '已取消' };
const EMPTY = { employeeNo: '', name: '', email: '', department: '', subsidyAmount: '', dependentLimit: '' };

export function RosterTab({ event, onError, onNotice }: { event: any; onError: (m: string | null) => void; onNotice: (m: string | null) => void }) {
  const [employees, setEmployees] = useState<any[] | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY);

  const load = useCallback(async () => setEmployees(await adminFetch('GET', `/events/${event.id}/employees`)), [event.id]);
  useEffect(() => { load().catch((e) => onError(errorMessage(e))); }, [load, onError]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    onError(null); onNotice(null);
    try { await fn(); await load(); onNotice(ok); } catch (e) { onError(errorMessage(e)); }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    onError(null); onNotice(null); setPreview(null);
    if (file.size > 5 * 1024 * 1024) { onError('檔案不可超過 5MB。'); return; }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      setPreview(await adminFetch('POST', `/events/${event.id}/employees/import/preview`, { fileBase64: btoa(binary) }));
    } catch (err) { onError(errorMessage(err)); } finally { setBusy(false); }
  };

  const commit = () => act(async () => {
    const r = await adminFetch('POST', `/events/${event.id}/employees/import/commit`, { rows: preview.rows });
    setPreview(null);
    return r;
  }, '名單已匯入。');

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    act(async () => {
      await adminFetch('POST', `/events/${event.id}/employees`, {
        employeeNo: form.employeeNo, name: form.name, email: form.email || null, department: form.department || null,
        subsidyAmount: form.subsidyAmount === '' ? null : Number(form.subsidyAmount), dependentLimit: form.dependentLimit === '' ? null : Number(form.dependentLimit),
      });
      setForm(EMPTY);
    }, '員工已新增。');
  };

  return (
    <>
      <section className="panel">
        <h2>匯入名單</h2>
        <p className="page-sub">上傳後會先顯示檢查結果，確認才寫入。員工編號已存在時會更新資料，專屬連結不變；補助留空時套用活動預設值 {money(event.defaultSubsidyAmount)}。</p>
        <div className="row">
          <a className="btn" href={`/api/v1/admin/events/${event.id}/employees/template`}>下載 Excel 範本</a>
          <label className="btn main">選擇 Excel 檔<input className="sr-only" type="file" accept=".xlsx" disabled={busy} onChange={onFile} /></label>
          <a className="btn" href={`/api/v1/admin/events/${event.id}/employees/links`}>匯出專屬連結</a>
        </div>
        {preview && (
          <div className="group-box">
            <h3>檢查結果：可匯入 {preview.summary.total} 位（新增 {preview.summary.created}、更新 {preview.summary.updated}），{preview.errors.length} 筆錯誤</h3>
            {preview.errors.length > 0 && (
              <ul className="msg-error">{preview.errors.slice(0, 20).map((e: any) => <li key={e.row}>第 {e.row} 列：{e.message}</li>)}</ul>
            )}
            {preview.errors.length > 20 && <p className="msg-error">另有 {preview.errors.length - 20} 筆錯誤未顯示。</p>}
            <div className="row">
              <button type="button" className="btn main" disabled={preview.summary.total === 0} onClick={commit}>匯入 {preview.summary.total} 位員工</button>
              <button type="button" className="btn" onClick={() => setPreview(null)}>取消</button>
            </div>
            {preview.errors.length > 0 && <p className="page-sub">有錯誤的列不會匯入，可修正後再上傳一次。</p>}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>新增員工</h2>
        <form className="row" onSubmit={add}>
          <label className="lab narrow">員工編號<input required value={form.employeeNo} onChange={(e) => setForm({ ...form, employeeNo: e.target.value })} /></label>
          <label className="lab">姓名<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="lab">Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label className="lab">部門<input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} /></label>
          <label className="lab narrow">補助金額<input type="number" min={0} placeholder="預設" value={form.subsidyAmount} onChange={(e) => setForm({ ...form, subsidyAmount: e.target.value })} /></label>
          <label className="lab narrow">眷屬上限<input type="number" min={0} placeholder="預設" value={form.dependentLimit} onChange={(e) => setForm({ ...form, dependentLimit: e.target.value })} /></label>
          <button className="btn" type="submit">新增</button>
        </form>
      </section>

      <section className="panel">
        <h2>員工名單（{employees?.length ?? 0} 位）</h2>
        <div className="table-wrap">
          <table className="admin-table">
            <thead><tr><th>員工編號</th><th>姓名</th><th>Email</th><th>部門</th><th className="num">補助</th><th className="num">眷屬上限</th><th>報名</th><th /></tr></thead>
            <tbody>
              {employees?.map((m) => (
                <tr key={m.id}>
                  <td>{m.employeeNo}</td><td>{m.name}</td><td>{m.email ?? '－'}</td><td>{m.department ?? '－'}</td>
                  <td className="num">{m.subsidyAmount === null ? '預設' : money(m.subsidyAmount)}</td>
                  <td className="num">{m.dependentLimit === null ? '預設' : m.dependentLimit}</td>
                  <td>{m.registrationStatus ? <span className={`badge ${m.registrationStatus}`}>{REG_STATUS[m.registrationStatus]}</span> : '未報名'}</td>
                  <td>
                    <div className="row">
                      <ConfirmButton label="重新產生連結" confirmLabel="舊連結將失效" onConfirm={() => act(() => adminFetch('POST', `/events/${event.id}/employees/${m.id}/regenerate-link`), '已重新產生連結，請重新匯出。')} />
                      <ConfirmButton label="移除" confirmLabel="確定移除" onConfirm={() => act(() => adminFetch('DELETE', `/events/${event.id}/employees/${m.id}`), '員工已移除。')} />
                    </div>
                  </td>
                </tr>
              ))}
              {employees?.length === 0 && <tr><td colSpan={8}>還沒有員工。下載範本填好後上傳，或在上方逐筆新增。</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export function RegistrationsTab({ event, onError, onChanged }: { event: any; onError: (m: string | null) => void; onChanged: () => Promise<unknown> }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);

  const load = useCallback(async () => setRows(await adminFetch('GET', `/events/${event.id}/registrations`)), [event.id]);
  useEffect(() => { load().catch((e) => onError(errorMessage(e))); }, [load, onError]);

  const act = async (fn: () => Promise<unknown>) => {
    onError(null);
    try { await fn(); await load(); await onChanged(); } catch (e) { onError(errorMessage(e)); }
  };

  const toggle = async (id: string) => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id); setDetail(null);
    try { setDetail(await adminFetch('GET', `/events/${event.id}/registrations/${id}`)); } catch (e) { onError(errorMessage(e)); }
  };

  const fieldLabel = (key: string) => event.fields.find((f: any) => f.fieldKey === key)?.label ?? key;
  const waiting = rows?.filter((r) => r.status === 'cancel_requested').length ?? 0;

  return (
    <section className="panel">
      <h2>報名名單（{rows?.filter((r) => r.status !== 'cancelled').length ?? 0} 筆有效）</h2>
      {waiting > 0 && <p className="msg-error">有 {waiting} 筆取消申請待處理。</p>}
      <div className="table-wrap">
        <table className="admin-table">
          <thead><tr><th>員工</th><th>梯次</th><th className="num">人數</th><th className="num">整筆費用</th><th className="num">補助</th><th className="num">自付</th><th>付款</th><th>狀態</th><th /></tr></thead>
          <tbody>
            {rows?.map((r) => (
              <Fragment key={r.id}>
                <tr>
                  <td>{r.employeeName}<div className="stat-note">{r.employeeNo}</div></td>
                  <td>{r.sessionName}</td>
                  <td className="num">{r.travelerCount}</td>
                  <td className="num">{money(r.totalAmount)}</td>
                  <td className="num">{money(Math.min(r.totalAmount, r.subsidyAmount))}</td>
                  <td className="num">{money(r.selfPayAmount)}</td>
                  <td>
                    {r.paymentStatus === 'not_required' ? '無需付款' : (
                      <select aria-label={`${r.employeeName} 付款狀態`} value={r.paymentStatus} onChange={(e) => act(() => adminFetch('PATCH', `/events/${event.id}/registrations/${r.id}/payment`, { paymentStatus: e.target.value }))}>
                        <option value="unpaid">未付款</option><option value="paid">已付款</option><option value="refunded">已退款</option>
                      </select>
                    )}
                  </td>
                  <td><span className={`badge ${r.status}`}>{REG_STATUS[r.status]}</span></td>
                  <td>
                    <div className="row">
                      <button type="button" className="btn" onClick={() => toggle(r.id)}>{openId === r.id ? '收合' : '明細'}</button>
                      {r.status === 'cancel_requested' && (
                        <>
                          <ConfirmButton label="確認取消" confirmLabel="確定並釋出名額" onConfirm={() => act(() => adminFetch('POST', `/events/${event.id}/registrations/${r.id}/confirm-cancel`))} />
                          <button type="button" className="btn" onClick={() => act(() => adminFetch('POST', `/events/${event.id}/registrations/${r.id}/reject-cancel`))}>退回申請</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                {openId === r.id && (
                  <tr><td colSpan={9} className="detail-cell">
                    {!detail ? '載入中' : detail.travelers.map((t: any, i: number) => (
                      <p key={i}>
                        <strong>{t.name}</strong>（{t.typeName} {money(t.basePrice)}）
                        {Object.entries(t.fieldValues).map(([k, v]) => `｜${fieldLabel(k)}：${String(v)}`).join('')}
                        {t.options.map((o: any) => `｜${o.name}${o.price ? ` ${money(o.price)}` : ''}`).join('')}
                        {t.requestedRoomNo ? `｜希望第 ${t.requestedRoomNo} 間` : ''}
                      </p>
                    ))}
                    {detail?.roomPreferences.map((p: any) => p.preferredCoworkerName && <p key={p.requestedRoomNo}>第 {p.requestedRoomNo} 間希望同房：{p.preferredCoworkerName}</p>)}
                  </td></tr>
                )}
              </Fragment>
            ))}
            {rows?.length === 0 && <tr><td colSpan={9}>還沒有人報名。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
