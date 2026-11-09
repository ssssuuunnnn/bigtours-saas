'use client';

import { useEffect, useState } from 'react';
import { adminApi, type AdminEvent, type PricingValues, type TravelerTypeValues } from '../../../../lib/admin-api';
import { a } from '../../../../messages/admin';
import { adminError, MoveButtons, swapped } from '../../admin-shell';

const EMPTY_TYPE: TravelerTypeValues = { id: null, name: '', basePrice: 0, note: null, occupiesBed: true };

export function TypesPanel({ event }: { event: AdminEvent }) {
  const [v, setV] = useState<PricingValues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { adminApi.pricing(event.id).then(setV).catch((e) => setError(adminError(e))); }, [event.id]);

  if (!v) return error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>;
  const setType = (i: number, patch: Partial<TravelerTypeValues>) => setV({ ...v, types: v.types.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      setV(await adminApi.savePricing(event.id, v));
    } catch (err) {
      setError(adminError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="admin-form" onSubmit={submit}>
      <div className="admin-panel-head span-3">
        <p className="muted">{a.typesHint}</p>
        <button type="button" className="link" onClick={() => setV({ ...v, types: [...v.types, EMPTY_TYPE] })}>{a.addType}</button>
      </div>
      {error && <p className="error span-3" role="alert">{error}</p>}
      <div className="admin-table-wrap span-3">
        <table className="admin-table admin-edit-table">
          <thead>
            <tr>
              <th scope="col">{a.order}</th><th scope="col">{a.typeName}</th><th scope="col">{a.typeFee}</th><th scope="col">{a.typeNote}</th>
              <th scope="col">{a.typeNoBed}</th><th scope="col">{a.actions}</th>
            </tr>
          </thead>
          <tbody>
            {v.types.map((t, i) => (
              <tr key={t.id ?? `new-${i}`} className={t.isEmployeeSelf ? 'fixed' : undefined}>
                <td>
                  {!t.isEmployeeSelf && (
                    <MoveButtons name={t.name || a.addType} canUp={i > 0 && !v.types[i - 1]!.isEmployeeSelf} canDown={i < v.types.length - 1}
                      onUp={() => setV({ ...v, types: swapped(v.types, i, i - 1) })} onDown={() => setV({ ...v, types: swapped(v.types, i, i + 1) })} />
                  )}
                </td>
                <td>
                  {t.isEmployeeSelf
                    ? <><strong>{t.name}</strong> <small className="muted">{a.fixed}</small></>
                    : <input aria-label={a.typeFieldLabel(t.name, a.typeName)} type="text" required maxLength={50} value={t.name} onChange={(e) => setType(i, { name: e.target.value })} />}
                </td>
                <td><input aria-label={a.typeFieldLabel(t.name, a.typeFee)} type="number" required min={0} max={10000000} value={t.basePrice} onChange={(e) => setType(i, { basePrice: Number(e.target.value) })} /></td>
                <td><input aria-label={a.typeFieldLabel(t.name, a.typeNote)} type="text" maxLength={200} value={t.note ?? ''} onChange={(e) => setType(i, { note: e.target.value })} /></td>
                <td>
                  {t.isEmployeeSelf
                    ? <span className="muted">—</span>
                    : <input aria-label={a.typeFieldLabel(t.name, a.typeNoBed)} type="checkbox" checked={!t.occupiesBed} onChange={(e) => setType(i, { occupiesBed: !e.target.checked })} />}
                </td>
                <td className="admin-actions">
                  {!t.isEmployeeSelf && <button type="button" className="link" onClick={() => setV({ ...v, types: v.types.filter((_, j) => j !== i) })}>{a.remove}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <fieldset className="span-3">
        <legend>{a.subsidyTitle}</legend>
        <div className="admin-tiers">
          <label className="field"><span>{a.defaultSubsidy}</span><input type="number" required min={0} max={10000000} value={v.defaultSubsidyAmount} onChange={(e) => setV({ ...v, defaultSubsidyAmount: Number(e.target.value) })} /><small className="muted">{a.defaultSubsidyHint}</small></label>
          <label className="field"><span>{a.defaultDependents}</span><input type="number" required min={0} max={50} value={v.defaultDependentLimit} onChange={(e) => setV({ ...v, defaultDependentLimit: Number(e.target.value) })} /><small className="muted">{a.defaultDependentsHint}</small></label>
        </div>
        <label className="check">
          <input type="checkbox" checked={v.allowDependentsOnly} onChange={(e) => setV({ ...v, allowDependentsOnly: e.target.checked })} />
          <span><strong>{a.dependentsOnly}</strong><br /><small className="muted">{a.dependentsOnlyHint}</small></span>
        </label>
      </fieldset>

      <div className="admin-form-actions span-3">
        <button type="submit" className="primary" disabled={busy}>{busy ? a.saving : a.save}</button>
      </div>
    </form>
  );
}
