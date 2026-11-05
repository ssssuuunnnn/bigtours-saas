'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminApi, type AdminCompany } from '../../../lib/admin-api';
import { a } from '../../../messages/admin';
import { adminError } from '../admin-shell';

export function CompaniesPanel() {
  const [companies, setCompanies] = useState<AdminCompany[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
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
            <thead><tr><th>{a.company}</th><th>{a.eventCount}</th></tr></thead>
            <tbody>{companies.map((c) => <tr key={c.id}><td>{c.name}</td><td>{c.eventCount}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <form className="admin-form" onSubmit={submit}>
        <label className="field span-3"><span>{a.addCompany}</span><input type="text" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="admin-form-actions span-3"><button type="submit" className="primary">{a.addCompanyAction}</button></div>
      </form>
      <p className="muted">{a.companiesLater}</p>
    </section>
  );
}
