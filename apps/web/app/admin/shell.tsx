'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { adminFetch } from '../../lib/admin-api';

export function Shell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<{ agencyName: string; primaryColor: string | null; user: { name: string } } | null>(null);
  useEffect(() => {
    adminFetch('GET', '/me').then(setMe).catch(() => undefined);
  }, []);
  const logout = async () => {
    await adminFetch('POST', '/auth/logout').catch(() => undefined);
    window.location.href = '/admin/login';
  };
  const style = me?.primaryColor ? ({ '--brand': me.primaryColor } as React.CSSProperties) : undefined;
  return (
    <div style={style}>
      <header className="admin-bar">
        <Link className="brand" href="/admin">{me?.agencyName ?? '旅行社後台'}</Link>
        <div className="right">
          {me && <span>{me.user.name}</span>}
          <button type="button" onClick={logout}>登出</button>
        </div>
      </header>
      <main className="admin-main">{children}</main>
    </div>
  );
}

/** 刪除等不可復原的操作：按第一次變成確認狀態，第二次才執行。 */
export function ConfirmButton({ label, confirmLabel, onConfirm, disabled }: { label: string; confirmLabel: string; onConfirm: () => void; disabled?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button type="button" disabled={disabled} className={`btn warn${armed ? ' armed' : ''}`} onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {armed ? confirmLabel : label}
    </button>
  );
}
