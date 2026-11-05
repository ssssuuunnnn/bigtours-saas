'use client';

import { useState } from 'react';
import { adminApi, type AdminEvent, type ImageKind } from '../../../../lib/admin-api';
import { a } from '../../../../messages/admin';
import { adminError } from '../../admin-shell';

const MAX_BYTES = 5 * 1024 * 1024;

export function ImagesField({ event, onChanged }: { event: AdminEvent; onChanged: () => void }) {
  const [busy, setBusy] = useState<ImageKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url: Record<ImageKind, string | null> = { login: event.images.login, 'login-mobile': event.images.loginMobile, home: event.images.home };

  const run = async (kind: ImageKind, action: () => Promise<unknown>) => {
    setError(null); setBusy(kind);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(adminError(err));
    } finally {
      setBusy(null);
    }
  };
  const upload = (kind: ImageKind, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_BYTES) { setError(a.imageSizeError); return; }
    void run(kind, () => adminApi.uploadImage(event.id, kind, file));
  };

  return (
    <fieldset className="span-3">
      <legend>{a.imagesTitle}</legend>
      <small className="muted">{a.imagesHint}</small>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="admin-images">
        {(['login', 'login-mobile', 'home'] as const).map((kind) => (
          <div key={kind} className="admin-image-row">
            <div className="admin-image-thumb">
              {url[kind] ? <img src={url[kind]!} alt={a.imageKinds[kind].label} /> : a.imageNone}
            </div>
            <div>
              <strong>{a.imageKinds[kind].label}</strong>
              <small className="muted">{a.imageKinds[kind].hint}</small>
              <div className="admin-file-row">
                <input id={`image-${kind}`} className="admin-file-input" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy !== null} aria-label={a.imageKinds[kind].label} onChange={(e) => upload(kind, e)} />
                <label htmlFor={`image-${kind}`} className="link">{busy === kind ? a.imageUploading : url[kind] ? a.imageReplace : a.imageUpload}</label>
                {url[kind] && <button type="button" className="link" disabled={busy !== null} onClick={() => run(kind, () => adminApi.deleteImage(event.id, kind))}>{a.imageRemove}</button>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </fieldset>
  );
}
