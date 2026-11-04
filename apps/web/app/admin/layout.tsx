import './admin.css';

export const metadata = { title: '旅行社後台' };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="admin">{children}</div>;
}
