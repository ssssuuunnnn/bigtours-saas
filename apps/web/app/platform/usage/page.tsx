'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { platformApi, type PlatformUsage } from '../../../lib/admin-api';
import { p } from '../../../messages/platform';
import { platformError } from '../platform-shell';

const reason = (f: PlatformUsage['followUps'][number]) => {
  switch (f.kind) {
    case 'contract_expired': return p.followText.contract_expired(f.date ?? '');
    case 'contract_expiring': return p.followText.contract_expiring(f.date ?? '');
    case 'quota_empty': return p.followText.quota_empty();
    case 'admin_pending': return p.followText.admin_pending(f.days ?? 0);
  }
};

export default function PlatformUsagePage() {
  const [u, setU] = useState<PlatformUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { platformApi.usage().then(setU).catch((e) => setError(platformError(e))); }, []);
  return (
    <main className="admin-main">
      <h1>{p.nav.usage}</h1>
      <section className="admin-panel">
        <p className="muted">{p.usageHint}</p>
        {error && <p className="error" role="alert">{error}</p>}
        {!u && !error && <p aria-busy="true">{p.loading}</p>}
        {u && (
          <>
            <h2>{p.usageEvents}</h2>
            {u.events.length === 0 ? <p className="muted">{p.usageEventsNone}</p> : (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead><tr>{Object.values(p.usageCols).map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
                  <tbody>
                    {u.events.map((e) => (
                      <tr key={e.id}>
                        <td><strong>{e.name}</strong><br /><small className="muted">/{e.slug}</small></td>
                        <td><Link href={`/platform/agencies/${e.agencyId}`}>{e.agencyName}</Link></td>
                        <td className="admin-nowrap">{e.people.toLocaleString()}／{e.limit.toLocaleString()}</td>
                        <td>{e.full ? p.usageFull : p.usagePercent(e.percent)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <h2>{p.followUps}</h2>
            {u.followUps.length === 0 ? <p className="muted">{p.followNone}</p> : (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead><tr>{Object.values(p.followCols).map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
                  <tbody>
                    {u.followUps.map((f) => (
                      <tr key={`${f.agencyId}:${f.kind}`}>
                        <td>{f.agencyName}</td>
                        <td>{reason(f)}</td>
                        <td><Link href={`/platform/agencies/${f.agencyId}`}>{p.followAction}</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
