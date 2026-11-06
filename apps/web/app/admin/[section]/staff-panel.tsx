'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminApi, type StaffMember } from '../../../lib/admin-api';
import { a } from '../../../messages/admin';
import { adminError } from '../admin-shell';

const when = (iso: string) => new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const ROLES = ['operations', 'event_operator', 'admin'];

export function StaffPanel() {
  const [staff, setStaff] = useState<StaffMember[] | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('operations');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => adminApi.staff().then(setStaff).catch((e) => setError(adminError(e))), []);
  useEffect(() => { void load(); }, [load]);

  const run = async (action: () => Promise<string | null | void>) => {
    setBusy(true); setNote(null); setError(null);
    try {
      setNote((await action()) ?? null);
    } catch (e) {
      setError(adminError(e));
    } finally {
      await load();
      setBusy(false);
    }
  };
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await adminApi.createStaff({ name, email, role });
      const sent = a.staffInvited(email);
      setName(''); setEmail('');
      return sent;
    });
  };

  return (
    <section className="admin-panel">
      <p className="muted">{a.staffHint}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="admin-note" role="status">{note}</p>}
      {!staff && !error && <p aria-busy="true">{a.loading}</p>}
      {staff && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr>{Object.values(a.staffCols).map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
            <tbody>
              {staff.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}{u.isSelf && <small className="muted">{a.staffSelf}</small>}</td>
                  <td>{u.email}</td>
                  <td>
                    {u.isSelf || u.status === 'disabled' ? a.roles[u.role] : (
                      <label>
                        <span className="sr-only">{a.staffChangeRole(u.name)}</span>
                        <select value={u.role} disabled={busy} onChange={(e) => { const next = e.target.value; void run(async () => { await adminApi.setStaffRole(u.id, next); return a.staffRoleSaved(u.name, a.roles[next]!); }); }}>
                          {ROLES.map((r) => <option key={r} value={r}>{a.roles[r]}</option>)}
                        </select>
                      </label>
                    )}
                  </td>
                  <td>{u.status === 'disabled' ? a.staffDisabled : u.activated ? a.staffActive : a.staffPending}</td>
                  <td className="admin-nowrap">{u.lastLoginAt ? when(u.lastLoginAt) : '—'}</td>
                  <td className="admin-actions">
                    {!u.isSelf && (u.status === 'active' ? (
                      <>
                        <button type="button" className="link" disabled={busy} onClick={() => run(async () => { await adminApi.sendStaffLink(u.id); return a.staffLinkSent(u.email); })}>{u.activated ? a.staffReset : a.staffResend}</button>
                        <button type="button" className="link" disabled={busy} onClick={() => { if (window.confirm(a.staffDisableConfirm(u.name))) void run(() => adminApi.setStaffStatus(u.id, 'disabled')); }}>{a.staffDisable}</button>
                      </>
                    ) : <button type="button" className="link" disabled={busy} onClick={() => run(() => adminApi.setStaffStatus(u.id, 'active'))}>{a.staffEnable}</button>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="admin-card admin-export-saveas" onSubmit={add}>
        <label className="field"><span>{a.staffName}</span><input type="text" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>{a.staffEmail}</span><input type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field"><span>{a.staffRole}</span><select value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{a.roles[r]}</option>)}</select></label>
        <button type="submit" className="primary" disabled={busy}>{a.staffAdd}</button>
      </form>
      <h2>{a.staffMatrix}</h2>
      <div className="admin-table-wrap">
        <table className="admin-table admin-matrix">
          <thead><tr>{a.staffMatrixCols.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
          <tbody>{a.staffMatrixRows.map((row) => <tr key={row[0]}>{row.map((c, i) => <td key={i}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <small className="muted">{a.staffFoot}</small>
    </section>
  );
}
