'use client';

import { AgencyLink as Link, agencyLocation, useAgencyPathname } from '../../../lib/agency';
import { createContext, useContext, useEffect, useState } from 'react';
import { ApiError } from '../../../lib/api';
import { contactApi, type ContactMe } from '../../../lib/admin-api';
import { a } from '../../../messages/admin';
import { DoneToast } from '../../../lib/done-toast';

const MeContext = createContext<ContactMe | null>(null);
export function useContactMe() {
  const me = useContext(MeContext);
  if (!me) throw new Error('useContactMe 必須在 ContactShell 內使用');
  return me;
}

const SECTIONS = ['overview', 'roster', 'registrations'] as const;

/** 共用登入頁在 /admin；沒有登入時導回去。設定密碼頁不需要登入。 */
export function ContactShell({ children }: { children: React.ReactNode }) {
  const pathname = useAgencyPathname();
  const publicPage = pathname.startsWith('/company/set-password');
  const [me, setMe] = useState<ContactMe | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (publicPage) return;
    contactApi.me().then(setMe).catch((e) => {
      if (e instanceof ApiError && e.status === 401) window.location.replace(agencyLocation('/admin'));
      else setFailed(true);
    });
  }, [publicPage]);

  if (publicPage) return <>{children}</>;
  if (failed) return <main className="center-note"><p role="alert">{a.loadFailed}</p></main>;
  if (!me) return <main className="center-note" aria-busy="true"><p>{a.loading}</p></main>;
  const match = pathname.match(/^\/company\/events\/([^/]+)(?:\/([^/]+))?/);
  return (
    <MeContext.Provider value={me}>
      <div className="admin">
        <aside className="admin-side">
          <Link href="/company" className="admin-brand">{me.companyName}<span>{a.c.provided(me.agencyName)}</span></Link>
          <nav aria-label={a.mainNav} className="admin-nav">
            {match ? (
              <>
                <Link href="/company" className="admin-back">{a.c.backToEvents}</Link>
                {SECTIONS.map((s) => <Link key={s} href={`/company/events/${match[1]}/${s}`} className="admin-nav-link" aria-current={match[2] === s ? 'page' : undefined}>{a.c.nav[s]}</Link>)}
              </>
            ) : <Link href="/company" className="admin-nav-link" aria-current="page">{a.c.events}</Link>}
          </nav>
          <div className="admin-side-foot">
            <span><strong>{me.user.name}</strong><br />{a.c.role}</span>
            <button type="button" className="link" onClick={() => { void contactApi.logout().finally(() => window.location.replace(agencyLocation('/admin'))); }}>{a.logout}</button>
          </div>
        </aside>
        <div className="admin-content">
          {me.trialExpired && <p className="trial-banner expired" role="status">{me.agencyName} 的試用已到期，名單與報名資料只能查看與匯出。</p>}
          {children}
        </div>
        <DoneToast />
      </div>
    </MeContext.Provider>
  );
}
