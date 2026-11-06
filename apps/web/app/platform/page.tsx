'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { platformApi, type PlatformAgencyRow } from '../../lib/admin-api';
import { p } from '../../messages/platform';
import { platformError } from './platform-shell';

export default function PlatformAgencies() {
  const [rows, setRows] = useState<PlatformAgencyRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { platformApi.agencies(search).then(setRows).catch((e) => setError(platformError(e))); }, [search]);
  return (
    <main className="admin-main">
      <h1>{p.nav.agencies}</h1>
      <section className="admin-panel">
        <div className="admin-panel-head">
          <p className="muted">{rows ? p.agenciesHint(rows.length) : p.loading}</p>
          <Link className="primary-link" href="/platform/agencies/new">{p.createAgency}</Link>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <label className="field"><span>{p.search}</span><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        {rows?.length === 0 && <p className="muted">{p.none}</p>}
        {!!rows?.length && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr>{Object.values(p.cols).map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td><Link href={`/platform/agencies/${a.id}`}><strong>{a.name}</strong></Link><br /><small className="muted">{a.code}</small></td>
                    <td className="admin-nowrap">{a.contractStartsOn ?? '—'}～{a.contractEndsOn ?? '—'}</td>
                    <td>{p.states[a.state]}</td>
                    <td>{p.count(a.opened)}</td>
                    <td>{p.count(a.used)}</td>
                    <td>{p.count(a.remaining)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
