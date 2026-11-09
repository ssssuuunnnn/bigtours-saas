'use client';

import { useState } from 'react';
import { adminApi, type AdminEvent } from '../../../../lib/admin-api';
import { a } from '../../../../messages/admin';
import { adminError } from '../../admin-shell';
import { CopyUrl } from '../../line-link';

/** 活動的 LINE 入口開關，放在「開放時間」，和活動頁開關一起管理員工能否進入。 */
export function EventLinePanel({ event, onSaved }: { event: AdminEvent; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async (enabled: boolean) => {
    setBusy(true); setError(null);
    try {
      await adminApi.setEventLine(event.id, enabled);
      onSaved();
    } catch (e) {
      setError(adminError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="admin-card admin-line-card">
      <h2>{a.line.eventTitle}</h2>
      {!event.line.configured ? <p className="muted">{a.line.notConfigured}</p> : (
        <>
          <p className="muted">{a.line.eventHint}</p>
          {error && <p className="error" role="alert">{error}</p>}
          <label className="check">
            <input type="checkbox" checked={event.line.enabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} />
            <span>{a.line.eventEnabled}</span>
          </label>
          {event.line.url && <CopyUrl id="event-line-url-settings" label={a.line.eventUrl} url={event.line.url} />}
        </>
      )}
    </section>
  );
}
