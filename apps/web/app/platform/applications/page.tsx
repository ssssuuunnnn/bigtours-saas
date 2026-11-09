'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { platformApi, type TrialApplication } from '../../../lib/admin-api';
import { p } from '../../../messages/platform';
import { platformError } from '../platform-shell';

const day = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

export default function PlatformApplications() {
  const [status, setStatus] = useState('pending');
  const [rows, setRows] = useState<TrialApplication[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    platformApi.trialApplications(status).then(setRows).catch((e) => setError(platformError(e)));
  }, [status]);
  useEffect(load, [load]);

  const change = async (id: string, next: TrialApplication['status']) => {
    setBusy(id); setError(null);
    try {
      await platformApi.setTrialStatus(id, next);
      load();
    } catch (e) {
      setError(platformError(e));
    } finally {
      setBusy(null);
    }
  };

  const createHref = (a: TrialApplication) =>
    `/platform/agencies/new?${new URLSearchParams({ name: a.agencyName, code: a.code, adminName: a.contactName, adminEmail: a.email }).toString()}`;

  return (
    <main className="admin-main">
      <h1>{p.nav.applications}</h1>
      <section className="admin-panel">
        <p className="muted">{p.trial.hint}</p>
        <div className="admin-filter" role="group" aria-label={p.trial.cols.status}>
          {Object.entries(p.trial.filters).map(([key, label]) => (
            <button key={key} type="button" className={status === key ? 'primary' : 'ghost'} aria-pressed={status === key} onClick={() => setStatus(key)}>{label}</button>
          ))}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {rows?.length === 0 && <p className="muted">{p.trial.none}</p>}
        {!!rows?.length && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr>{Object.values(p.trial.cols).map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.agencyName}</strong><br />
                      <small className="muted">{a.code}{a.codeTaken ? `（${p.trial.codeTaken}）` : ''}</small><br />
                      <small className="muted">{p.trial.applied(day(a.createdAt))}</small>
                      {a.note && <p className="muted">{p.trial.note}：{a.note}</p>}
                    </td>
                    <td>{a.contactName}<br /><small><a href={`mailto:${a.email}`}>{a.email}</a></small><br /><small><a href={`tel:${a.phone.replace(/[^0-9+]/g, '')}`}>{a.phone}</a></small></td>
                    <td className="admin-nowrap">{a.expectedSize}</td>
                    <td className="admin-nowrap">{p.trial.statuses[a.status]}{a.handledAt && <><br /><small className="muted">{p.trial.handled(day(a.handledAt), a.handledByName)}</small></>}</td>
                    <td>
                      <div className="admin-form-actions">
                        {a.status === 'pending' && !a.codeTaken && <Link className="primary-link" href={createHref(a)}>{p.trial.create}</Link>}
                        {a.status !== 'approved' && <button type="button" className="ghost" disabled={busy === a.id} onClick={() => change(a.id, 'approved')}>{p.trial.approve}</button>}
                        {a.status === 'pending' && <button type="button" className="ghost" disabled={busy === a.id} onClick={() => change(a.id, 'rejected')}>{p.trial.reject}</button>}
                        {a.status !== 'pending' && <button type="button" className="link" disabled={busy === a.id} onClick={() => change(a.id, 'pending')}>{p.trial.reopen}</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
