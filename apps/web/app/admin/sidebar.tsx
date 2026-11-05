'use client';

import type { EventNavKey } from '@bigtours/shared';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { adminApi, type AdminMe } from '../../lib/admin-api';
import { AGENCY_SECTIONS, canSeeAgencySection, EVENT_NAV_CATEGORIES, OPERATIONS_NAV, usesFullEventNav } from '../../lib/admin-nav';
import { a } from '../../messages/admin';

const COLLAPSE_KEY = 'bt_admin_nav_collapsed';

export function Sidebar({ me, onPinned, onLogout }: { me: AdminMe; onPinned: (items: EventNavKey[]) => void; onLogout: () => void }) {
  const pathname = usePathname();
  const match = pathname === '/admin/events/new' ? null : pathname.match(/^\/admin\/events\/([^/]+)(?:\/([^/]+))?/);
  return (
    <aside className="admin-side">
      <Link href="/admin" className="admin-brand">{me.agencyName}<span>{a.title}</span></Link>
      {match ? (
        <EventNav me={me} eventId={match[1]!} current={match[2]} onPinned={onPinned} />
      ) : (
        <nav aria-label={a.mainNav} className="admin-nav">
          <NavLink href="/admin" current={pathname === '/admin'} label={a.events} />
          {AGENCY_SECTIONS.filter((s) => canSeeAgencySection(me.user.role, s)).map((s) => (
            <NavLink key={s} href={`/admin/${s}`} current={pathname === `/admin/${s}`} label={a.agencySections[s]} />
          ))}
        </nav>
      )}
      <div className="admin-side-foot">
        <span><strong>{me.user.name}</strong><br />{a.roles[me.user.role] ?? me.user.role}</span>
        <button type="button" className="link" onClick={onLogout}>{a.logout}</button>
      </div>
    </aside>
  );
}

function NavLink({ href, current, label }: { href: string; current: boolean; label: string }) {
  return <Link href={href} className="admin-nav-link" aria-current={current ? 'page' : undefined}>{label}</Link>;
}

function EventNav({ me, eventId, current, onPinned }: { me: AdminMe; eventId: string; current?: string; onPinned: (items: EventNavKey[]) => void }) {
  const [eventName, setEventName] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    adminApi.event(eventId).then((e) => setEventName(e.name)).catch(() => setEventName(''));
  }, [eventId]);
  useEffect(() => {
    try { setCollapsed(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]')); } catch { /* 瀏覽器不允許時每次都展開 */ }
  }, []);

  const toggle = (label: string) => {
    const next = collapsed.includes(label) ? collapsed.filter((l) => l !== label) : [...collapsed, label];
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)); } catch { /* 只影響下次開啟時的狀態 */ }
  };

  const pinned = me.pinnedNavItems;
  const setPin = (key: EventNavKey) => {
    const next = pinned.includes(key) ? pinned.filter((k) => k !== key) : [...pinned, key];
    setError(false);
    onPinned(next);
    adminApi.setPinnedNav(next).catch(() => { onPinned(pinned); setError(true); });
  };

  const link = (key: EventNavKey, canPin: boolean) => (
    <div key={key} className="admin-nav-row" aria-current={current === key ? 'page' : undefined}>
      <Link href={`/admin/events/${eventId}/${key}`} className="admin-nav-link" aria-current={current === key ? 'page' : undefined}>{a.eventSections[key]}</Link>
      {canPin && (
        <button type="button" className="admin-pin" aria-pressed={pinned.includes(key)}
          aria-label={pinned.includes(key) ? a.unpin(a.eventSections[key]) : a.pin(a.eventSections[key])} onClick={() => setPin(key)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill={pinned.includes(key) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M9 3h6l-1 7 4 4H6l4-4-1-7z" /><path d="M12 14v7" />
          </svg>
        </button>
      )}
    </div>
  );

  const full = usesFullEventNav(me.user.role);
  return (
    <nav aria-label={a.eventNav} className="admin-nav">
      <Link href="/admin" className="admin-back">{a.backToEvents}</Link>
      <p className="admin-nav-event">{eventName}</p>
      {!full && OPERATIONS_NAV.map((k) => link(k, false))}
      {full && (
        <>
          {error && <p className="error" role="alert">{a.pinFailed}</p>}
          {pinned.length > 0 && (
            <>
              <p className="admin-nav-group">{a.pinned}</p>
              {pinned.map((k) => link(k, true))}
            </>
          )}
          {EVENT_NAV_CATEGORIES.map((c) => {
            const items = c.items.filter((k) => !pinned.includes(k));
            if (items.length === 0) return null;
            const hasCurrent = items.some((k) => k === current);
            const open = hasCurrent || !collapsed.includes(c.label);
            return (
              <div key={c.label}>
                <button type="button" className="admin-nav-group toggle" aria-expanded={open} disabled={hasCurrent} onClick={() => toggle(c.label)}>
                  {c.label}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} /></svg>
                </button>
                {open && items.map((k) => link(k, true))}
              </div>
            );
          })}
        </>
      )}
    </nav>
  );
}
