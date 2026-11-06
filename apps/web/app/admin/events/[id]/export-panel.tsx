'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { adminApi, type AdminEvent, type ExportOverview, type ExportTemplate } from '../../../../lib/admin-api';
import { a } from '../../../../messages/admin';
import { adminError, useAdminMe } from '../../admin-shell';

const when = (iso: string) => new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const day = (iso: string) => new Date(iso).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' });

export function ExportPanel({ event }: { event: AdminEvent }) {
  const params = useSearchParams();
  const me = useAdminMe();
  const [data, setData] = useState<ExportOverview | null>(null);
  const [templateId, setTemplateId] = useState(params.get('template') ?? 'builtin:all');
  const [sessionId, setSessionId] = useState(params.get('session') ?? '');
  const [selected, setSelected] = useState<string[]>([]);
  const [saveName, setSaveName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = await adminApi.exports(event.id);
    setData(d);
    return d;
  }, [event.id]);

  useEffect(() => {
    load().then((d) => {
      const t = d.templates.find((x) => x.id === templateId) ?? d.templates[0]!;
      setTemplateId(t.id);
      setSelected(t.columns);
    }).catch((e) => setError(adminError(e)));
    // 只在第一次載入時帶入範本。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const processing = data?.jobs.some((j) => j.status === 'pending' || j.status === 'running');
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => void load().catch(() => undefined), 2000);
    return () => clearInterval(timer);
  }, [processing, load]);

  if (!data) return error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>;
  const template: ExportTemplate = data.templates.find((t) => t.id === templateId) ?? data.templates[0]!;
  const columns = data.catalog[template.scope];
  const pick = (id: string) => {
    const t = data.templates.find((x) => x.id === id)!;
    setTemplateId(id); setSelected(t.columns); setNote(null); setError(null); setSaveName(null);
  };
  const toggle = (key: string) => setSelected(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  const sensitive = columns.filter((c) => c.sensitive && selected.includes(c.key)).map((c) => c.label);

  const run = async (action: () => Promise<string | null | void>) => {
    setBusy(true); setNote(null); setError(null);
    try {
      setNote((await action()) ?? null);
      await load();
    } catch (e) {
      setError(adminError(e));
    } finally {
      setBusy(false);
    }
  };
  const generate = () => {
    if (!selected.length) { setError(a.exportChooseColumn); return; }
    void run(async () => {
      await adminApi.createExport(event.id, { name: template.name, scope: template.scope, sessionId: sessionId || null, columns: selected });
      return a.exportQueued;
    });
  };
  const saveTemplate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected.length) { setError(a.exportChooseColumn); return; }
    void run(async () => {
      const name = saveName!.trim();
      const { id } = await adminApi.saveExportTemplate(event.id, { name, scope: template.scope, columns: selected });
      setTemplateId(id);
      setSaveName(null);
      return a.exportTemplateSaved;
    });
  };
  const removeTemplate = () => {
    if (!window.confirm(a.exportTemplateDeleteConfirm(template.name))) return;
    void run(async () => {
      await adminApi.deleteExportTemplate(event.id, template.id);
      pick('builtin:all');
      return null;
    });
  };

  return (
    <section className="admin-panel">
      <p className="muted">{data.canExportSensitive ? a.exportHint : a.exportHintLimited}</p>
      <div className="admin-export-grid">
        <div className="admin-card">
          {error && <p className="error" role="alert">{error}</p>}
          {note && <p className="admin-note" role="status">{note}</p>}
          <label className="field">
            <span>{a.exportTemplate}</span>
            <select value={template.id} onChange={(e) => pick(e.target.value)}>
              {data.templates.map((t) => <option key={t.id} value={t.id}>{t.builtin ? t.name : a.exportMine(t.name)}</option>)}
            </select>
          </label>
          {!template.builtin && <div><button type="button" className="link" disabled={busy} onClick={removeTemplate}>{a.exportTemplateDelete}</button></div>}
          <label className="field">
            <span>{a.exportSession}</span>
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              <option value="">{a.exportSessionAll}</option>
              {data.sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <fieldset>
            <legend>{a.exportColumns}</legend>
            <div className="admin-export-columns">
              {columns.map((c) => (
                <label key={c.key}>
                  <input type="checkbox" checked={selected.includes(c.key)} onChange={() => toggle(c.key)} />
                  <span>{c.label}{c.sensitive && <small>（{a.exportSensitiveTag}）</small>}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {sensitive.length > 0 && <p className="admin-note" role="status">{a.exportSensitiveNote(sensitive)}</p>}
          {!data.canExportSensitive && <small className="muted">{a.exportSensitiveLimited}</small>}
          <div className="admin-export-actions">
            {saveName === null ? (
              <button type="button" className="ghost" disabled={busy} onClick={() => setSaveName('')}>{a.exportSaveAs}</button>
            ) : (
              <form className="admin-export-saveas" onSubmit={saveTemplate}>
                <label className="field"><span>{a.exportTemplateName}</span><input type="text" required maxLength={60} value={saveName} onChange={(e) => setSaveName(e.target.value)} /></label>
                <button type="submit" className="ghost" disabled={busy}>{a.exportTemplateSave}</button>
                <button type="button" className="link" onClick={() => setSaveName(null)}>{a.cancel}</button>
              </form>
            )}
            <button type="button" className="primary" disabled={busy} onClick={generate}>{a.exportGenerate}</button>
          </div>
        </div>
        <div className="admin-card">
          <h2>{data.canExportSensitive ? a.exportRecent : a.exportRecentMine}</h2>
          {data.jobs.length === 0 && <p className="muted">{a.exportRecentNone}</p>}
          {data.jobs.map((j) => (
            <div className="admin-export-job" key={j.id}>
              <div><strong>{j.name}</strong>・{a.exportJobMeta(j.sessionName, j.rowCount)}</div>
              {j.status === 'completed' ? (
                <>
                  <small className="muted">{a.exportDeletesOn(j.createdByName ?? me.user.name, when(j.createdAt), day(j.expiresAt!))}</small>
                  <div><a href={`/api/v1/agency/events/${event.id}/exports/${j.id}/download`}>{a.exportDownload}</a></div>
                </>
              ) : j.status === 'failed' ? <small className="error">{a.exportFailed}</small> : <small className="muted" aria-busy="true">{j.createdByName ?? me.user.name}・{a.exportProcessing}</small>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
