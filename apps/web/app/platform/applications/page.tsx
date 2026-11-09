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
  const [notice, setNotice] = useState<string | null>(null);
  const [auto, setAuto] = useState<boolean | null>(null);

  const load = useCallback(() => {
    platformApi.trialApplications(status).then(setRows).catch((e) => setError(platformError(e)));
  }, [status]);
  useEffect(load, [load]);
  useEffect(() => { platformApi.settings().then((s) => setAuto(s.trialAutoApprove)).catch((e) => setError(platformError(e))); }, []);

  const run = async (id: string, fn: () => Promise<string | null>) => {
    setBusy(id); setError(null); setNotice(null);
    try {
      setNotice(await fn());
      load();
    } catch (e) {
      setError(platformError(e));
    } finally {
      setBusy(null);
    }
  };
  const change = (id: string, next: 'pending' | 'rejected') => run(id, async () => { await platformApi.setTrialStatus(id, next); return null; });
  const approve = (id: string) => run(id, async () => p.trial.approved((await platformApi.approveTrial(id)).mailFailed));
  const toggleAuto = async (on: boolean) => {
    setError(null);
    try {
      await platformApi.saveSettings({ trialAutoApprove: on });
      setAuto(on);
    } catch (e) {
      setError(platformError(e));
    }
  };

  return (
    <main className="admin-main">
      <h1>{p.nav.applications}</h1>
      <section className="admin-panel">
        <p className="muted">{p.trial.hint}</p>
        {auto !== null && (
          <label className="admin-check">
            <input type="checkbox" checked={auto} onChange={(e) => void toggleAuto(e.target.checked)} />
            <span><strong>{p.trial.autoApprove}</strong>　{auto ? p.trial.autoApproveOn : p.trial.autoApproveOff}</span>
          </label>
        )}
        <div className="admin-filter" role="group" aria-label={p.trial.cols.status}>
          {Object.entries(p.trial.filters).map(([key, label]) => (
            <button key={key} type="button" className={status === key ? 'primary' : 'ghost'} aria-pressed={status === key} onClick={() => setStatus(key)}>{label}</button>
          ))}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
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
                      <small className="muted">{a.code}{a.codeTaken && a.status !== 'approved' ? `（${p.trial.codeTaken}）` : ''}</small><br />
                      {a.taxId && <><small className="muted">{p.trial.taxId} {a.taxId}</small><br /></>}
                      <small className="muted">{p.trial.applied(day(a.createdAt))}</small>
                      {a.note && <p className="muted">{p.trial.note}：{a.note}</p>}
                    </td>
                    <td>{a.contactName}<br /><small><a href={`mailto:${a.email}`}>{a.email}</a></small><br /><small><a href={`tel:${a.phone.replace(/[^0-9+]/g, '')}`}>{a.phone}</a></small></td>
                    <td className="admin-nowrap">{a.expectedSize}</td>
                    <td className="admin-nowrap">{p.trial.statuses[a.status]}{a.handledAt && <><br /><small className="muted">{p.trial.handled(day(a.handledAt), a.handledByName)}</small></>}</td>
                    <td>
                      <div className="admin-form-actions">
                        {a.status === 'pending' && !a.codeTaken && <button type="button" className="primary" disabled={busy === a.id} onClick={() => approve(a.id)}>{p.trial.approve}</button>}
                        {(a.status === 'pending' || a.status === 'unverified') && <button type="button" className="ghost" disabled={busy === a.id} onClick={() => change(a.id, 'rejected')}>{p.trial.reject}</button>}
                        {a.status === 'rejected' && a.verifiedAt && <button type="button" className="link" disabled={busy === a.id} onClick={() => change(a.id, 'pending')}>{p.trial.reopen}</button>}
                        {a.status === 'approved' && (a.agencyId ? <Link className="primary-link" href={`/platform/agencies/${a.agencyId}`}>{p.trial.openAgency}</Link> : <small className="muted">{p.trial.agencyDeleted}</small>)}
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
