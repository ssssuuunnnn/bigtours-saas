'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminApi, type AdminCompany, type CompanyContact } from '../../../../lib/admin-api';
import { a } from '../../../../messages/admin';
import { adminError } from '../admin-shell';

export function CompaniesPanel() {
  const [companies, setCompanies] = useState<AdminCompany[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const load = useCallback(() => adminApi.companies().then(setCompanies).catch((e) => setError(adminError(e))), []);
  useEffect(() => { void load(); }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await adminApi.createCompany(name);
      setName('');
      await load();
    } catch (err) {
      setError(adminError(err));
    }
  };

  return (
    <section className="admin-panel">
      {error && <p className="error" role="alert">{error}</p>}
      {companies && companies.length === 0 && <p className="muted">{a.noCompanies}</p>}
      {companies && companies.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>{a.company}</th><th>{a.eventCount}</th><th>{a.contactsTitle}</th></tr></thead>
            <tbody>{companies.map((c) => <tr key={c.id}><td>{c.name}</td><td>{c.eventCount}</td><td><button type="button" className="link" aria-expanded={openId === c.id} onClick={() => setOpenId(openId === c.id ? null : c.id)}>{a.contactsManage}</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
      {openId && companies?.find((c) => c.id === openId) && <CompanyBrandCard key={`brand-${openId}`} company={companies.find((c) => c.id === openId)!} onChanged={load} />}
      {openId && companies?.find((c) => c.id === openId) && <ContactsCard key={openId} company={companies.find((c) => c.id === openId)!} />}
      <form className="admin-form" onSubmit={submit}>
        <label className="field span-3"><span>{a.addCompany}</span><input type="text" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="admin-form-actions span-3"><button type="submit" className="primary">{a.addCompanyAction}</button></div>
      </form>
      <p className="muted">{a.companiesLater}</p>
    </section>
  );
}

function ContactsCard({ company }: { company: AdminCompany }) {
  const [contacts, setContacts] = useState<CompanyContact[] | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => adminApi.companyContacts(company.id).then(setContacts).catch((e) => setError(adminError(e))), [company.id]);
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
      await adminApi.createContact(company.id, { name, email });
      setName(''); setEmail('');
      return a.contactInvited(email);
    });
  };

  return (
    <div className="admin-card">
      <h2>{a.contactsOf(company.name)}</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="admin-note" role="status">{note}</p>}
      {contacts && contacts.length === 0 && <p className="muted">{a.contactsNone}</p>}
      {contacts && contacts.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th scope="col">{a.personName}</th><th scope="col">{a.personEmail}</th><th scope="col">{a.personStatus}</th><th scope="col">{a.actions}</th></tr></thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.email}</td>
                  <td>{c.status === 'disabled' ? a.contactDisabled : c.activated ? a.contactActive : a.contactPending}</td>
                  <td className="admin-actions">
                    {c.status === 'active' ? (
                      <>
                        <button type="button" className="link" disabled={busy} onClick={() => run(async () => { await adminApi.sendContactLink(company.id, c.id); return a.contactLinkSent(c.email); })}>{c.activated ? a.contactReset : a.contactResend}</button>
                        <button type="button" className="link" disabled={busy} onClick={() => { if (window.confirm(a.contactDisableConfirm(c.name))) void run(() => adminApi.setContactStatus(company.id, c.id, 'disabled')); }}>{a.contactDisable}</button>
                      </>
                    ) : <button type="button" className="link" disabled={busy} onClick={() => run(() => adminApi.setContactStatus(company.id, c.id, 'active'))}>{a.contactEnable}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="admin-export-saveas" onSubmit={add}>
        <label className="field"><span>{a.personName}</span><input type="text" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>{a.personEmail}</span><input type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <button type="submit" className="primary" disabled={busy}>{a.contactAdd}</button>
      </form>
      <small className="muted">{a.personsHint}</small>
    </div>
  );
}

function CompanyBrandCard({ company, onChanged }: { company: AdminCompany; onChanged: () => Promise<unknown> | void }) {
  const [name, setName] = useState(company.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null); setNote(null);
    try {
      await fn();
      await onChanged();
      setNote(a.companySaved);
    } catch (e) {
      setError(adminError(e));
    } finally {
      setBusy(false);
    }
  };
  const choose = (e: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0];
    e.target.value = '';
    if (!chosen) return;
    if (chosen.size > 2 * 1024 * 1024) { setError(a.errors.FILE_TOO_LARGE ?? a.errors.fallback!); return; }
    void run(() => adminApi.uploadCompanyLogo(company.id, chosen));
  };
  return (
    <div className="admin-card">
      <h2>{a.companyBrand(company.name)}</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="admin-note" role="status">{note}</p>}
      <div>
        <span>{a.companyLogo}</span>
        {company.logoUrl ? <img className="admin-settings-logo" src={company.logoUrl} alt={a.companyLogoAlt(company.name)} /> : <p className="muted">{a.companyLogoNone}</p>}
      </div>
      <div className="admin-file-row">
        <label className="ghost admin-file-button">
          {a.companyLogoChange}
          <input className="admin-file-input" type="file" accept="image/png,image/svg+xml" aria-label={a.companyLogoChange} hidden disabled={busy} onChange={choose} />
        </label>
        {company.logoUrl && <button type="button" className="link" disabled={busy} onClick={() => run(() => adminApi.removeCompanyLogo(company.id))}>{a.companyLogoRemove}</button>}
        <small className="muted">{a.companyLogoHint}</small>
      </div>
      <form className="admin-export-saveas" onSubmit={(e) => { e.preventDefault(); void run(() => adminApi.renameCompany(company.id, name)); }}>
        <label className="field"><span>{a.companyName}</span><input type="text" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <button type="submit" className="primary" disabled={busy}>{a.save}</button>
      </form>
    </div>
  );
}
