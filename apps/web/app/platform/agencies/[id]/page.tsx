'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { platformApi, type PlatformAgency } from '../../../../lib/admin-api';
import { p } from '../../../../messages/platform';
import { platformError } from '../../platform-shell';

const money = (n: number) => `$${n.toLocaleString('en-US')}`;
const when = (iso: string) => new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export default function Page() {
  return <Suspense><Detail /></Suspense>;
}

function Detail() {
  const { id } = useParams<{ id: string }>();
  const created = useSearchParams().get('created');
  const [d, setD] = useState<PlatformAgency | null>(null);
  const [note, setNote] = useState<string | null>(created === 'ok' ? p.created : created === 'mail_failed' ? p.mailFailed : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [contract, setContract] = useState({ planNote: '', contractStartsOn: '', contractEndsOn: '' });
  const [tierId, setTierId] = useState('');
  const [change, setChange] = useState('');
  const [basis, setBasis] = useState('');

  const load = useCallback(() => platformApi.agency(id).then((a) => { setD(a); setTierId((t) => t || a.quota[0]?.id || ''); }).catch((e) => setError(platformError(e))), [id]);
  useEffect(() => { void load(); }, [load]);
  const back = <Link className="admin-back" href="/platform">{p.back}</Link>;
  if (!d) return <main className="admin-main">{back}{error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{p.loading}</p>}</main>;

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true); setNote(null); setError(null);
    try {
      await action();
      setNote(success);
      await load();
      return true;
    } catch (e) {
      setError(platformError(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const tierName = (min: number, max: number) => p.tierRange(min, max);

  return (
    <main className="admin-main">
      {back}
      <h1>{d.name}{d.isTrial && <span className="admin-badge">{p.trial.badge}</span>}</h1>
      <section className="admin-panel">
        <div className="admin-panel-head">
          <div>
            <p className="muted">{d.admin ? p.adminLine(d.code, d.admin.name, d.admin.email) : `${d.code}・${p.noAdmin}`}{' '}
              {d.admin && !d.suspended && <button type="button" className="link" disabled={busy} onClick={() => run(() => platformApi.sendAdminLink(d.id), p.adminLinkSent)}>{d.admin.activated ? p.resetAdmin : p.inviteAdmin}</button>}
            </p>
            <p className="muted">{p.states[d.state]}</p>
          </div>
          {d.suspended
            ? <button type="button" className="ghost" disabled={busy} onClick={() => run(() => platformApi.setStatus(d.id, 'active'), p.statusSaved)}>{p.resume}</button>
            : <button type="button" className="ghost" disabled={busy} onClick={() => { if (window.confirm(p.suspendConfirm(d.name))) void run(() => platformApi.setStatus(d.id, 'suspended'), p.statusSaved); }}>{p.suspend}</button>}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {note && <p className="admin-note" role="status">{note}</p>}
        {d.suspended && <p className="admin-note" role="status">{p.suspendedNote}</p>}
        {d.isTrial && (
          <div className="admin-email-actions">
            <span className="muted">{p.trial.detailTrial(d.taxId)}</span>
            <button type="button" className="ghost" disabled={busy} onClick={() => { if (window.confirm(p.trial.convertConfirm)) void run(() => platformApi.convertTrial(d.id), p.trial.converted); }}>{p.trial.convert}</button>
          </div>
        )}

        <div className="admin-card">
          {editing ? (
            <form className="admin-export-saveas" onSubmit={(e) => { e.preventDefault(); void run(() => platformApi.updateContract(d.id, contract), p.contractSaved).then((ok) => { if (ok) setEditing(false); }); }}>
              <label className="field"><span>{p.plan}</span><input type="text" required maxLength={200} value={contract.planNote} onChange={(e) => setContract({ ...contract, planNote: e.target.value })} /></label>
              <label className="field"><span>{p.startsOn}</span><input type="date" required value={contract.contractStartsOn} onChange={(e) => setContract({ ...contract, contractStartsOn: e.target.value })} /></label>
              <label className="field"><span>{p.endsOn}</span><input type="date" required min={contract.contractStartsOn || undefined} value={contract.contractEndsOn} onChange={(e) => setContract({ ...contract, contractEndsOn: e.target.value })} /></label>
              <button type="button" className="ghost" onClick={() => setEditing(false)}>{p.cancel}</button>
              <button type="submit" className="primary" disabled={busy}>{p.save}</button>
            </form>
          ) : (
            <div className="admin-email-actions">
              <span>{p.plan} <strong>{d.planNote ?? '—'}</strong>　{p.contractPeriod} <strong>{d.contractStartsOn ?? '—'}～{d.contractEndsOn ?? '—'}</strong></span>
              <button type="button" className="link" onClick={() => { setContract({ planNote: d.planNote ?? '', contractStartsOn: d.contractStartsOn ?? '', contractEndsOn: d.contractEndsOn ?? '' }); setEditing(true); }}>{p.editContract}</button>
            </div>
          )}
        </div>

        <h2>{p.quotaTitle}</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr>{Object.values(p.quotaCols).map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
            <tbody>
              {d.quota.map((q) => <tr key={q.id}><td>{tierName(q.minTravelers, q.maxTravelers)}</td><td>{money(q.price)}</td><td>{q.opened}</td><td>{q.used}</td><td>{q.remaining}</td></tr>)}
            </tbody>
          </table>
        </div>
        <form className="admin-card" onSubmit={(e) => { e.preventDefault(); void run(() => platformApi.adjustQuota(d.id, { tierId, change: Number(change), note: basis }), p.adjustSaved).then((ok) => { if (ok) { setChange(''); setBasis(''); } }); }}>
          <h2>{p.adjustTitle}</h2>
          <div className="admin-export-saveas">
            <label className="field"><span>{p.adjustTier}</span><select value={tierId} onChange={(e) => setTierId(e.target.value)}>{d.quota.map((q) => <option key={q.id} value={q.id}>{tierName(q.minTravelers, q.maxTravelers)}</option>)}</select></label>
            <label className="field"><span>{p.adjustChange}</span><input type="number" required min={-1000} max={1000} step={1} value={change} onChange={(e) => setChange(e.target.value)} /></label>
            <label className="field"><span>{p.adjustNote}</span><input type="text" required maxLength={200} value={basis} onChange={(e) => setBasis(e.target.value)} /></label>
            <button type="submit" className="primary" disabled={busy}>{p.adjustSubmit}</button>
          </div>
          <small className="muted">{p.adjustHint}</small>
        </form>

        <div className="admin-card">
          <h2>{p.lineTitle}</h2>
          <p className="muted">{p.lineHint}</p>
          {!d.line.configured ? <p className="muted">{p.lineNotConfigured}</p> : d.line.events.length === 0 ? <p className="muted">{p.lineNoEvents}</p> : (
            <ul className="admin-cell-list">
              {d.line.events.map((e) => <li key={e.id}>{p.lineEventLine(e.name, e.boundCount, e.enabled)}</li>)}
            </ul>
          )}
        </div>

        <div className="admin-card">
          <h2>{p.ledgerTitle}</h2>
          {d.ledger.length === 0 && <p className="muted">{p.ledgerNone}</p>}
          <ul className="admin-cell-list">
            {d.ledger.map((l) => <li key={l.id}><small className="muted">{when(l.at)}・{l.by ?? '—'}</small><br />{p.ledgerLine(tierName(l.minTravelers, l.maxTravelers), l.change)}・{l.note}</li>)}
          </ul>
        </div>
      </section>
    </main>
  );
}
