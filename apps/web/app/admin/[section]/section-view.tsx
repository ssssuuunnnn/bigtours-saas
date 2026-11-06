'use client';

import { canSeeAgencySection, type AgencySection } from '../../../lib/admin-nav';
import { a } from '../../../messages/admin';
import { useAdminMe } from '../admin-shell';
import { CompaniesPanel } from './companies-panel';
import { DataLogPanel } from './data-log-panel';
import { SettingsPanel } from './settings-panel';
import { StaffPanel } from './staff-panel';

export function AgencySectionView({ section }: { section: AgencySection }) {
  const me = useAdminMe();
  if (!canSeeAgencySection(me.user.role, section)) {
    return <main className="admin-main"><p role="alert" className="error">{a.forbidden}</p></main>;
  }
  return (
    <main className="admin-main">
      <h1>{a.agencySections[section]}</h1>
      {section === 'companies' ? <CompaniesPanel /> : section === 'data-log' ? <DataLogPanel /> : section === 'staff' ? <StaffPanel /> : <SettingsPanel />}
    </main>
  );
}
