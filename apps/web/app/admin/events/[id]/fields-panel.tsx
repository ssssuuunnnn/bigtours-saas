'use client';

import { useCallback, useEffect, useState } from 'react';
import { FIELD_TYPES } from '@bigtours/shared';
import { adminApi, type AdminEvent, type AdminField, type FieldValues } from '../../../../lib/admin-api';
import { a } from '../../../../messages/admin';
import { adminError, MoveButtons, swapped } from '../../admin-shell';

const EMPTY: FieldValues = { label: '', type: 'text', choices: null, isRequired: false, isSensitive: false };
const hasChoices = (type: string) => type === 'select' || type === 'multiselect';

export function FieldsPanel({ event }: { event: AdminEvent }) {
  const [fields, setFields] = useState<AdminField[] | null>(null);
  const [editing, setEditing] = useState<AdminField | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => adminApi.fields(event.id).then(setFields).catch((e) => setError(adminError(e))), [event.id]);
  useEffect(() => { void load(); }, [load]);

  if (!fields) return error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>;

  const move = async (i: number, j: number) => {
    setError(null);
    const next = swapped(fields, i, j);
    setFields(next);
    await adminApi.orderFields(event.id, next.map((f) => f.id)).catch((e) => { setError(adminError(e)); return load(); });
  };
  const remove = async (f: AdminField) => {
    if (!window.confirm(a.confirmRemove(f.label))) return;
    setError(null);
    await adminApi.deleteField(event.id, f.id).then(load).catch((e) => setError(adminError(e)));
  };

  return (
    <section className="admin-panel">
      <div className="admin-panel-head">
        <p className="muted">{a.fieldsHint}</p>
        <button type="button" className="primary" onClick={() => setEditing('new')}>{a.addField}</button>
      </div>
      {event.hasRegistrations && <p className="notice">{a.lockedHint}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {editing && (
        <FieldForm
          event={event}
          field={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th scope="col">{a.order}</th><th scope="col">{a.fieldLabel}</th><th scope="col">{a.fieldType}</th>
              <th scope="col">{a.fieldChoices}</th><th scope="col">{a.required}</th><th scope="col">{a.actions}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="fixed">
              <td>{a.fixed}</td><td><strong>{a.fixedName}</strong></td><td>{a.types.text}</td><td>—</td><td>{a.required}</td><td>—</td>
            </tr>
            {fields.map((f, i) => (
              <tr key={f.id}>
                <td><MoveButtons name={f.label} canUp={i > 0} canDown={i < fields.length - 1} onUp={() => move(i, i - 1)} onDown={() => move(i, i + 1)} /></td>
                <td><strong>{f.label}</strong>{f.isSensitive && <small className="muted"> {a.sensitiveShort}</small>}</td>
                <td>{a.types[f.type] ?? f.type}</td>
                <td>{f.choices?.join('、') || '—'}</td>
                <td>{f.isRequired ? a.required : a.optional}</td>
                <td className="admin-actions">
                  <button type="button" className="link" onClick={() => setEditing(f)}>{a.edit}</button>
                  <button type="button" className="link" disabled={event.hasRegistrations} onClick={() => remove(f)}>{a.remove}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {fields.length === 0 && <p className="muted">{a.noFields}</p>}
    </section>
  );
}

function FieldForm({ event, field, onCancel, onSaved }: { event: AdminEvent; field: AdminField | null; onCancel: () => void; onSaved: () => void }) {
  const [v, setV] = useState<FieldValues>(field ?? EMPTY);
  const [choices, setChoices] = useState((field?.choices ?? []).join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = !!field && event.hasRegistrations;
  const withChoices = hasChoices(v.type);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const body: FieldValues = {
      ...v,
      choices: withChoices ? choices.split('\n').map((c) => c.trim()).filter(Boolean) : null,
      isSensitive: withChoices ? false : v.isSensitive,
    };
    try {
      if (field) await adminApi.updateField(event.id, field.id, body);
      else await adminApi.createField(event.id, body);
      onSaved();
    } catch (err) {
      setError(adminError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="admin-form" onSubmit={submit}>
      {error && <p className="error" role="alert">{error}</p>}
      <label className="field span-2"><span>{a.fieldLabel}</span><input type="text" required maxLength={100} value={v.label} onChange={(e) => setV({ ...v, label: e.target.value })} /></label>
      <label className="field">
        <span>{a.fieldType}</span>
        <select value={v.type} disabled={locked} onChange={(e) => setV({ ...v, type: e.target.value })}>
          {FIELD_TYPES.map((type) => <option key={type} value={type}>{a.types[type]}</option>)}
        </select>
      </label>
      {withChoices && (
        <label className="field span-3">
          <span>{a.fieldChoices}</span>
          <textarea rows={4} required value={choices} onChange={(e) => setChoices(e.target.value)} />
          <small>{a.choicesHint}</small>
        </label>
      )}
      <label className="check span-3"><input type="checkbox" checked={v.isRequired} onChange={(e) => setV({ ...v, isRequired: e.target.checked })} /><span>{a.required}</span></label>
      {!withChoices && (
        <label className="check span-3"><input type="checkbox" checked={v.isSensitive} disabled={locked} onChange={(e) => setV({ ...v, isSensitive: e.target.checked })} /><span>{a.sensitive}</span></label>
      )}
      <div className="admin-form-actions span-3">
        <button type="button" className="ghost" onClick={onCancel}>{a.cancel}</button>
        <button type="submit" className="primary" disabled={busy}>{busy ? a.saving : a.save}</button>
      </div>
    </form>
  );
}
