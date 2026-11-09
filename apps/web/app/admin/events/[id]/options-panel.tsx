'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { adminApi, type AdminEvent, type AdminOption, type AdminOptionGroup, type AdminSession, type OptionGroupValues } from '../../../../lib/admin-api';
import { a } from '../../../../messages/admin';
import { adminError, MoveButtons, swapped } from '../../admin-shell';

const EMPTY_GROUP: OptionGroupValues = { name: '', isRequired: false, maxSelect: 1, preferenceCount: 1, activityDate: null };

/** 2027-03-02 → 2027/3/2（二） */
export function formatDay(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}（${'日一二三四五六'[d.getUTCDay()]}）`;
}

type Editing =
  | { kind: 'group'; group: AdminOptionGroup | null }
  | { kind: 'option'; groupId: string; option: AdminOption | null };

export function OptionsPanel({ event }: { event: AdminEvent }) {
  const [groups, setGroups] = useState<AdminOptionGroup[] | null>(null);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => Promise.all([adminApi.optionGroups(event.id), adminApi.sessions(event.id)])
    .then(([g, s]) => { setGroups(g); setSessions(s); })
    .catch((e) => setError(adminError(e))), [event.id]);
  useEffect(() => { void load(); }, [load]);

  if (!groups) return error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>;

  const saved = () => { setEditing(null); setError(null); void load(); };
  const removeOption = async (o: AdminOption) => {
    if (!window.confirm(a.confirmRemove(o.name))) return;
    setError(null);
    await adminApi.deleteOption(event.id, o.id).then(load).catch((e) => setError(adminError(e)));
  };

  const uploadPdf = async (o: AdminOption, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    if (file.size > 10 * 1024 * 1024) { setError(a.errors.FILE_TOO_LARGE!); return; }
    await adminApi.uploadOptionPdf(event.id, o.id, file).then(load).catch((err) => setError(adminError(err)));
  };
  const removePdf = async (o: AdminOption) => {
    setError(null);
    await adminApi.deleteOptionPdf(event.id, o.id).then(load).catch((err) => setError(adminError(err)));
  };
  const moveGroup = async (i: number, j: number) => {
    setError(null);
    const next = swapped(groups, i, j);
    setGroups(next);
    await adminApi.orderOptionGroups(event.id, next.map((g) => g.id)).catch((e) => { setError(adminError(e)); return load(); });
  };
  const moveOption = async (g: AdminOptionGroup, i: number, j: number) => {
    setError(null);
    const options = swapped(g.options, i, j);
    setGroups(groups.map((x) => (x.id === g.id ? { ...x, options } : x)));
    await adminApi.orderOptions(event.id, g.id, options.map((o) => o.id)).catch((e) => { setError(adminError(e)); return load(); });
  };

  return (
    <section className="admin-panel">
      <div className="admin-panel-head">
        <p className="muted">{a.optionsHint}</p>
        <button type="button" className="primary" onClick={() => setEditing({ kind: 'group', group: null })}>{a.addGroup}</button>
      </div>
      {sessions.length === 0 && <p className="admin-note">{a.optionsNeedSession} <Link href={`/admin/events/${event.id}/sessions`}>{a.eventSections.sessions}</Link></p>}
      {error && <p className="error" role="alert">{error}</p>}
      {editing?.kind === 'group' && !editing.group && <GroupForm eventId={event.id} group={null} onCancel={() => setEditing(null)} onSaved={saved} />}
      {groups.length === 0 && <p className="muted">{a.noGroups}</p>}
      {groups.map((g, gi) => (
        <section key={g.id} className="admin-group" aria-label={g.name}>
          <div className="admin-group-head">
            <div>
              <h2>{g.name}</h2>
              <p>{a.groupRule(g.isRequired, g.maxSelect, g.preferenceCount)}{g.activityDate && <>・{a.groupDateLine(formatDay(g.activityDate))}</>}</p>
            </div>
            <div className="admin-group-tools">
              <MoveButtons name={g.name} canUp={gi > 0} canDown={gi < groups.length - 1} onUp={() => moveGroup(gi, gi - 1)} onDown={() => moveGroup(gi, gi + 1)} />
              <button type="button" className="link" onClick={() => setEditing({ kind: 'group', group: g })}>{a.editGroup}</button>
            </div>
          </div>
          {editing?.kind === 'group' && editing.group?.id === g.id && <GroupForm eventId={event.id} group={g} onCancel={() => setEditing(null)} onSaved={saved} />}
          {g.options.length === 0 ? <p className="muted">{a.noOptions}</p> : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th scope="col">{a.order}</th><th scope="col">{a.optionName}</th><th scope="col">{a.optionPdf}</th><th scope="col">{a.optionPrice}</th>
                    {sessions.map((s) => <th key={s.id} scope="col">{s.name}</th>)}
                    <th scope="col">{a.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {g.options.map((o, oi) => (
                    <tr key={o.id}>
                      <td><MoveButtons name={o.name} canUp={oi > 0} canDown={oi < g.options.length - 1} onUp={() => moveOption(g, oi, oi - 1)} onDown={() => moveOption(g, oi, oi + 1)} /></td>
                      <td><strong>{o.name}</strong></td>
                      <td>
                        {o.pdfFileName
                          ? <a href={`/api/v1/agency/events/${event.id}/options/${o.id}/pdf`} target="_blank" rel="noopener">{o.pdfFileName}</a>
                          : <span className="muted">{a.optionPdfNone}</span>}
                        <div className="admin-actions admin-file-row">
                          <input id={`pdf-${o.id}`} className="admin-file-input" type="file" accept="application/pdf,.pdf" aria-label={o.pdfFileName ? a.optionPdfReplace(o.name) : a.optionPdfUpload(o.name)} onChange={(e) => uploadPdf(o, e)} />
                          <label htmlFor={`pdf-${o.id}`} className="link">{o.pdfFileName ? a.replace : a.upload}</label>
                          {o.pdfFileName && <button type="button" className="link" aria-label={a.optionPdfRemove(o.name)} onClick={() => removePdf(o)}>{a.remove}</button>}
                        </div>
                      </td>
                      <td>{o.price === 0 ? a.noExtra : a.extra(o.price)}</td>
                      {sessions.map((s) => {
                        const q = o.quotas.find((x) => x.sessionIds.includes(s.id));
                        if (!q) return <td key={s.id}>{a.unlimited}</td>;
                        const shared = q.sessionIds.length > 1;
                        return (
                          <td key={s.id}>
                            {q.capacity}{shared && <> <span className="admin-tag">{a.quotaShared}</span></>}
                            {q.soldCount > 0 && <><br /><small className="muted admin-nowrap">{shared ? a.quotaSharedSold(q.soldCount) : a.sold(q.soldCount)}</small></>}
                          </td>
                        );
                      })}
                      <td className="admin-actions">
                        <button type="button" className="link" onClick={() => setEditing({ kind: 'option', groupId: g.id, option: o })}>{a.edit}</button>
                        <button type="button" className="link" onClick={() => removeOption(o)}>{a.remove}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {editing?.kind === 'option' && editing.groupId === g.id
            ? <OptionForm key={editing.option?.id ?? 'new'} eventId={event.id} groupId={g.id} option={editing.option} sessions={sessions} onCancel={() => setEditing(null)} onSaved={saved} />
            : <div><button type="button" className="link" onClick={() => setEditing({ kind: 'option', groupId: g.id, option: null })}>{a.addOption}</button></div>}
        </section>
      ))}
    </section>
  );
}

function GroupForm({ eventId, group, onCancel, onSaved }: { eventId: string; group: AdminOptionGroup | null; onCancel: () => void; onSaved: () => void }) {
  const [v, setV] = useState<OptionGroupValues>(group ? { name: group.name, isRequired: group.isRequired, maxSelect: group.maxSelect, preferenceCount: group.preferenceCount, activityDate: group.activityDate } : EMPTY_GROUP);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try {
      await action();
      onSaved();
    } catch (err) {
      setError(adminError(err));
      setBusy(false);
    }
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(() => (group ? adminApi.updateOptionGroup(eventId, group.id, v) : adminApi.createOptionGroup(eventId, v)));
  };
  const remove = () => {
    if (group && window.confirm(a.confirmRemove(group.name))) void run(() => adminApi.deleteOptionGroup(eventId, group.id));
  };
  const single = v.maxSelect === 1;

  return (
    <form className="admin-form" onSubmit={submit}>
      {error && <p className="error" role="alert">{error}</p>}
      <label className="field"><span>{a.groupName}</span><input type="text" required maxLength={100} placeholder={a.groupNamePlaceholder} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></label>
      <label className="field"><span>{a.groupMaxSelect}</span><input type="number" required min={1} max={20} value={v.maxSelect} onChange={(e) => { const maxSelect = Number(e.target.value); setV({ ...v, maxSelect, preferenceCount: maxSelect === 1 ? v.preferenceCount : 1 }); }} /></label>
      <label className="field">
        <span>{a.groupPreference}</span>
        <select disabled={!single} value={v.preferenceCount} onChange={(e) => setV({ ...v, preferenceCount: Number(e.target.value) })}>
          {a.groupPreferenceOptions.map((label, i) => <option key={label} value={i + 1}>{label}</option>)}
        </select>
        <small className="muted">{single ? a.groupPreferenceHint : a.groupPreferenceSingleOnly}</small>
      </label>
      <label className="field">
        <span>{a.groupDate}</span>
        <input type="date" value={v.activityDate ?? ''} onChange={(e) => setV({ ...v, activityDate: e.target.value || null })} />
        <small className="muted">{a.groupDateHint}</small>
      </label>
      <label className="check span-3"><input type="checkbox" checked={v.isRequired} onChange={(e) => setV({ ...v, isRequired: e.target.checked })} /><span>{a.groupRequired}</span></label>
      <div className="admin-form-actions span-3">
        {group && <button type="button" className="link" disabled={busy} onClick={remove}>{a.deleteGroup}</button>}
        <button type="button" className="ghost" onClick={onCancel}>{a.cancel}</button>
        <button type="submit" className="primary" disabled={busy}>{busy ? a.saving : a.save}</button>
      </div>
    </form>
  );
}

function OptionForm({ eventId, groupId, option, sessions, onCancel, onSaved }: { eventId: string; groupId: string; option: AdminOption | null; sessions: AdminSession[]; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(option?.name ?? '');
  const [price, setPrice] = useState(option?.price ?? 0);
  const [pools, setPools] = useState<{ sessionIds: string[]; capacity: string }[]>(() =>
    (option?.quotas ?? []).map((q) => ({ sessionIds: q.sessionIds, capacity: String(q.capacity) })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assigned = new Set(pools.flatMap((p) => p.sessionIds));
  const unassigned = sessions.filter((s) => !assigned.has(s.id));
  const setPool = (i: number, patch: Partial<{ sessionIds: string[]; capacity: string }>) => setPools(pools.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const toggle = (i: number, sessionId: string) => {
    const ids = pools[i]!.sessionIds;
    // 依梯次排序存放，畫面與儲存的順序一致。
    const next = ids.includes(sessionId) ? ids.filter((x) => x !== sessionId) : sessions.map((s) => s.id).filter((id) => id === sessionId || ids.includes(id));
    setPool(i, { sessionIds: next });
  };
  // 新的一組預設勾選還沒設定名額的梯次，共用名額只要一步。
  const addPool = () => setPools([...pools, { sessionIds: unassigned.map((s) => s.id), capacity: '' }]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const empty = pools.findIndex((p) => p.sessionIds.length === 0);
    if (empty >= 0) { setError(a.quotaNeedSession(empty + 1)); return; }
    setBusy(true); setError(null);
    const values = { name, price, quotas: pools.map((p) => ({ sessionIds: p.sessionIds, capacity: Number(p.capacity) })) };
    try {
      if (option) await adminApi.updateOption(eventId, option.id, values);
      else await adminApi.createOption(eventId, groupId, values);
      onSaved();
    } catch (err) {
      setError(adminError(err));
      setBusy(false);
    }
  };

  return (
    <form className="admin-form" onSubmit={submit}>
      {error && <p className="error span-3" role="alert">{error}</p>}
      <label className="field span-2"><span>{a.optionName}</span><input type="text" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>{a.optionPrice}</span><input type="number" required min={0} max={10000000} value={price} onChange={(e) => setPrice(Number(e.target.value))} /></label>
      <fieldset className="span-3 admin-quota-pools">
        <legend>{a.optionQuotaTitle}</legend>
        <p className="muted">{a.optionQuotaHint}</p>
        {pools.map((p, i) => (
          <fieldset key={i} className="admin-quota-pool">
            <legend>{a.quotaPoolLabel(i + 1)}{p.sessionIds.length > 1 && <> <span className="admin-tag">{a.quotaShared}</span></>}</legend>
            <label className="field">
              <span>{a.quotaCapacity}</span>
              <input type="number" required min={0} max={5000} value={p.capacity} onChange={(e) => setPool(i, { capacity: e.target.value })} />
            </label>
            <div className="admin-quota-sessions" role="group" aria-label={`${a.quotaPoolLabel(i + 1)}・${a.quotaSessions}`}>
              <span>{a.quotaSessions}</span>
              {sessions.map((s) => {
                const elsewhere = !p.sessionIds.includes(s.id) && assigned.has(s.id);
                return (
                  <label key={s.id} className="check">
                    <input type="checkbox" checked={p.sessionIds.includes(s.id)} disabled={elsewhere} onChange={() => toggle(i, s.id)} />
                    <span>{s.name}</span>
                  </label>
                );
              })}
            </div>
            <button type="button" className="link" onClick={() => setPools(pools.filter((_, j) => j !== i))}>{a.quotaRemove(i + 1)}</button>
          </fieldset>
        ))}
        {unassigned.length > 0
          ? <>
              <p className="muted">{a.quotaUnlimitedList(unassigned.map((s) => s.name).join('、'))}</p>
              <div><button type="button" className="ghost" onClick={addPool}>{a.quotaAdd}</button></div>
            </>
          : <p className="muted">{a.quotaAllAssigned}</p>}
      </fieldset>
      <div className="admin-form-actions span-3">
        <button type="button" className="ghost" onClick={onCancel}>{a.cancel}</button>
        <button type="submit" className="primary" disabled={busy}>{busy ? a.saving : a.save}</button>
      </div>
    </form>
  );
}
