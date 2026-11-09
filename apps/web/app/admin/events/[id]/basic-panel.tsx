'use client';

import { readableOn } from '@bigtours/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { adminApi, type AdminEvent } from '../../../../lib/admin-api';
import { a } from '../../../../messages/admin';
import { adminError } from '../../admin-shell';
import { ImagesField } from './images-field';
import { DaysEditor } from './days-editor';

const HEX = /^#[0-9A-Fa-f]{6}$/;

export function BasicPanel({ event, onSaved }: { event: AdminEvent; onSaved: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(event.name);
  const [slug, setSlug] = useState(event.slug);
  const [days, setDays] = useState(event.days.length ? event.days : [{ title: a.dayTitle(1), description: '' }]);
  const [themeColor, setThemeColor] = useState(event.themeColor);
  const [supportPhone, setSupportPhone] = useState(event.supportPhone ?? '');
  const [supportHours, setSupportHours] = useState(event.supportHours ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isDraft = event.status === 'draft';
  const colorOk = HEX.test(themeColor);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await adminApi.updateBasic(event.id, { name, slug, days, themeColor, supportPhone: supportPhone || null, supportHours: supportHours || null });
      onSaved();
    } catch (err) {
      setError(adminError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(a.confirmDeleteEvent(event.name))) return;
    setError(null);
    try {
      await adminApi.deleteEvent(event.id);
      router.push('/admin');
    } catch (err) {
      setError(adminError(err));
    }
  };

  return (
    <form className="admin-form" onSubmit={submit}>
      {error && <p className="error span-3" role="alert">{error}</p>}
      <label className="field"><span>{a.eventName}</span><input type="text" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>{a.slug}</span><input type="text" required minLength={2} maxLength={50} disabled={!isDraft} value={slug} onChange={(e) => setSlug(e.target.value)} />{!isDraft && <small className="muted">{a.slugLocked}</small>}</label>
      <label className="field"><span>{a.company}</span><input type="text" disabled value={event.companyName} /></label>

      <fieldset className="span-3">
        <legend>{a.itineraryDays}</legend>
        <DaysEditor days={days} onChange={setDays} />
        <small className="muted">{a.itineraryDefaultHint}</small>
      </fieldset>

      <ImagesField event={event} onChanged={onSaved} />

      <fieldset className="span-3">
        <legend>{a.themeColor}</legend>
        <div className="admin-color">
          <input type="color" aria-label={a.pickColor} value={colorOk ? themeColor : '#000000'} onChange={(e) => setThemeColor(e.target.value)} />
          <input type="text" aria-label={a.colorCode} required pattern="#[0-9A-Fa-f]{6}" value={themeColor} onChange={(e) => setThemeColor(e.target.value)} />
          {colorOk && <span className="admin-color-sample" style={{ background: themeColor, color: readableOn(themeColor) }}>{a.colorSample}</span>}
        </div>
        <small className="muted">{a.themeColorHint}</small>
      </fieldset>

      <label className="field"><span>{a.supportPhone}</span><input type="text" maxLength={30} value={supportPhone} onChange={(e) => setSupportPhone(e.target.value)} /></label>
      <label className="field"><span>{a.supportHours}</span><input type="text" maxLength={100} value={supportHours} onChange={(e) => setSupportHours(e.target.value)} /></label>

      <div className="admin-form-actions span-3">
        <button type="submit" className="primary" disabled={busy}>{a.save}</button>
        {isDraft && <button type="button" className="link" onClick={remove}>{a.deleteEvent}</button>}
      </div>
    </form>
  );
}
