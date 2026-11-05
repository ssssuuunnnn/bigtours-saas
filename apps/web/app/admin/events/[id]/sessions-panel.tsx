'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminApi, type AdminEvent, type AdminSession, type RoomTypeValues, type SessionValues } from '../../../../lib/admin-api';
import { a } from '../../../../messages/admin';
import { adminError, MoveButtons, swapped } from '../../admin-shell';

const EMPTY: SessionValues = { name: '', departsOn: '', returnsOn: '', departureTime: '', returnArrivalTime: '', outboundFlightNo: '', returnFlightNo: '', capacity: 0, roomTypes: [] };
const EMPTY_ROOM: RoomTypeValues = { id: null, name: '', capacity: 2, surcharge: 0, bedQuota: 0 };

export function SessionsPanel({ event }: { event: AdminEvent }) {
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [editing, setEditing] = useState<AdminSession | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => adminApi.sessions(event.id).then(setSessions).catch((e) => setError(adminError(e))), [event.id]);
  useEffect(() => { void load(); }, [load]);

  if (!sessions) return error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>;
  const total = sessions.reduce((sum, s) => sum + s.capacity, 0);

  const move = async (i: number, j: number) => {
    setError(null);
    const next = swapped(sessions, i, j);
    setSessions(next);
    await adminApi.orderSessions(event.id, next.map((s) => s.id)).catch((e) => { setError(adminError(e)); return load(); });
  };
  const remove = async (s: AdminSession) => {
    if (!window.confirm(a.confirmRemove(s.name))) return;
    setError(null);
    await adminApi.deleteSession(event.id, s.id).then(load).catch((e) => setError(adminError(e)));
  };

  return (
    <section className="admin-panel">
      <div className="admin-panel-head">
        <p className="muted">{a.sessionsHint(event.tierMax, total)}</p>
        <button type="button" className="primary" onClick={() => setEditing('new')}>{a.addSession}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {editing && (
        <SessionForm
          event={event}
          session={editing === 'new' ? null : editing}
          sessions={sessions}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
      {sessions.length === 0 ? <p className="muted">{a.noSessions}</p> : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">{a.order}</th><th scope="col">{a.sessionName}</th><th scope="col">{a.outbound}</th>
                <th scope="col">{a.inbound}</th><th scope="col">{a.capacity}</th><th scope="col">{a.sessionRooms}</th><th scope="col">{a.actions}</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s, i) => (
                <tr key={s.id}>
                  <td><MoveButtons name={s.name} canUp={i > 0} canDown={i < sessions.length - 1} onUp={() => move(i, i - 1)} onDown={() => move(i, i + 1)} /></td>
                  <td><strong>{s.name}</strong></td>
                  <td>{s.departsOn} {s.departureTime}{s.outboundFlightNo ? ` ${s.outboundFlightNo}` : ''}</td>
                  <td>{s.returnsOn} {s.returnArrivalTime}{s.returnFlightNo ? ` ${s.returnFlightNo}` : ''}</td>
                  <td>{s.capacity}<br /><small className="muted admin-nowrap">{a.sold(s.soldCount)}</small></td>
                  <td>{s.roomTypes.length ? s.roomTypes.map((r) => r.name).join('、') : <span className="muted">—</span>}</td>
                  <td className="admin-actions">
                    <button type="button" className="link" onClick={() => setEditing(s)}>{a.edit}</button>
                    <button type="button" className="link" onClick={() => remove(s)}>{a.remove}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SessionForm({ event, session, sessions, onCancel, onSaved }: { event: AdminEvent; session: AdminSession | null; sessions: AdminSession[]; onCancel: () => void; onSaved: () => void }) {
  const [v, setV] = useState<SessionValues>(session ?? EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = (key: keyof SessionValues) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [key]: e.target.value });

  const rooms = v.roomTypes;
  const setRoom = (i: number, patch: Partial<RoomTypeValues>) => setV({ ...v, roomTypes: rooms.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const beds = rooms.reduce((sum, r) => sum + r.bedQuota, 0);
  const sources = sessions.filter((s) => s.id !== session?.id && s.roomTypes.length > 0);
  /** 只帶入還沒有的房型，帶入後可再調整，按儲存才生效。 */
  const copyFrom = (id: string) => {
    const source = sessions.find((s) => s.id === id);
    if (!source) return;
    const added = source.roomTypes
      .filter((r) => !rooms.some((mine) => mine.name === r.name))
      .map(({ name, capacity, surcharge, bedQuota }) => ({ id: null, name, capacity, surcharge, bedQuota }));
    setV({ ...v, roomTypes: [...rooms, ...added] });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (session) await adminApi.updateSession(event.id, session.id, v);
      else await adminApi.createSession(event.id, v);
      onSaved();
    } catch (err) {
      setError(adminError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="admin-form" onSubmit={submit}>
      {error && <p className="error" role="alert">{error}</p>}
      <label className="field span-3"><span>{a.sessionName}</span><input type="text" required maxLength={100} placeholder={a.sessionNamePlaceholder} value={v.name} onChange={text('name')} /></label>
      <label className="field"><span>{a.departsOn}</span><input type="date" required value={v.departsOn} onChange={text('departsOn')} /></label>
      <label className="field"><span>{a.departureTime}</span><input type="time" required value={v.departureTime} onChange={text('departureTime')} /></label>
      <label className="field"><span>{a.outboundFlight}</span><input type="text" maxLength={20} placeholder={a.flightPlaceholder} value={v.outboundFlightNo ?? ''} onChange={text('outboundFlightNo')} /></label>
      <label className="field"><span>{a.returnsOn}</span><input type="date" required value={v.returnsOn} onChange={text('returnsOn')} /><small>{a.returnsHint}</small></label>
      <label className="field"><span>{a.returnArrivalTime}</span><input type="time" required value={v.returnArrivalTime} onChange={text('returnArrivalTime')} /></label>
      <label className="field"><span>{a.returnFlight}</span><input type="text" maxLength={20} placeholder={a.flightPlaceholder} value={v.returnFlightNo ?? ''} onChange={text('returnFlightNo')} /></label>
      <label className="field"><span>{a.capacity}</span><input type="number" required min={0} max={5000} value={v.capacity} onChange={(e) => setV({ ...v, capacity: Number(e.target.value) })} /></label>
      <fieldset className="span-3">
        <legend>{a.roomTypesTitle}</legend>
        <div className="admin-rooms-tools">
          {sources.length > 0 && (
            <label className="admin-inline-field">
              <span>{a.copyRoomTypes}</span>
              <select value="" onChange={(e) => copyFrom(e.target.value)}>
                <option value="">{a.copyRoomTypesPick}</option>
                {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          <button type="button" className="link" onClick={() => setV({ ...v, roomTypes: [...rooms, EMPTY_ROOM] })}>{a.addRoomType}</button>
        </div>
        {rooms.length === 0 ? <small className="muted">{a.noRoomTypes}</small> : (
          <div className="admin-table-wrap">
            <table className="admin-table admin-edit-table">
              <thead><tr><th scope="col">{a.order}</th><th scope="col">{a.roomTypeName}</th><th scope="col">{a.roomCapacity}</th><th scope="col">{a.roomSurcharge}</th><th scope="col">{a.roomBeds}</th><th scope="col">{a.actions}</th></tr></thead>
              <tbody>
                {rooms.map((r, i) => (
                  <tr key={i}>
                    <td><MoveButtons name={r.name || a.roomLabel(a.roomTypeName, i)} canUp={i > 0} canDown={i < rooms.length - 1} onUp={() => setV({ ...v, roomTypes: swapped(rooms, i, i - 1) })} onDown={() => setV({ ...v, roomTypes: swapped(rooms, i, i + 1) })} /></td>
                    <td><input aria-label={a.roomLabel(a.roomTypeName, i)} type="text" required maxLength={50} value={r.name} onChange={(e) => setRoom(i, { name: e.target.value })} /></td>
                    <td><input aria-label={a.roomLabel(a.roomCapacity, i)} type="number" required min={1} max={20} value={r.capacity} onChange={(e) => setRoom(i, { capacity: Number(e.target.value) })} /></td>
                    <td><input aria-label={a.roomLabel(a.roomSurcharge, i)} type="number" required min={0} max={10000000} value={r.surcharge} onChange={(e) => setRoom(i, { surcharge: Number(e.target.value) })} /></td>
                    <td>
                      <input aria-label={a.roomLabel(a.roomBeds, i)} type="number" required min={r.soldCount ?? 0} max={5000} value={r.bedQuota} onChange={(e) => setRoom(i, { bedQuota: Number(e.target.value) })} />
                      {(r.soldCount ?? 0) > 0 && <small className="muted">{a.roomSold(r.soldCount!)}</small>}
                    </td>
                    <td className="admin-actions"><button type="button" className="link" disabled={(r.soldCount ?? 0) > 0} onClick={() => setV({ ...v, roomTypes: rooms.filter((_, j) => j !== i) })}>{a.remove}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rooms.length > 0 && beds < v.capacity && <p className="admin-note" role="status">{a.bedsShort(beds, v.capacity)}</p>}
      </fieldset>
      <div className="admin-form-actions span-3">
        <button type="button" className="ghost" onClick={onCancel}>{a.cancel}</button>
        <button type="submit" className="primary" disabled={busy}>{busy ? a.saving : a.save}</button>
      </div>
    </form>
  );
}
