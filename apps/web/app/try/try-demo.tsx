'use client';

import { useEffect, useRef, useState } from 'react';

const MESSAGES: Record<string, string> = {
  TOO_MANY_REQUESTS: '試玩次數太多，請 10 分鐘後再試。',
  DEMO_UNAVAILABLE: '試玩活動準備中，請稍後再試。',
  NOT_FOUND: '這個網址沒有試玩活動。',
};

/** 官網的「開始試玩」：取得新的試玩身分後，直接進入示範活動。 */
export function TryDemo() {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    fetch('/api/v1/public/demo/start', { method: 'POST' })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.code ?? 'fallback');
        window.location.replace(`/${encodeURIComponent(data.slug)}`);
      })
      .catch((e: Error) => setError(MESSAGES[e.message] ?? '無法開始試玩，請重新整理頁面。'));
  }, []);
  return (
    <main className="center-note" aria-busy={!error}>
      {error ? <><h1>無法開始試玩</h1><p role="alert">{error}</p></> : <p>正在準備試玩活動</p>}
    </main>
  );
}
