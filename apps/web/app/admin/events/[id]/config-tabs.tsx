'use client';

import { useState } from 'react';
import { adminFetch } from '../../../../lib/admin-api';
import { ConfirmButton } from '../../shell';

type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

export function SessionsTab({ event, run }: { event: any; run: Run }) {
  const total = event.sessions.reduce((s: number, x: any) => s + x.capacity, 0);
  return (
    <>
      <section className="panel">
        <h2>梯次</h2>
        <p className="page-sub">總名額 {total.toLocaleString()} 人，所購級距上限 {event.tier.maxTravelers.toLocaleString()} 人。</p>
        {event.sessions.map((s: any) => <SessionForm key={s.id} event={event} session={s} run={run} />)}
        <SessionForm key={`new-${event.sessions.length}`} event={event} run={run} />
      </section>
      <section className="panel">
        <h2>旅客類型與團費</h2>
        <p className="page-sub">修改價格只影響之後的新報名。</p>
        {event.travelerTypes.map((t: any) => <TypeForm key={t.id} event={event} type={t} run={run} />)}
        <TypeForm key={`new-${event.travelerTypes.length}`} event={event} run={run} />
      </section>
    </>
  );
}

function SessionForm({ event, session, run }: { event: any; session?: any; run: Run }) {
  const [f, setF] = useState({ name: session?.name ?? '', departsOn: session?.departsOn ?? '', returnsOn: session?.returnsOn ?? '', capacity: String(session?.capacity ?? '') });
  const body = { name: f.name, departsOn: f.departsOn || null, returnsOn: f.returnsOn || null, capacity: Number(f.capacity), sortOrder: session?.sortOrder ?? event.sessions.length };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(() => session ? adminFetch('PUT', `/events/${event.id}/sessions/${session.id}`, body) : adminFetch('POST', `/events/${event.id}/sessions`, body), session ? '梯次已儲存。' : '梯次已新增。');
  };
  return (
    <form className="row" onSubmit={submit}>
      <label className="lab">梯次名稱<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label className="lab">出發日<input type="date" value={f.departsOn} onChange={(e) => setF({ ...f, departsOn: e.target.value })} /></label>
      <label className="lab">回程日<input type="date" value={f.returnsOn} onChange={(e) => setF({ ...f, returnsOn: e.target.value })} /></label>
      <label className="lab narrow">名額{session ? `（已售 ${session.soldCount}）` : ''}<input required type="number" min={0} value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} /></label>
      <button className={`btn${session ? '' : ' main'}`} type="submit">{session ? '儲存' : '新增梯次'}</button>
      {session && <ConfirmButton label="刪除" confirmLabel="確定刪除" onConfirm={() => run(() => adminFetch('DELETE', `/events/${event.id}/sessions/${session.id}`), '梯次已刪除。')} />}
    </form>
  );
}

function TypeForm({ event, type, run }: { event: any; type?: any; run: Run }) {
  const [f, setF] = useState({ name: type?.name ?? '', basePrice: String(type?.basePrice ?? ''), self: type?.isEmployeeSelf ?? false });
  const body = { name: f.name, basePrice: Number(f.basePrice), isEmployeeSelf: f.self, sortOrder: type?.sortOrder ?? event.travelerTypes.length };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(() => type ? adminFetch('PUT', `/events/${event.id}/traveler-types/${type.id}`, body) : adminFetch('POST', `/events/${event.id}/traveler-types`, body), type ? '旅客類型已儲存。' : '旅客類型已新增。');
  };
  return (
    <form className="row" onSubmit={submit}>
      <label className="lab">類型名稱<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="成人眷屬" /></label>
      <label className="lab narrow">團費<input required type="number" min={0} value={f.basePrice} onChange={(e) => setF({ ...f, basePrice: e.target.value })} /></label>
      <label className="lab check"><input type="checkbox" checked={f.self} onChange={(e) => setF({ ...f, self: e.target.checked })} />這是員工本人</label>
      <button className={`btn${type ? '' : ' main'}`} type="submit">{type ? '儲存' : '新增類型'}</button>
      {type && <ConfirmButton label="刪除" confirmLabel="確定刪除" onConfirm={() => run(() => adminFetch('DELETE', `/events/${event.id}/traveler-types/${type.id}`), '旅客類型已刪除。')} />}
    </form>
  );
}

export function OptionsTab({ event, run }: { event: any; run: Run }) {
  return (
    <section className="panel">
      <h2>自選行程</h2>
      <p className="page-sub">每個群組可設定是否必選、最多選幾項；每個選項可依梯次設定名額，留空表示不限量。</p>
      {event.optionGroups.map((g: any) => (
        <div className="group-box" key={g.id}>
          <GroupForm event={event} group={g} run={run} />
          {g.options.map((o: any) => <OptionForm key={o.id} event={event} group={g} option={o} run={run} />)}
          <OptionForm key={`new-${g.options.length}`} event={event} group={g} run={run} />
        </div>
      ))}
      <div className="group-box"><GroupForm key={`new-${event.optionGroups.length}`} event={event} run={run} /></div>
    </section>
  );
}

function GroupForm({ event, group, run }: { event: any; group?: any; run: Run }) {
  const [f, setF] = useState({ name: group?.name ?? '', required: group?.isRequired ?? false, max: String(group?.maxSelect ?? 1) });
  const body = { name: f.name, isRequired: f.required, minSelect: f.required ? 1 : 0, maxSelect: Number(f.max), sortOrder: group?.sortOrder ?? event.optionGroups.length };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(() => group ? adminFetch('PUT', `/events/${event.id}/option-groups/${group.id}`, body) : adminFetch('POST', `/events/${event.id}/option-groups`, body), group ? '群組已儲存。' : '群組已新增。');
  };
  return (
    <form className="row" onSubmit={submit}>
      <label className="lab">群組名稱<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="第二天行程" /></label>
      <label className="lab narrow">最多選幾項<input required type="number" min={1} value={f.max} onChange={(e) => setF({ ...f, max: e.target.value })} /></label>
      <label className="lab check"><input type="checkbox" checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} />必選</label>
      <button className={`btn${group ? '' : ' main'}`} type="submit">{group ? '儲存群組' : '新增群組'}</button>
      {group && <ConfirmButton label="刪除群組" confirmLabel="確定刪除" onConfirm={() => run(() => adminFetch('DELETE', `/events/${event.id}/option-groups/${group.id}`), '群組已刪除。')} />}
    </form>
  );
}

function OptionForm({ event, group, option, run }: { event: any; group: any; option?: any; run: Run }) {
  const [f, setF] = useState({ name: option?.name ?? '', price: String(option?.price ?? '0') });
  const [quotas, setQuotas] = useState<Record<string, string>>(() => Object.fromEntries((option?.quotas ?? []).map((q: any) => [q.sessionId, String(q.capacity)])));
  const body = {
    name: f.name,
    price: Number(f.price),
    sortOrder: option?.sortOrder ?? group.options.length,
    quotas: Object.entries(quotas).filter(([, v]) => v !== '').map(([sessionId, v]) => ({ sessionId, capacity: Number(v) })),
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(() => option ? adminFetch('PUT', `/events/${event.id}/options/${option.id}`, body) : adminFetch('POST', `/events/${event.id}/option-groups/${group.id}/options`, body), option ? '選項已儲存。' : '選項已新增。');
  };
  return (
    <form className="option-row" onSubmit={submit}>
      <div className="row">
        <label className="lab">選項名稱<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="lab narrow">加價<input required type="number" min={0} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></label>
        <button className={`btn${option ? '' : ' main'}`} type="submit">{option ? '儲存' : '新增選項'}</button>
        {option && <ConfirmButton label="刪除" confirmLabel="確定刪除" onConfirm={() => run(() => adminFetch('DELETE', `/events/${event.id}/options/${option.id}`), '選項已刪除。')} />}
      </div>
      {event.sessions.length > 0 && (
        <div className="quota-grid">
          {event.sessions.map((s: any) => {
            const sold = option?.quotas.find((q: any) => q.sessionId === s.id)?.soldCount;
            return (
              <label className="lab" key={s.id}>{s.name} 名額{sold ? `（已售 ${sold}）` : ''}
                <input type="number" min={0} placeholder="不限" value={quotas[s.id] ?? ''} onChange={(e) => setQuotas({ ...quotas, [s.id]: e.target.value })} />
              </label>
            );
          })}
        </div>
      )}
    </form>
  );
}

const FIELD_TYPES: [string, string][] = [['text', '文字'], ['number', '數字'], ['date', '日期'], ['select', '下拉選單'], ['national_id', '身分證字號'], ['passport', '護照號碼']];

export function FieldsTab({ event, run }: { event: any; run: Run }) {
  return (
    <section className="panel">
      <h2>旅客欄位</h2>
      <p className="page-sub">姓名是固定欄位，其他資料依活動需求新增。敏感欄位會加密儲存，且只顯示遮罩內容；已有報名後不能變更欄位代碼與敏感屬性。</p>
      {event.fields.map((f: any) => <FieldForm key={f.id} event={event} field={f} run={run} />)}
      <FieldForm key={`new-${event.fields.length}`} event={event} run={run} />
    </section>
  );
}

function FieldForm({ event, field, run }: { event: any; field?: any; run: Run }) {
  const [f, setF] = useState({ label: field?.label ?? '', fieldKey: field?.fieldKey ?? '', fieldType: field?.fieldType ?? 'text', required: field?.isRequired ?? false, sensitive: field?.isSensitive ?? false, choices: (field?.choices ?? []).join('、') });
  const idType = f.fieldType === 'national_id' || f.fieldType === 'passport';
  const body = {
    label: f.label, fieldKey: f.fieldKey, fieldType: f.fieldType, isRequired: f.required, isSensitive: f.sensitive || idType,
    choices: f.fieldType === 'select' ? f.choices.split(/[、,，\n]/).map((c: string) => c.trim()).filter(Boolean) : null,
    sortOrder: field?.sortOrder ?? event.fields.length,
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(() => field ? adminFetch('PUT', `/events/${event.id}/fields/${field.id}`, body) : adminFetch('POST', `/events/${event.id}/fields`, body), field ? '欄位已儲存。' : '欄位已新增。');
  };
  return (
    <form className="row" onSubmit={submit}>
      <label className="lab">欄位名稱<input required value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="生日" /></label>
      <label className="lab">欄位代碼（英文小寫）<input required pattern="[a-z][a-z0-9_]*" value={f.fieldKey} onChange={(e) => setF({ ...f, fieldKey: e.target.value })} placeholder="birthday" /></label>
      <label className="lab">類型
        <select value={f.fieldType} onChange={(e) => setF({ ...f, fieldType: e.target.value })}>
          {FIELD_TYPES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      {f.fieldType === 'select' && <label className="lab">選項（用頓號分隔）<input required value={f.choices} onChange={(e) => setF({ ...f, choices: e.target.value })} placeholder="一般、素食" /></label>}
      <label className="lab check"><input type="checkbox" checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} />必填</label>
      <label className="lab check"><input type="checkbox" disabled={idType} checked={f.sensitive || idType} onChange={(e) => setF({ ...f, sensitive: e.target.checked })} />敏感資料</label>
      <button className={`btn${field ? '' : ' main'}`} type="submit">{field ? '儲存' : '新增欄位'}</button>
      {field && <ConfirmButton label="刪除" confirmLabel="確定刪除" onConfirm={() => run(() => adminFetch('DELETE', `/events/${event.id}/fields/${field.id}`), '欄位已刪除。')} />}
    </form>
  );
}
