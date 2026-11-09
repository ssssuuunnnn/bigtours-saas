'use client';

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { a } from '../../messages/admin';

/** 可複製的網址欄位，給 LINE 連結使用。 */
export function CopyUrl({ id, label, url }: { id: string; label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      document.getElementById(id)?.focus();
    }
  };
  return (
    <div>
      <label className="field" htmlFor={id}><span>{label}</span></label>
      <div className="admin-link-url">
        <input id={id} type="text" readOnly value={url} onFocus={(e) => e.target.select()} />
        <button type="button" className="ghost" onClick={copy}>{copied ? a.linkCopied : a.linkCopy}</button>
      </div>
    </div>
  );
}

/** 活動的 LINE 連結與 QR Code，旅行社與企業窗口的員工名單都會顯示。 */
export function EventLineLink({ url, boundCount }: { url: string; boundCount: number }) {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 480, errorCorrectionLevel: 'M' }).then(setQr).catch(() => setQr(null));
  }, [url]);
  return (
    <div className="admin-card admin-line-card">
      <div>
        <h2>{a.line.title}</h2>
        <p className="muted">{a.line.boundCount(boundCount)}</p>
      </div>
      <CopyUrl id="event-line-url" label={a.line.eventUrl} url={url} />
      <small className="muted">{a.line.eventUrlHint}</small>
      {qr && (
        <div className="admin-line-qr">
          <img src={qr} alt={a.line.qrAlt} width={160} height={160} />
          <a className="link" href={qr} download={`line-${url.split('/').pop()}.png`}>{a.line.qrDownload}</a>
        </div>
      )}
    </div>
  );
}
