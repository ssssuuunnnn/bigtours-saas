'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, createClient, lineApi, type Landing } from '../../lib/api';
import { initLiff, inLineApp, slugFromLiffState } from '../../lib/liff';
import { t } from '../../messages/zh-TW';
import { EventEntry, LoginView } from '../[slug]/event-entry';

const errorText = (e: unknown) => t.errors[e instanceof ApiError ? e.code : 'fallback'] ?? t.errors.fallback!;
const sitePath = (slug: string) => `/${encodeURIComponent(slug)}`;

type EntryState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'bind'; landing: Landing; idToken: string }
  | { kind: 'not_available' }
  | { kind: 'error'; message: string };

/**
 * 活動的 LINE 連結（liff.line.me/LIFF ID/活動代碼）開啟的頁面。
 * 已綁定就自動登入；沒綁定時以員工編號＋密碼登入一次並綁定。登入後顯示與一般前台相同的畫面。
 */
export function LineEntry({ slug }: { slug: string }) {
  const api = useMemo(() => createClient(slug), [slug]);
  const [state, setState] = useState<EntryState>({ kind: 'loading' });

  const start = useCallback(async () => {
    setState({ kind: 'loading' });
    // 在 LINE 以外開啟時直接導到一般登入頁，不提供 LINE 網頁登入。
    if (!inLineApp()) { window.location.replace(sitePath(slug)); return; }
    try {
      const liff = await initLiff((await lineApi.config()).liffId);
      if (!liff.isInClient()) { window.location.replace(sitePath(slug)); return; }
      const idToken = liff.getIDToken();
      if (!idToken) { setState({ kind: 'error', message: t.line.noIdToken }); return; }
      try {
        await api.lineLogin(idToken);
        setState({ kind: 'ready' });
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (e.code === 'LINE_NOT_BOUND') { setState({ kind: 'bind', landing: await api.landing(), idToken }); return; }
        // 活動頁未開放或找不到活動時，交給一般前台顯示對應的頁面。
        if (e.code === 'PAGE_CLOSED' || e.code === 'NOT_FOUND') { setState({ kind: 'ready' }); return; }
        throw e;
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'LINE_NOT_AVAILABLE') { setState({ kind: 'not_available' }); return; }
      setState({ kind: 'error', message: errorText(e) });
    }
  }, [api, slug]);

  useEffect(() => { void start(); }, [start]);

  if (state.kind === 'loading') return <main className="center-note" aria-busy="true"><p>{t.line.opening}</p></main>;
  if (state.kind === 'ready') return <EventEntry slug={slug} />;
  if (state.kind === 'not_available') {
    return (
      <main className="center-note">
        <h1>{t.line.notAvailableTitle}</h1>
        <p>{t.line.notAvailableHint}</p>
        <a className="primary-link" href={sitePath(slug)}>{t.line.goSite}</a>
      </main>
    );
  }
  if (state.kind === 'error') {
    return (
      <main className="center-note">
        <p role="alert">{state.message}</p>
        <button type="button" className="primary" onClick={() => window.location.reload()}>{t.line.retry}</button>
      </main>
    );
  }
  return (
    <LoginView
      slug={slug}
      landing={state.landing}
      onLoggedIn={() => setState({ kind: 'ready' })}
      onPageClosed={() => setState({ kind: 'ready' })}
      submitLogin={(employeeNo, password) => api.lineBind(state.idToken, employeeNo, password)}
      copy={{ title: t.line.bindTitle, hint: t.line.bindHint, submit: t.line.bindSubmit, busy: t.line.binding }}
    />
  );
}

type HomeState =
  | { kind: 'loading' }
  | { kind: 'outside' }
  | { kind: 'not_available' }
  | { kind: 'list'; agencyName: string; events: { slug: string; name: string; companyName: string }[] }
  | { kind: 'error'; message: string };

/**
 * 旅行社共用連結（liff.line.me/LIFF ID），可放在官方帳號的圖文選單。
 * 列出這個 LINE 帳號已綁定、活動頁開啟中的活動；只有一個時直接進入。
 */
export function LineHome() {
  const [state, setState] = useState<HomeState>({ kind: 'loading' });

  useEffect(() => {
    const run = async () => {
      if (!inLineApp()) {
        const slug = slugFromLiffState(window.location.search);
        if (slug) window.location.replace(sitePath(slug));
        else setState({ kind: 'outside' });
        return;
      }
      const config = await lineApi.config();
      const liff = await initLiff(config.liffId);
      // 活動連結會先開到這裡，SDK 再轉到 /line/活動代碼，這時不用顯示任何內容。
      if (new URLSearchParams(window.location.search).has('liff.state')) return;
      if (!liff.isInClient()) { setState({ kind: 'outside' }); return; }
      const idToken = liff.getIDToken();
      if (!idToken) { setState({ kind: 'error', message: t.line.noIdToken }); return; }
      const events = await lineApi.events(idToken);
      if (events.length === 1) { window.location.replace(`/line/${encodeURIComponent(events[0]!.slug)}`); return; }
      setState({ kind: 'list', agencyName: config.agencyName, events });
    };
    run().catch((e) => setState(e instanceof ApiError && e.code === 'LINE_NOT_AVAILABLE' ? { kind: 'not_available' } : { kind: 'error', message: errorText(e) }));
  }, []);

  if (state.kind === 'loading') return <main className="center-note" aria-busy="true"><p>{t.line.opening}</p></main>;
  if (state.kind === 'outside') return <main className="center-note"><h1>{t.line.openInLine}</h1><p>{t.line.openInLineHint}</p></main>;
  if (state.kind === 'not_available') return <main className="center-note"><p>{t.line.agencyNotAvailable}</p></main>;
  if (state.kind === 'error') {
    return (
      <main className="center-note">
        <p role="alert">{state.message}</p>
        <button type="button" className="primary" onClick={() => window.location.reload()}>{t.line.retry}</button>
      </main>
    );
  }
  if (state.events.length === 0) {
    return <main className="center-note"><p className="muted">{state.agencyName}</p><h1>{t.line.noEventsTitle}</h1><p>{t.line.noEventsHint}</p></main>;
  }
  return (
    <>
      <header className="masthead">
        <p className="agency">{state.agencyName}</p>
        <h1>{t.line.pickTitle}</h1>
        <p className="who">{t.line.pickHint}</p>
      </header>
      <main className="page">
        {state.events.map((e) => (
          <a key={e.slug} className="block line-event" href={`/line/${encodeURIComponent(e.slug)}`}>
            <span className="muted">{e.companyName}</span>
            <strong>{e.name}</strong>
          </a>
        ))}
      </main>
    </>
  );
}
