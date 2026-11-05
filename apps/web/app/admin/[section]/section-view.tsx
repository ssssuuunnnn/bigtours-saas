'use client';

import { canSeeAgencySection, type AgencySection } from '../../../lib/admin-nav';
import { a } from '../../../messages/admin';
import { useAdminMe } from '../admin-shell';
import { CompaniesPanel } from './companies-panel';

export function AgencySectionView({ section }: { section: AgencySection }) {
  const me = useAdminMe();
  if (!canSeeAgencySection(me.user.role, section)) {
    return <main className="admin-main"><p role="alert" className="error">{a.forbidden}</p></main>;
  }
  return (
    <main className="admin-main">
      <h1>{a.agencySections[section]}</h1>
      {section === 'companies' ? <CompaniesPanel /> : <p className="muted">{a.comingSoon}</p>}
    </main>
  );
}
