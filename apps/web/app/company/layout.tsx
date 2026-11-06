import { ContactShell } from './contact-shell';

export default function CompanyLayout({ children }: { children: React.ReactNode }) {
  return <ContactShell>{children}</ContactShell>;
}
