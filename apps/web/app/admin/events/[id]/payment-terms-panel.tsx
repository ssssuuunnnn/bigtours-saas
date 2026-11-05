'use client';

import { useState } from 'react';
import { adminApi, type AdminEvent } from '../../../../lib/admin-api';
import { a } from '../../../../messages/admin';
import { adminError } from '../../admin-shell';

const MAX_BYTES = 10 * 1024 * 1024;

export function PaymentTermsPanel({ event, onSaved }: { event: AdminEvent; onSaved: () => void }) {
  const [payment, setPayment] = useState(event.paymentInstructions ?? '');
  const [retention, setRetention] = useState(event.retentionDays);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setNote(null); setBusy(true);
    try {
      await adminApi.savePaymentTerms(event.id, { paymentInstructions: payment || null, retentionDays: retention });
      setNote(a.saved);
      onSaved();
    } catch (err) {
      setError(adminError(err));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null); setNote(null);
    if (file.size > MAX_BYTES) { setError(a.errors.FILE_TOO_LARGE!); return; }
    if (event.termsFileName && event.hasRegistrations && !window.confirm(a.termsReplaceConfirm)) return;
    setUploading(true);
    try {
      await adminApi.uploadTerms(event.id, file);
      setNote(a.termsUploaded);
      onSaved();
    } catch (err) {
      setError(adminError(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <form className="admin-form" onSubmit={submit}>
      {error && <p className="error span-3" role="alert">{error}</p>}
      {note && <p className="admin-note span-3" role="status">{note}</p>}
      <label className="field span-3">
        <span>{a.paymentTitle}</span>
        <textarea rows={4} maxLength={2000} placeholder={a.paymentPlaceholder} value={payment} onChange={(e) => setPayment(e.target.value)} />
        <small className="muted">{a.paymentHint}</small>
      </label>

      <fieldset className="span-3">
        <legend>{a.termsTitle}</legend>
        <small className="muted">{a.termsHint}</small>
        <div className="admin-file">
          {event.termsFileName
            ? <span>{a.termsCurrent(event.termsFileName, event.termsVersion)} <a href={`/api/v1/agency/events/${event.id}/terms`} target="_blank" rel="noopener">{a.termsView}</a></span>
            : <p className="admin-warn">{a.termsMissing}</p>}
          <input id="terms-file" type="file" accept="application/pdf,.pdf" disabled={uploading} onChange={upload} />
          <label htmlFor="terms-file" className="ghost-button">{uploading ? a.termsUploading : event.termsFileName ? a.termsReplace : a.termsUpload}</label>
        </div>
      </fieldset>

      <fieldset className="span-3">
        <legend>{a.retentionTitle}</legend>
        <div className="admin-inline-number">
          <label htmlFor="retention">{a.retentionBefore}</label>
          <input id="retention" type="number" required min={1} max={3650} value={retention} onChange={(e) => setRetention(Number(e.target.value))} />
          <span>{a.retentionAfter}</span>
        </div>
      </fieldset>

      <div className="admin-form-actions span-3">
        <button type="submit" className="primary" disabled={busy}>{busy ? a.saving : a.save}</button>
      </div>
    </form>
  );
}
