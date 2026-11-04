'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { adminFetch, errorMessage } from '../../../../lib/admin-api';
import { ConfirmButton, Shell } from '../../shell';
import { FieldsTab, OptionsTab, SessionsTab } from './config-tabs';
import { RegistrationsTab, RosterTab } from './people-tabs';

const TABS = [['basic', '基本設定'], ['sessions', '梯次與團費'], ['options', '自選行程'], ['fields', '旅客欄位'], ['roster', '員工名單'], ['registrations', '報名管理']] as const;
const STATUS: Record<string, string> = { draft: '草稿', published: '已發布', closed: '已關閉', archived: '已封存' };

const toLocal = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null);

export default function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [event, setEvent] = useState<any>(null);
  const [tab, setTab] = useState<string>('basic');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => setEvent(await adminFetch('GET', `/events/${id}`)), [id]);
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (TABS.some(([k]) => k === hash)) setTab(hash);
    reload().catch((e) => setError(errorMessage(e)));
  }, [reload]);

  const run = useCallback(async (fn: () => Promise<unknown>, ok?: string) => {
    setError(null); setNotice(null);
    try {
      await fn();
      await reload();
      if (ok) setNotice(ok);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [reload]);

  const select = (key: string) => { setTab(key); window.history.replaceState(null, '', `#${key}`); setError(null); setNotice(null); };

  if (!event) return <Shell>{error ? <p className="msg-error" role="alert">{error}</p> : <p>載入中</p>}</Shell>;

  return (
    <Shell>
      <div>
        <h1 className="page-title">{event.name}</h1>
        <p className="page-sub">{event.companyName}｜{event.tier.minTravelers}～{event.tier.maxTravelers} 人級距｜<span className={`badge ${event.status}`}>{STATUS[event.status]}</span></p>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => select(key)}>{label}</button>)}
      </div>
      {error && <p className="msg-error" role="alert">{error}</p>}
      {notice && <p className="msg-ok" role="status">{notice}</p>}
      {tab === 'basic' && <BasicTab event={event} run={run} />}
      {tab === 'sessions' && <SessionsTab event={event} run={run} />}
      {tab === 'options' && <OptionsTab event={event} run={run} />}
      {tab === 'fields' && <FieldsTab event={event} run={run} />}
      {tab === 'roster' && <RosterTab event={event} onError={setError} onNotice={setNotice} />}
      {tab === 'registrations' && <RegistrationsTab event={event} onError={setError} onChanged={reload} />}
    </Shell>
  );
}

function BasicTab({ event, run }: { event: any; run: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  const [f, setF] = useState({
    name: event.name,
    opens: toLocal(event.registrationOpensAt),
    closes: toLocal(event.registrationClosesAt),
    endsOn: event.endsOn ?? '',
    subsidy: String(event.defaultSubsidyAmount),
    limit: String(event.defaultDependentLimit),
    allow: event.allowDependentsOnly as boolean,
    retention: String(event.retentionDays),
    summary: event.itinerary?.summary ?? '',
    days: (event.itinerary?.days ?? []).map((d: any) => `${d.title}｜${d.description}`).join('\n'),
  });
  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  const save = () => run(() => adminFetch('PATCH', `/events/${event.id}`, {
    name: f.name,
    registrationOpensAt: fromLocal(f.opens),
    registrationClosesAt: fromLocal(f.closes),
    endsOn: f.endsOn || null,
    defaultSubsidyAmount: Number(f.subsidy),
    defaultDependentLimit: Number(f.limit),
    allowDependentsOnly: f.allow,
    retentionDays: Number(f.retention),
    itinerary: {
      summary: f.summary,
      days: f.days.split('\n').map((l: string) => l.trim()).filter(Boolean).map((l: string) => {
        const [title, ...rest] = l.split('｜');
        return { title: title!.trim(), description: rest.join('｜').trim() };
      }),
    },
  }), '已儲存。');

  return (
    <>
      <section className="panel">
        <h2>活動內容</h2>
        <label className="lab">活動名稱<input value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="lab">行程簡介<textarea value={f.summary} onChange={(e) => set('summary', e.target.value)} /></label>
        <label className="lab">每日行程（每行一天，格式：第一天｜桃園出發，抵達那霸）<textarea rows={4} value={f.days} onChange={(e) => set('days', e.target.value)} /></label>
        <div className="row">
          <label className="lab">報名開始<input type="datetime-local" value={f.opens} onChange={(e) => set('opens', e.target.value)} /></label>
          <label className="lab">報名截止<input type="datetime-local" value={f.closes} onChange={(e) => set('closes', e.target.value)} /></label>
          <label className="lab">活動結束日<input type="date" value={f.endsOn} onChange={(e) => set('endsOn', e.target.value)} /></label>
        </div>
        <div className="row">
          <label className="lab">預設補助金額<input type="number" min={0} value={f.subsidy} onChange={(e) => set('subsidy', e.target.value)} /></label>
          <label className="lab">預設眷屬人數上限<input type="number" min={0} value={f.limit} onChange={(e) => set('limit', e.target.value)} /></label>
          <label className="lab">個資保存天數（活動結束後）<input type="number" min={1} value={f.retention} onChange={(e) => set('retention', e.target.value)} /></label>
          <label className="lab check"><input type="checkbox" checked={f.allow} onChange={(e) => set('allow', e.target.checked)} />開放只有眷屬參加</label>
        </div>
        <div className="row"><button type="button" className="btn main" onClick={save}>儲存</button></div>
      </section>
      <section className="panel">
        <h2>發布與報名網址</h2>
        <p className="page-sub">網址格式：{event.agencyCode}.平台網域/{event.slug}。員工要用自己的專屬連結才能報名，連結在「員工名單」匯出。</p>
        <div className="row">
          {event.status === 'draft' && <button type="button" className="btn main" onClick={() => run(() => adminFetch('POST', `/events/${event.id}/publish`), '活動已發布。')}>發布活動</button>}
          {event.status === 'closed' && <button type="button" className="btn main" onClick={() => run(() => adminFetch('POST', `/events/${event.id}/publish`), '活動已重新發布。')}>重新發布</button>}
          {event.status === 'published' && <ConfirmButton label="關閉報名" confirmLabel="確定關閉報名" onConfirm={() => run(() => adminFetch('POST', `/events/${event.id}/close`), '報名已關閉。')} />}
          <ConfirmButton
            label="刪除活動"
            confirmLabel="確定刪除並退回額度"
            onConfirm={() => adminFetch('DELETE', `/events/${event.id}`).then(() => { window.location.href = '/admin'; }).catch((e) => run(() => Promise.reject(e)))}
          />
        </div>
      </section>
    </>
  );
}
