'use client';

import { AgencyLink as Link } from '../../../../../lib/agency';
import { useCallback, useEffect, useState } from 'react';
import { adminApi, type AdminEvent, type RoomOverview, type RoomSessionView, type RoomView } from '../../../../../lib/admin-api';
import { a } from '../../../../../messages/admin';
import { adminError } from '../../admin-shell';

const when = (iso: string) => new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export function RoomsPanel({ event }: { event: AdminEvent }) {
  const [data, setData] = useState<RoomOverview | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => adminApi.rooms(event.id, sessionId).then(setData).catch((e) => setError(adminError(e))), [event.id, sessionId]);
  useEffect(() => { void load(); }, [load]);

  if (!data) return error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>;
  if (!data.session) return <p className="muted">{a.roomsNoSessions}</p>;
  const s = data.session;

  /** 操作失敗時也重新載入，畫面才會和伺服器一致。 */
  const run = async (action: () => Promise<string | null | void>) => {
    setBusy(true); setError(null); setNote(null);
    try {
      setNote((await action()) ?? null);
    } catch (e) {
      setError(adminError(e));
    } finally {
      await load();
      setBusy(false);
    }
  };

  const unassignedCount = s.stats.total - s.stats.assigned;
  const canPublish = s.stats.total > 0 && unassignedCount === 0 && s.stats.over === 0;
  const changes = s.publication?.changes ?? [];
  const publish = () => run(async () => a.roomsPublished((await adminApi.publishRooms(event.id, s.id)).notified));

  return (
    <section className="admin-panel">
      <div className="admin-panel-head">
        <p className="muted">{a.roomsHint}</p>
        <label className="admin-inline-field">
          <span>{a.roomsSession}</span>
          <select value={s.id} onChange={(e) => { setNote(null); setError(null); setSessionId(e.target.value); }}>
            {data.sessions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="admin-note" role="status">{note}</p>}
      <div className="admin-stat-cards">
        <div><span>{a.roomsAssigned}</span><strong>{a.roomsAssignedValue(s.stats.assigned, s.stats.total)}</strong></div>
        <div><span>{a.roomsOver}</span><strong>{a.roomsCount(s.stats.over)}</strong></div>
        <div><span>{a.roomsUnder}</span><strong>{a.roomsCount(s.stats.under)}</strong></div>
        <div><span>{a.roomsWishes}</span><strong>{a.roomsWishCount(s.stats.wishes)}</strong></div>
      </div>
      <div className="admin-rooms-grid">
        <section>
          <div className="admin-panel-head">
            <h2>{a.roomsList}</h2>
            <button type="button" className="ghost" disabled={busy || unassignedCount === 0} onClick={() => run(async () => { const r = await adminApi.draftRooms(event.id, s.id); return a.roomsDrafted(r.created, r.placed); })}>{a.roomsDraft}</button>
          </div>
          {s.rooms.length === 0 && <p className="muted">{a.roomsEmpty}</p>}
          {s.rooms.map((room) => <RoomCard key={room.id} event={event} session={s} room={room} busy={busy} run={run} />)}
          <AddRoom event={event} session={s} busy={busy} run={run} />
        </section>
        <section>
          <h2>{a.roomsUnassignedTitle}</h2>
          {s.unassigned.length === 0 && <p className="muted">{a.roomsUnassignedNone}</p>}
          {s.unassigned.map((g) => {
            const names = g.travelers.map((t) => t.name).join('、');
            return (
              <div className="admin-room" key={g.key}>
                <div><strong>{names}</strong>{g.selectedRoom && `・${g.selectedRoom}`}</div>
                <p className="admin-room-note">{g.wish ? a.roomsWish(g.wish) : a.roomsNoWish}</p>
                <label>
                  <span className="sr-only">{a.roomsAssignTo(names)}</span>
                  <select value="" disabled={busy} onChange={(e) => { const roomId = e.target.value; if (roomId) void run(() => adminApi.assignRoom(event.id, s.id, roomId, g.travelers.map((t) => t.id))); }}>
                    <option value="">{a.roomsAssignChoose}</option>
                    {s.rooms.map((r) => <option key={r.id} value={r.id}>{r.label}{r.typeName ? ` ${r.typeName}` : ''}（{a.roomsPeople(r.beds, r.capacity)}）</option>)}
                  </select>
                </label>
              </div>
            );
          })}
        </section>
      </div>

      {s.publication && changes.length > 0 && (
        <div className="admin-card">
          <p className="admin-note" role="status">{a.roomsChanged(changes.length)}</p>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th scope="col">{a.roomsChangeCols.room}</th><th scope="col">{a.roomsChangeCols.before}</th><th scope="col">{a.roomsChangeCols.after}</th></tr></thead>
              <tbody>
                {changes.map((c) => <tr key={c.label}><td><strong>{c.label}</strong>{c.typeName ? ` ${c.typeName}` : ''}</td><td>{c.before.join('、') || '—'}</td><td>{c.after.join('、') || '—'}</td></tr>)}
              </tbody>
            </table>
          </div>
          <small className="muted">{a.roomsRepublishHint}</small>
        </div>
      )}

      <div className="admin-rooms-footer">
        <p>
          {!canPublish && s.stats.total > 0 ? a.roomsBlocked(unassignedCount, s.stats.over) : s.publication ? (changes.length ? '' : a.roomsPublishedAt(when(s.publication.publishedAt))) : s.stats.total > 0 ? a.roomsPublishHint(s.notifyCount) : ''}
        </p>
        <Link className="ghost-link" href={`/admin/events/${event.id}/export?template=builtin:rooms&session=${s.id}`}>{a.roomsExport}</Link>
        {s.publication
          ? (changes.length > 0 && <button type="button" className="primary" disabled={busy || !canPublish} onClick={publish}>{a.roomsRepublish(s.notifyCount)}</button>)
          : <button type="button" className="primary" disabled={busy || !canPublish} onClick={publish}>{a.roomsPublish}</button>}
      </div>
    </section>
  );
}

type Run = (action: () => Promise<string | null | void>) => Promise<void>;

function RoomCard({ event, session, room, busy, run }: { event: AdminEvent; session: RoomSessionView; room: RoomView; busy: boolean; run: Run }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(room.label);
  const [roomTypeId, setRoomTypeId] = useState(room.roomTypeId ?? '');
  const [capacity, setCapacity] = useState(room.capacity);
  const [note, setNote] = useState(room.note ?? '');
  const others = session.rooms.filter((r) => r.id !== room.id);

  if (editing) {
    return (
      <form className="admin-room admin-room-form" onSubmit={(e) => { e.preventDefault(); setEditing(false); void run(() => adminApi.updateRoom(event.id, room.id, { label, roomTypeId: roomTypeId || null, capacity: roomTypeId ? undefined : capacity, note: note || null })); }}>
        <label className="field"><span>{a.roomsLabel}</span><input type="text" required maxLength={30} value={label} onChange={(e) => setLabel(e.target.value)} /></label>
        {session.roomTypes.length > 0 ? (
          <label className="field"><span>{a.roomsAddType}</span>
            <select required value={roomTypeId} onChange={(e) => setRoomTypeId(e.target.value)}>
              {session.roomTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        ) : <label className="field"><span>{a.roomsCapacity}</span><input type="number" required min={1} max={20} value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} /></label>}
        <label className="field"><span>{a.roomsNote}</span><input type="text" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <div className="admin-actions">
          <button type="button" className="ghost" onClick={() => setEditing(false)}>{a.cancel}</button>{' '}
          <button type="submit" className="primary">{a.save}</button>
        </div>
      </form>
    );
  }

  return (
    <div className={`admin-room ${room.status}`}>
      <div className="admin-room-head">
        <div><strong>{room.label}{room.typeName ? ` ${room.typeName}` : ''}</strong>・{a.roomsPeople(room.beds, room.capacity)}</div>
        <div className="admin-actions">
          <button type="button" className="link" onClick={() => setEditing(true)}>{a.roomsEdit}</button>
          <button type="button" className="link" disabled={busy} onClick={() => { if (window.confirm(a.roomsDeleteConfirm(room.label))) void run(() => adminApi.deleteRoom(event.id, room.id)); }}>{a.roomsDelete}</button>
        </div>
      </div>
      {room.note && <p className="admin-room-note">{room.note}</p>}
      <ul className="admin-room-members">
        {room.travelers.map((t) => (
          <li key={t.id}>
            <span>{t.name}<small className="muted">（{t.typeName}{t.occupiesBed ? '' : `・${a.roomsNoBed}`}）</small></span>
            <label>
              <span className="sr-only">{a.roomsMoveTo(t.name)}</span>
              <select value="" disabled={busy} onChange={(e) => { const v = e.target.value; if (v) void run(() => adminApi.assignRoom(event.id, session.id, v === 'out' ? null : v, [t.id])); }}>
                <option value="">{a.roomsMoveChoose}</option>
                {others.map((r) => <option key={r.id} value={r.id}>{r.label}{r.typeName ? ` ${r.typeName}` : ''}</option>)}
                <option value="out">{a.roomsMoveOut}</option>
              </select>
            </label>
          </li>
        ))}
      </ul>
      {room.status === 'over' && <p className="admin-room-note" role="status"><strong>{a.roomsOverNote(room.capacity)}</strong></p>}
      {room.status === 'under' && <p className="admin-room-note muted">{a.roomsUnderNote(room.capacity)}</p>}
      {room.status === 'empty' && <p className="admin-room-note muted">{a.roomsEmptyRoom}</p>}
      {room.mismatched.map((m) => <p className="admin-room-note" key={m.name}>{a.roomsMismatch(m.name, m.selectedRoom)}</p>)}
      {room.wishes.map((w) => <p className="admin-room-note muted" key={w}>{a.roomsWish(w)}</p>)}
    </div>
  );
}

function AddRoom({ event, session, busy, run }: { event: AdminEvent; session: RoomSessionView; busy: boolean; run: Run }) {
  const [roomTypeId, setRoomTypeId] = useState('');
  const [capacity, setCapacity] = useState(2);
  const typeId = roomTypeId || session.roomTypes[0]?.id || null;
  return (
    <form className="admin-room-add" onSubmit={(e) => { e.preventDefault(); void run(async () => { await adminApi.createRoom(event.id, { sessionId: session.id, roomTypeId: typeId, capacity: typeId ? undefined : capacity }); }); }}>
      {session.roomTypes.length > 0 ? (
        <label className="field"><span>{a.roomsAddType}</span>
          <select value={typeId ?? ''} onChange={(e) => setRoomTypeId(e.target.value)}>
            {session.roomTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      ) : <label className="field"><span>{a.roomsCapacity}</span><input type="number" required min={1} max={20} value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} /></label>}
      <button type="submit" className="ghost" disabled={busy}>{a.roomsAdd}</button>
    </form>
  );
}
