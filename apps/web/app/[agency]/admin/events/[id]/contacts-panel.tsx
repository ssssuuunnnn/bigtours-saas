'use client';

import { useEffect, useState } from 'react';
import { adminApi, type AdminEvent, type ContactValues } from '../../../../../lib/admin-api';
import { a } from '../../../../../messages/admin';
import { adminError, MoveButtons, swapped } from '../../admin-shell';

const EMPTY: ContactValues = { id: null, name: '', phone: '', scope: '' };

export function ContactsPanel({ event }: { event: AdminEvent }) {
  const [contacts, setContacts] = useState<ContactValues[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { adminApi.contacts(event.id).then((c) => setContacts(c.length ? c : [EMPTY])).catch((e) => setError(adminError(e))); }, [event.id]);

  if (!contacts) return error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>;
  const set = (i: number, patch: Partial<ContactValues>) => setContacts(contacts.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      setContacts(await adminApi.saveContacts(event.id, contacts));
    } catch (err) {
      setError(adminError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="admin-form" onSubmit={submit}>
      <div className="admin-panel-head span-3">
        <p className="muted">{a.contactsHint}</p>
        <button type="button" className="link" onClick={() => setContacts([...contacts, EMPTY])}>{a.addContact}</button>
      </div>
      {error && <p className="error span-3" role="alert">{error}</p>}
      {contacts.length === 0 ? <p className="admin-warn span-3">{a.noContacts}</p> : (
        <div className="admin-table-wrap span-3">
          <table className="admin-table admin-edit-table">
            <thead>
              <tr>
                <th scope="col">{a.order}</th><th scope="col">{a.contactName}</th><th scope="col">{a.contactPhone}</th>
                <th scope="col">{a.contactScope}</th><th scope="col">{a.actions}</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c, i) => (
                <tr key={c.id ?? `new-${i}`}>
                  <td><MoveButtons name={c.name || a.addContact} canUp={i > 0} canDown={i < contacts.length - 1} onUp={() => setContacts(swapped(contacts, i, i - 1))} onDown={() => setContacts(swapped(contacts, i, i + 1))} /></td>
                  <td><input aria-label={a.contactFieldLabel(c.name, a.contactName)} type="text" required maxLength={50} value={c.name} onChange={(e) => set(i, { name: e.target.value })} /></td>
                  <td><input aria-label={a.contactFieldLabel(c.name, a.contactPhone)} type="tel" required maxLength={30} value={c.phone} onChange={(e) => set(i, { phone: e.target.value })} /></td>
                  <td><input aria-label={a.contactFieldLabel(c.name, a.contactScope)} type="text" required maxLength={100} value={c.scope} onChange={(e) => set(i, { scope: e.target.value })} /></td>
                  <td className="admin-actions"><button type="button" className="link" onClick={() => setContacts(contacts.filter((_, j) => j !== i))}>{a.remove}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted span-3">{a.contactsNote}</p>
      <div className="admin-form-actions span-3">
        <button type="submit" className="primary" disabled={busy}>{busy ? a.saving : a.save}</button>
      </div>
    </form>
  );
}
