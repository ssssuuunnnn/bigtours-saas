'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { adminApi, type AdminEvent, type RegistrationEditData } from '../../../../lib/admin-api';
import { modifiedFees, uuid } from '../../../../lib/fees';
import { a } from '../../../../messages/admin';
import { adminError } from '../../admin-shell';

const money = (n: number) => `$${n.toLocaleString('en-US')}`;

interface Row {
  key: string;
  travelerTypeId: string;
  optionIds: string[];
  roomTypeId: string | null;
  preferences: Record<string, string[]>;
  name: string;
  fieldValues: Record<string, any>;
  requestedRoomNo: number;
  masks: Record<string, string>;
}

export function RegistrationEdit({ event, id, onDone }: { event: AdminEvent; id: string; onDone: (message: string) => void }) {
  const router = useRouter();
  const detailUrl = `/admin/events/${event.id}/registrations?registration=${id}`;
  const [data, setData] = useState<RegistrationEditData | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [rooms, setRooms] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi.registrationEdit(event.id, id).then((d) => {
      setData(d);
      setSessionId(d.registration.sessionId);
      setRows(d.registration.travelers.map((t) => ({
        key: t.id,
        travelerTypeId: t.travelerTypeId,
        optionIds: t.options.map((o) => o.optionId),
        roomTypeId: t.roomTypeId,
        preferences: t.preferenceIds,
        name: t.name,
        fieldValues: t.plainValues,
        requestedRoomNo: t.requestedRoomNo ?? 1,
        masks: t.masks,
      })));
      setRooms(Object.fromEntries(d.registration.roomPreferences.map((p) => [p.requestedRoomNo, p.preferredCoworkerName ?? ''])));
    }).catch((e) => setError(adminError(e)));
  }, [event.id, id]);

  const back = <Link href={detailUrl}>{a.backToRegistrations}</Link>;
  if (!data) return <section className="admin-panel">{back}{error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>}</section>;

  const session = data.availability.find((s) => s.id === sessionId);
  const occupiesBed = (typeId: string) => data.travelerTypes.find((t) => t.id === typeId)?.occupiesBed ?? true;
  /** 換梯次或換成不佔床的類型時，清掉不再適用的房型。 */
  const fitRoom = (r: Row, roomTypes: { id: string }[]): Row => (r.roomTypeId && (!occupiesBed(r.travelerTypeId) || !roomTypes.some((x) => x.id === r.roomTypeId)) ? { ...r, roomTypeId: null } : r);
  const setRow = (key: string, patch: Partial<Row>) => setRows(rows.map((r) => (r.key === key ? fitRoom({ ...r, ...patch }, session?.roomTypes ?? []) : r)));
  const changeSession = (next: string) => {
    setSessionId(next);
    setRows(rows.map((r) => fitRoom(r, data.availability.find((s) => s.id === next)?.roomTypes ?? [])));
  };
  const addTraveler = () => {
    const type = data.travelerTypes.find((t) => !t.isEmployeeSelf) ?? data.travelerTypes[0]!;
    const optionIds = data.optionGroups.filter((g) => g.minSelect > 0).flatMap((g) => g.options.slice(0, g.minSelect).map((o) => o.id));
    setRows([...rows, { key: uuid(), travelerTypeId: type.id, optionIds, roomTypeId: null, preferences: {}, name: '', fieldValues: {}, requestedRoomNo: 1, masks: {} }]);
  };
  const toggleOption = (row: Row, group: RegistrationEditData['optionGroups'][number], optionId: string) => {
    const inGroup = new Set(group.options.map((o) => o.id));
    const has = row.optionIds.includes(optionId);
    let next: string[];
    if (group.maxSelect === 1) next = has && group.minSelect === 0 ? row.optionIds.filter((x) => x !== optionId) : [...row.optionIds.filter((x) => !inGroup.has(x)), optionId];
    else if (has) next = row.optionIds.filter((x) => x !== optionId);
    else if (row.optionIds.filter((x) => inGroup.has(x)).length >= group.maxSelect) return;
    else next = [...row.optionIds, optionId];
    const first = next.find((x) => inGroup.has(x));
    setRow(row.key, { optionIds: next, preferences: { ...row.preferences, [group.id]: first ? (row.preferences[group.id] ?? []).filter((x) => x !== first) : [] } });
  };

  const fees = modifiedFees(data.registration, rows, {
    types: new Map(data.travelerTypes.map((t) => [t.id, t.basePrice])),
    rooms: new Map(data.availability.flatMap((s) => s.roomTypes).map((r) => [r.id, r.surcharge])),
    options: new Map(data.optionGroups.flatMap((g) => g.options).map((o) => [o.id, o.price])),
  });
  const usedRooms = [...new Set(rows.map((r) => r.requestedRoomNo))].sort((x, y) => x - y);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await adminApi.modifyRegistration(event.id, id, {
        sessionId,
        travelers: rows.map(({ masks: _masks, ...r }) => r),
        roomPreferences: Object.entries(rooms)
          .filter(([no, name]) => name.trim() && usedRooms.includes(Number(no)))
          .map(([no, name]) => ({ requestedRoomNo: Number(no), preferredCoworkerName: name.trim(), note: null })),
      });
      onDone(a.modifySaved);
      router.push(detailUrl);
    } catch (err) {
      setError(adminError(err));
      window.scrollTo({ top: 0 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-panel">
      {back}
      <h2>{a.modifyRegistration}</h2>
      <p className="muted">{a.modifyHint}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <form className="admin-reg-grid" onSubmit={save}>
        <div className="admin-form admin-modify-form">
          <label className="field">
            <span>{a.modifySession}</span>
            <select value={sessionId} onChange={(e) => changeSession(e.target.value)}>
              {data.availability.map((s) => <option key={s.id} value={s.id}>{a.modifySessionOption(s.name, s.remaining)}</option>)}
            </select>
          </label>
          {rows.map((row, index) => {
            const type = data.travelerTypes.find((t) => t.id === row.travelerTypeId);
            return (
              <fieldset key={row.key} className="admin-card admin-modify-traveler">
                <div className="admin-modify-head span-all">
                  <h3>{a.modifyTraveler(index + 1)}</h3>
                  {rows.length > 1 && !type?.isEmployeeSelf && <button type="button" className="link" onClick={() => setRows(rows.filter((r) => r.key !== row.key))}>{a.modifyRemove}</button>}
                </div>
                <label className="field"><span>{a.modifyName}</span><input type="text" required maxLength={100} value={row.name} onChange={(e) => setRow(row.key, { name: e.target.value })} /></label>
                <label className="field">
                  <span>{a.modifyType}</span>
                  <select value={row.travelerTypeId} onChange={(e) => setRow(row.key, { travelerTypeId: e.target.value })}>
                    {data.travelerTypes.map((t) => <option key={t.id} value={t.id}>{t.name} {money(t.basePrice)}</option>)}
                  </select>
                </label>
                {!!session?.roomTypes.length && occupiesBed(row.travelerTypeId) && (
                  <label className="field">
                    <span>{a.modifyRoomType}</span>
                    <select required value={row.roomTypeId ?? ''} onChange={(e) => setRow(row.key, { roomTypeId: e.target.value || null })}>
                      <option value="">{a.modifyRoomChoose}</option>
                      {session.roomTypes.map((r) => <option key={r.id} value={r.id}>{r.name}{r.surcharge ? ` +${money(r.surcharge)}` : ''}</option>)}
                    </select>
                  </label>
                )}
                <label className="field">
                  <span>{a.modifyRoomNo}</span>
                  <select value={row.requestedRoomNo} onChange={(e) => setRow(row.key, { requestedRoomNo: Number(e.target.value) })}>
                    {rows.map((_, i) => <option key={i} value={i + 1}>{a.modifyRoomN(i + 1)}</option>)}
                  </select>
                </label>
                {data.fields.map((f) => <FieldEdit key={f.key} field={f} row={row} onChange={(v) => setRow(row.key, { fieldValues: { ...row.fieldValues, [f.key]: v } })} />)}
                {data.optionGroups.map((group) => {
                  const first = group.options.find((o) => row.optionIds.includes(o.id));
                  const chosen = row.preferences[group.id] ?? [];
                  return (
                    <fieldset key={group.id} className="span-all">
                      <legend>{group.name}</legend>
                      <div className="admin-radio-row">
                        {group.options.map((o) => (
                          <label key={o.id}>
                            <input type={group.maxSelect === 1 ? 'radio' : 'checkbox'} name={`${row.key}-${group.id}`} checked={row.optionIds.includes(o.id)} onClick={() => { if (group.maxSelect === 1 && row.optionIds.includes(o.id)) toggleOption(row, group, o.id); }} onChange={() => { if (group.maxSelect !== 1 || !row.optionIds.includes(o.id)) toggleOption(row, group, o.id); }} />
                            {o.name}{o.price ? ` +${money(o.price)}` : ''}
                          </label>
                        ))}
                      </div>
                      {group.preferenceCount > 1 && first && Array.from({ length: group.preferenceCount - 1 }, (_, i) => i).filter((i) => i <= chosen.length).map((i) => (
                        <label key={i} className="field">
                          <span>{a.modifyPreference(i + 2)}</span>
                          <select value={chosen[i] ?? ''} onChange={(e) => setRow(row.key, { preferences: { ...row.preferences, [group.id]: e.target.value ? [...chosen.slice(0, i), e.target.value] : chosen.slice(0, i) } })}>
                            <option value="">{a.modifyPreferenceNone}</option>
                            {group.options.filter((o) => o.id !== first.id && !chosen.slice(0, i).includes(o.id)).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                          </select>
                        </label>
                      ))}
                    </fieldset>
                  );
                })}
              </fieldset>
            );
          })}
          <div><button type="button" className="ghost" onClick={addTraveler}>{a.modifyAdd}</button></div>
          <fieldset className="admin-card">
            <legend className="sr-only">{a.modifyRooms}</legend>
            <h3>{a.modifyRooms}</h3>
            {usedRooms.map((no) => <label key={no} className="field"><span>{a.modifyCoworker(no)}</span><input type="text" maxLength={100} value={rooms[no] ?? ''} onChange={(e) => setRooms({ ...rooms, [no]: e.target.value })} /></label>)}
          </fieldset>
        </div>
        <div>
          <div className="admin-card">
            <dl>
              <div><dt>{a.modifyOriginal}</dt><dd>{money(data.registration.totalAmount)}</dd></div>
              <div><dt>{a.modifyNew}</dt><dd>{money(fees.total)}</dd></div>
              <div><dt>{a.corpSubsidy}</dt><dd>−{money(fees.subsidyApplied)}</dd></div>
              <div className="strong"><dt>{a.modifySelf}</dt><dd>{money(fees.selfPay)}</dd></div>
            </dl>
            {data.registration.paymentStatus === 'paid' && <small className="muted">{a.modifyPaidNote}</small>}
            <div className="admin-form-actions">
              <Link className="ghost-link" href={detailUrl}>{a.cancel}</Link>
              <button type="submit" className="primary" disabled={busy}>{busy ? a.saving : a.modifySave}</button>
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}

function FieldEdit({ field, row, onChange }: { field: RegistrationEditData['fields'][number]; row: Row; onChange: (v: string | string[]) => void }) {
  const mask = row.masks[field.key];
  const value = row.fieldValues[field.key];
  if (field.type === 'multiselect') {
    const picked: string[] = value ?? [];
    return (
      <fieldset className="span-all">
        <legend>{field.label}</legend>
        <div className="admin-radio-row">
          {(field.choices ?? []).map((c) => <label key={c}><input type="checkbox" checked={picked.includes(c)} onChange={() => onChange(picked.includes(c) ? picked.filter((x) => x !== c) : [...picked, c])} />{c}</label>)}
        </div>
      </fieldset>
    );
  }
  if (field.type === 'select') {
    return (
      <label className="field">
        <span>{field.label}</span>
        <select required={field.isRequired} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">{a.modifySelect}</option>
          {(field.choices ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
    );
  }
  return (
    <label className="field">
      <span>{field.label}</span>
      <input type={field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'} required={field.isRequired && !mask} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      {mask && <small>{a.modifySensitiveHint(mask)}</small>}
    </label>
  );
}
