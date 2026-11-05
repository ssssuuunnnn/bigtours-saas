'use client';

import type { EventNavKey } from '@bigtours/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { adminApi, type AdminEvent, type PublishCheck, type PublishCheckKey } from '../../../../lib/admin-api';
import { a } from '../../../../messages/admin';
import { adminError } from '../../admin-shell';

const SECTION: Record<PublishCheckKey, EventNavKey> = {
  basic: 'basic', heroImage: 'basic', schedule: 'schedule', sessions: 'sessions', types: 'types', options: 'options',
  fields: 'fields', terms: 'payment-terms', payment: 'payment-terms', contacts: 'contacts', roster: 'roster',
};

export function PublishPanel({ event, onPublished }: { event: AdminEvent; onPublished: () => void }) {
  const [checks, setChecks] = useState<PublishCheck[] | null>(null);
  const [freeConfirmed, setFreeConfirmed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => adminApi.publishCheck(event.id).then((r) => setChecks(r.checks)).catch((e) => setError(adminError(e))), [event.id]);
  useEffect(() => { void load(); }, [load]);

  if (!checks) return error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>;
  const isDraft = event.status === 'draft';
  const blocked = checks.filter((c) => c.state === 'block').length;
  const needsFree = checks.some((c) => c.state === 'confirm');
  const canPublish = blocked === 0 && (!needsFree || freeConfirmed);

  const publish = async () => {
    setError(null); setBusy(true);
    try {
      await adminApi.publish(event.id, freeConfirmed);
      setConfirming(false);
      onPublished();
      await load();
    } catch (err) {
      setConfirming(false);
      setError(adminError(err));
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-panel">
      <p className="muted">{a.publishUrl(`${window.location.origin}/${event.slug}`)}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <ul className="admin-checks">
        {checks.map((c) => (
          <li key={c.key}>
            <span className={`admin-check-state state-${c.state}`}>{a.publishStates[c.state]}</span>
            <div><strong>{a.publishNames[c.key]}</strong><p>{a.publishDetail(c.key, c.state, c.data)}</p></div>
            <Link href={`/admin/events/${event.id}/${SECTION[c.key]}`}>{a.goSetting}</Link>
          </li>
        ))}
      </ul>
      <div className="admin-publish">
        {isDraft ? (
          <>
            <p className={blocked ? 'admin-warn' : undefined} role="status">{blocked ? a.publishBlockedCount(blocked) : a.publishReady}</p>
            <p className="muted">{a.publishAfter}</p>
            {needsFree && (
              <label className="check">
                <input type="checkbox" checked={freeConfirmed} onChange={(e) => setFreeConfirmed(e.target.checked)} />
                <span>{a.confirmFreeFee}</span>
              </label>
            )}
            <div className="admin-publish-actions">
              <span />
              <button type="button" className="primary" disabled={!canPublish || busy} onClick={() => setConfirming(true)}>{a.publishAction}</button>
            </div>
          </>
        ) : (
          <p role="status"><strong>{a.publishedNote}</strong> {a.publishedOpenHint} <Link href={`/admin/events/${event.id}/schedule`}>{a.eventSections.schedule}</Link></p>
        )}
      </div>
      {confirming && (
        <div className="admin-modal">
          <div role="alertdialog" aria-modal="true" aria-labelledby="publish-title">
            <h2 id="publish-title">{a.publishConfirmTitle}</h2>
            <p>{a.publishConfirmBody}</p>
            <div className="admin-form-actions">
              <button type="button" className="ghost" autoFocus onClick={() => setConfirming(false)}>{a.cancel}</button>
              <button type="button" className="primary" disabled={busy} onClick={publish}>{a.publishAction}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
