'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminApi, type DataLogPage, type DataLogRow } from '../../../lib/admin-api';
import { a } from '../../../messages/admin';
import { adminError } from '../admin-shell';

const when = (iso: string) => new Date(iso).toLocaleString('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

const target = (r: DataLogRow) => (r.action === 'registration.sensitive_viewed'
  ? a.dataLogTargetRegistration(r.employeeName ?? '', r.employeeNo ?? '', r.travelerCount ?? 0)
  : a.dataLogTargetExport(r.name ?? '', r.action === 'export_sensitive' ? r.sessionName : null, r.rows));

export function DataLogPanel() {
  const [event, setEvent] = useState('');
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [days, setDays] = useState('30');
  const [page, setPage] = useState<DataLogPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback((offset: number) => new URLSearchParams({ event, action, actor, days, offset: String(offset) }).toString(), [event, action, actor, days]);
  useEffect(() => {
    adminApi.dataLog(query(0)).then((p) => { setPage(p); setError(null); }).catch((e) => setError(adminError(e)));
  }, [query]);

  const more = async () => {
    if (!page) return;
    try {
      const next = await adminApi.dataLog(query(page.rows.length));
      setPage({ ...next, rows: [...page.rows, ...next.rows] });
    } catch (e) {
      setError(adminError(e));
    }
  };

  if (!page) return error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>;
  return (
    <section className="admin-panel">
      <p className="muted">{a.dataLogHint}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="admin-log-filters">
        <label className="field"><span>{a.dataLogEvent}</span>
          <select value={event} onChange={(e) => setEvent(e.target.value)}>
            <option value="">{a.dataLogEventAll}</option>
            {page.events.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <label className="field"><span>{a.dataLogAction}</span>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">{a.dataLogActionAll}</option>
            {Object.entries(a.dataLogActions).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="field"><span>{a.dataLogActor}</span>
          <select value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">{a.dataLogActorAll}</option>
            {page.actors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <label className="field"><span>{a.dataLogPeriod}</span>
          <select value={days} onChange={(e) => setDays(e.target.value)}>
            {Object.entries(a.dataLogPeriods).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      {page.rows.length === 0 ? <p className="muted">{a.dataLogEmpty}</p> : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th scope="col">{a.dataLogCols.at}</th><th scope="col">{a.dataLogCols.actor}</th><th scope="col">{a.dataLogCols.action}</th><th scope="col">{a.dataLogCols.event}</th><th scope="col">{a.dataLogCols.target}</th><th scope="col">{a.dataLogCols.fields}</th></tr></thead>
            <tbody>
              {page.rows.map((r) => (
                <tr key={r.id}>
                  <td className="admin-nowrap">{when(r.at)}</td>
                  <td>{r.actorName ?? '—'}</td>
                  <td>{a.dataLogActions[r.action]}</td>
                  <td>{r.eventName ?? '—'}</td>
                  <td>{target(r)}</td>
                  <td>{r.fields.join('、') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.hasMore && <div><button type="button" className="ghost" onClick={more}>{a.dataLogMore}</button></div>}
      <small className="muted">{a.dataLogFoot}</small>
    </section>
  );
}
