import { notFound } from 'next/navigation';
import { AGENCY_SECTIONS, type AgencySection } from '../../../../lib/admin-nav';
import { AgencySectionView } from './section-view';

export default async function Page({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!(AGENCY_SECTIONS as readonly string[]).includes(section)) notFound();
  return <AgencySectionView section={section as AgencySection} />;
}
