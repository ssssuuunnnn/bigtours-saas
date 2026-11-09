'use client';

import { useAgency } from '../../../../lib/agency';
import { useCallback, useEffect, useRef, useState } from 'react';
import { adminApi, type AgencySettings } from '../../../../lib/admin-api';
import { a } from '../../../../messages/admin';
import { adminError } from '../admin-shell';
import { CopyUrl } from '../line-link';

const MAX_BYTES = 5 * 1024 * 1024;

export function SettingsPanel() {
  const agency = useAgency();
  const [s, setS] = useState<AgencySettings | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const load = useCallback(() => adminApi.settings().then((r) => { setS(r); setName(r.name); }).catch((e) => setError(adminError(e))), []);
  useEffect(() => { void load(); }, [load]);
  if (!s) return error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setNote(null); setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(adminError(e));
    } finally {
      setBusy(false);
    }
  };
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0];
    e.target.value = '';
    if (!chosen) return;
    if (chosen.size > MAX_BYTES) { setError(a.errors.FILE_TOO_LARGE ?? a.errors.fallback!); return; }
    void run(() => adminApi.uploadLogo(chosen));
  };

  return (
    <section className="admin-panel">
      <p className="muted">{a.settingsHint}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="admin-note" role="status">{note}</p>}
      <div className="admin-card">
        <h2>{a.settingsBrand}</h2>
        <div>
          <span>{a.settingsLogo}</span>
          {s.logoUrl ? <img className="admin-settings-logo" src={s.logoUrl} alt={a.settingsLogoAlt(s.name)} /> : <p className="muted">{a.settingsLogoNone}</p>}
        </div>
        <div className="admin-file-row">
          <input ref={file} className="admin-file-input" type="file" accept="image/jpeg,image/png,image/webp" aria-label={a.settingsLogoChange} hidden onChange={pick} />
          <button type="button" className="ghost" disabled={busy} onClick={() => file.current?.click()}>{a.settingsLogoChange}</button>
          {s.logoUrl && <button type="button" className="link" disabled={busy} onClick={() => run(() => adminApi.removeLogo())}>{a.settingsLogoRemove}</button>}
          <small className="muted">{a.settingsLogoHint}</small>
        </div>
        <form className="admin-export-saveas" onSubmit={(e) => { e.preventDefault(); void run(() => adminApi.saveAgencyName(name)); }}>
          <label className="field"><span>{a.settingsName}</span><input type="text" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <button type="submit" className="primary" disabled={busy}>{a.save}</button>
        </form>
      </div>
      <LineSettings settings={s} onSaved={load} />
      <div className="admin-card">
        <h2>{a.settingsUrl}</h2>
        <p><code>{`${window.location.host}/${agency}`}</code></p>
        <small className="muted">{a.settingsUrlHint}</small>
      </div>
    </section>
  );
}

/** LINE Login Channel 與 LIFF 設定。兩個欄位一起設定，停用時一起清空。 */
function LineSettings({ settings, onSaved }: { settings: AgencySettings; onSaved: () => Promise<unknown> }) {
  const current = settings.line;
  const [channelId, setChannelId] = useState(current.channelId ?? '');
  const [liffId, setLiffId] = useState(current.liffId ?? '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const channelChanging = current.channelId !== null && channelId.trim() !== current.channelId;

  const save = async (v: { channelId: string | null; liffId: string | null }) => {
    setBusy(true); setNote(null); setError(null);
    try {
      const r = await adminApi.saveLine(v);
      if (r.clearedBindings > 0) setNote(a.line.cleared(r.clearedBindings));
      await onSaved();
    } catch (e) {
      setError(adminError(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (channelChanging && !window.confirm(a.line.channelChangeWarning)) return;
    void save({ channelId: channelId.trim(), liffId: liffId.trim() });
  };
  const disable = () => {
    if (!window.confirm(a.line.disableConfirm)) return;
    setChannelId(''); setLiffId('');
    void save({ channelId: null, liffId: null });
  };

  return (
    <div className="admin-card">
      <h2>{a.line.title}</h2>
      <p className="muted">{a.line.hint}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="admin-note" role="status">{note}</p>}
      <ol className="admin-line-steps">{a.line.setupSteps.map((step) => <li key={step}>{step}</li>)}</ol>
      <CopyUrl id="line-endpoint" label={a.line.endpointUrl} url={current.endpointUrl} />
      <form className="admin-form" onSubmit={submit}>
        <label className="field">
          <span>{a.line.channelId}</span>
          <input type="text" inputMode="numeric" required pattern="[0-9]{6,20}" maxLength={20} value={channelId} onChange={(e) => setChannelId(e.target.value)} />
          {channelChanging && <small className="error">{a.line.channelChangeWarning}</small>}
        </label>
        <label className="field">
          <span>{a.line.liffId}</span>
          <input type="text" required pattern="[0-9]{6,20}-[A-Za-z0-9]{4,32}" maxLength={60} placeholder="1234567890-AbCdEfGh" value={liffId} onChange={(e) => setLiffId(e.target.value)} />
        </label>
        <div className="admin-form-actions span-3">
          {current.channelId && <button type="button" className="link" disabled={busy} onClick={disable}>{a.line.disable}</button>}
          <button type="submit" className="primary" disabled={busy}>{busy ? a.saving : a.save}</button>
        </div>
      </form>
      {current.sharedUrl && (
        <>
          <CopyUrl id="line-shared" label={a.line.sharedUrl} url={current.sharedUrl} />
          <small className="muted">{a.line.sharedHint}</small>
        </>
      )}
    </div>
  );
}
