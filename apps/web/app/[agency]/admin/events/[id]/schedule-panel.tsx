'use client';

import { useState } from 'react';
import { adminApi, type AdminEvent } from '../../../../../lib/admin-api';
import { a } from '../../../../../messages/admin';
import { adminError } from '../../admin-shell';

/** datetime-local 的值是當地時間，存到後端前轉成 ISO。 */
const toLocal = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const toIso = (local: string) => (local ? new Date(local).toISOString() : null);

export function SchedulePanel({ event, onSaved }: { event: AdminEvent; onSaved: () => void }) {
  const [pageMode, setPageMode] = useState(event.pageMode);
  const [pageOpensAt, setPageOpensAt] = useState(toLocal(event.pageOpensAt));
  const [pageClosesAt, setPageClosesAt] = useState(toLocal(event.pageClosesAt));
  const [regOpensAt, setRegOpensAt] = useState(toLocal(event.registrationOpensAt));
  const [regClosesAt, setRegClosesAt] = useState(toLocal(event.registrationClosesAt));
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const fail = (err: unknown) => setError(adminError(err));
  const orderBad = (from: string, to: string) => from && to && to <= from;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if ((pageMode === 'scheduled' && orderBad(pageOpensAt, pageClosesAt)) || orderBad(regOpensAt, regClosesAt)) { setError(a.timeOrder); return; }
    setBusy(true);
    try {
      await adminApi.updateSchedule(event.id, {
        pageMode,
        pageOpensAt: toIso(pageOpensAt),
        pageClosesAt: toIso(pageClosesAt),
        registrationOpensAt: toIso(regOpensAt),
        registrationClosesAt: toIso(regClosesAt),
      });
      onSaved();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const setOpen = async (open: boolean) => {
    setError(null);
    setBusy(true);
    try {
      await adminApi.setPageOpen(event.id, open);
      setConfirming(false);
      onSaved();
    } catch (err) {
      setConfirming(false);
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const savedManual = event.pageMode === 'manual';
  return (
    <form className="admin-form" onSubmit={submit}>
      {error && <p className="error span-3" role="alert">{error}</p>}

      <fieldset className="span-3">
        <legend>{a.pageSwitch}</legend>
        <div className="admin-switch">
          <strong>{a.pageNow(a.pageStates[event.pageState])}</strong>
          {savedManual && (event.pageState === 'open'
            ? <button type="button" className="danger" onClick={() => setConfirming(true)}>{a.closeNow}</button>
            : <button type="button" className="primary" disabled={busy || event.status === 'draft'} onClick={() => setOpen(true)}>{a.openNow}</button>)}
        </div>
        <small className="muted">{event.status === 'draft' ? a.pageDraftHint : a.pageHint}</small>
        <div className="admin-tiers">
          {(['manual', 'scheduled'] as const).map((m) => (
            <label key={m} className={`choice${pageMode === m ? ' on' : ''}`}>
              <input type="radio" name="page-mode" checked={pageMode === m} onChange={() => setPageMode(m)} />
              <span>{a.pageModes[m]}</span>
            </label>
          ))}
        </div>
        {pageMode === 'scheduled' && (
          <div className="admin-tiers">
            <label className="field"><span>{a.pageOpensAt}</span><input type="datetime-local" required value={pageOpensAt} onChange={(e) => setPageOpensAt(e.target.value)} /></label>
            <label className="field"><span>{a.pageClosesAt}</span><input type="datetime-local" required value={pageClosesAt} onChange={(e) => setPageClosesAt(e.target.value)} /><small className="muted">{a.pageCloseHint}</small></label>
          </div>
        )}
      </fieldset>

      <fieldset className="span-3">
        <legend>{a.registrationPeriod}</legend>
        <small className="muted">{a.registrationHint}</small>
        <div className="admin-tiers">
          <label className="field"><span>{a.registrationOpensAt}</span><input type="datetime-local" value={regOpensAt} onChange={(e) => setRegOpensAt(e.target.value)} /></label>
          <label className="field"><span>{a.registrationClosesAt}</span><input type="datetime-local" value={regClosesAt} onChange={(e) => setRegClosesAt(e.target.value)} /></label>
        </div>
      </fieldset>

      <div className="admin-form-actions span-3">
        <button type="submit" className="primary" disabled={busy}>{a.save}</button>
      </div>

      {confirming && (
        <div className="admin-modal">
          <div role="alertdialog" aria-modal="true" aria-labelledby="close-title">
            <h2 id="close-title">{a.closeConfirmTitle}</h2>
            <p>{a.closeConfirmBody}</p>
            {event.activeHolds > 0 && <p className="admin-note"><strong>{a.closeConfirmHolds(event.activeHolds)}</strong><br />{a.closeConfirmHoldsHint}</p>}
            <div className="admin-form-actions">
              <button type="button" className="danger" disabled={busy} onClick={() => setOpen(false)}>{a.confirmClose}</button>
              <button type="button" className="ghost" autoFocus onClick={() => setConfirming(false)}>{a.cancel}</button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
