'use client';

import { useEffect, useRef, useState } from 'react';

const EVENT = 'bt:done';
const SHOW_MS = 2500;

/** 寫入成功後呼叫；畫面上方中央顯示完成提示，不論捲到哪裡都看得到。 */
export function notifyDone(message: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: message }));
}

/** 放在後台外框，收到完成通知時顯示幾秒後自動消失。 */
export function DoneToast() {
  const [message, setMessage] = useState<string | null>(null);
  // 連續操作時每次都重新計時，並讓報讀軟體再讀一次。
  const [seq, setSeq] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const show = (e: Event) => {
      setMessage((e as CustomEvent<string>).detail);
      setSeq((n) => n + 1);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setMessage(null), SHOW_MS);
    };
    window.addEventListener(EVENT, show);
    return () => {
      window.removeEventListener(EVENT, show);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <div className="done-toast-region" role="status" aria-live="polite">
      {message && <p key={seq} className="done-toast"><span aria-hidden="true">✓</span> {message}</p>}
    </div>
  );
}
