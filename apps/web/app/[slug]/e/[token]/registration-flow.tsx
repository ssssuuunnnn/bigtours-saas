'use client';

import { calculateFees } from '@bigtours/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, createClient, type EventState, type Field, type Registration, type SessionAvailability, type Traveler } from '../../../../lib/api';
import { money, t } from '../../../../messages/zh-TW';

/** crypto.randomUUID 只能在 HTTPS 使用；本機以 http://*.lvh.me 開發時改用 getRandomValues。 */
function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const newTraveler = (typeId: string, optionIds: string[]): Traveler => ({
  key: uuid(),
  travelerTypeId: typeId,
  optionIds,
  name: '',
  fieldValues: {},
  requestedRoomNo: 1,
});

const errorText = (e: unknown) => t.errors[e instanceof ApiError ? e.code : 'fallback'] ?? t.errors.fallback!;
const selectionOf = (x: Traveler) => ({ key: x.key, travelerTypeId: x.travelerTypeId, optionIds: x.optionIds });
const shortDate = (d: string | null) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');

export function RegistrationFlow({ slug, token }: { slug: string; token: string }) {
  const api = useMemo(() => createClient(slug, token), [slug, token]);
  const [state, setState] = useState<EventState | null>(null);
  const [fatal, setFatal] = useState<'invalid' | 'failed' | null>(null);
  const [availability, setAvailability] = useState<SessionAvailability[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [travelers, setTravelers] = useState<Traveler[]>([]);
  const [rooms, setRooms] = useState<Record<number, string>>({});
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [clockSkew, setClockSkew] = useState(0);
  const [step, setStep] = useState<'choose' | 'fill' | 'expired'>('choose');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [termsError, setTermsError] = useState(false);
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.state().then((s) => {
      setState(s);
      setAvailability(s.availability);
      setRegistration(s.registration);
      setClockSkew(new Date(s.serverTime).getTime() - Date.now());
      if (s.draft?.travelers.length) {
        setTravelers(s.draft.travelers);
        setRooms(Object.fromEntries(s.draft.roomPreferences.map((p) => [p.requestedRoomNo, p.preferredCoworkerName ?? ''])));
        setRestored(true);
      } else {
        const self = s.travelerTypes.find((x) => x.isEmployeeSelf);
        const first = self ?? s.travelerTypes[0];
        if (first) setTravelers([{ ...newTraveler(first.id, defaultOptions(s)), name: self ? s.employee.name : '' }]);
      }
      if (s.hold) {
        setSessionId(s.hold.sessionId);
        setExpiresAt(new Date(s.hold.expiresAt).getTime());
        if (s.draft?.travelers.length) setStep('fill');
        else api.releaseHold().catch(() => undefined).then(() => setExpiresAt(null));
      }
    }).catch((e) => setFatal(e instanceof ApiError && e.status === 404 ? 'invalid' : 'failed'));
  }, [api]);

  // 即時剩餘名額：實際判斷仍以保留當下為準
  useEffect(() => {
    if (!state || registration || step !== 'choose') return;
    const timer = setInterval(() => api.availability().then(setAvailability).catch(() => undefined), 8000);
    return () => clearInterval(timer);
  }, [api, state, registration, step]);

  // 自動儲存草稿；敏感欄位留空時由伺服器保留原值
  const lastSaved = useRef('');
  useEffect(() => {
    if (step !== 'fill' || !travelers.length) return;
    const body = JSON.stringify(draftBody(travelers, rooms));
    if (body === lastSaved.current) return;
    const timer = setTimeout(() => {
      api.saveDraft(JSON.parse(body)).then(() => { lastSaved.current = body; setSaved(true); }).catch(() => undefined);
    }, 800);
    return () => clearTimeout(timer);
  }, [api, step, travelers, rooms]);

  const onExpired = useCallback(() => { setExpiresAt(null); setStep('expired'); }, []);

  const fees = useMemo(() => {
    if (!state) return null;
    const options = new Map(state.optionGroups.flatMap((g) => g.options).map((o) => [o.id, o.price]));
    const types = new Map(state.travelerTypes.map((x) => [x.id, x.basePrice]));
    return calculateFees(
      travelers.map((x) => ({ basePrice: types.get(x.travelerTypeId) ?? 0, optionPrices: x.optionIds.map((id) => options.get(id) ?? 0) })),
      state.employee.subsidyAmount,
    );
  }, [state, travelers]);

  if (fatal === 'invalid') return <main className="center-note"><h1>{t.invalidLink}</h1><p>{t.invalidLinkHint}</p></main>;
  if (fatal) return <main className="center-note"><p role="alert">{t.loadFailed}</p></main>;
  if (!state || !fees) return <main className="center-note" aria-busy="true"><p>{t.loading}</p></main>;

  const brand = { '--brand': state.agency.primaryColor ?? '#0f766e' } as React.CSSProperties;
  const selfTypeIds = new Set(state.travelerTypes.filter((x) => x.isEmployeeSelf).map((x) => x.id));
  const dependents = travelers.filter((x) => !selfTypeIds.has(x.travelerTypeId)).length;
  const dependentLeft = state.employee.dependentLimit - dependents;
  const firstDependentType = state.travelerTypes.find((x) => !x.isEmployeeSelf);
  const session = availability.find((s) => s.id === sessionId) ?? null;

  const refreshAvailability = () => api.availability().then(setAvailability).catch(() => undefined);

  /** 填寫中修改人數或選項時同步更新保留，不重新計時；失敗時還原。 */
  const changeTravelers = async (next: Traveler[]) => {
    setError(null);
    if (step !== 'fill') { setTravelers(next); return; }
    const previous = travelers;
    setTravelers(next);
    const before = JSON.stringify(previous.map(selectionOf));
    if (before === JSON.stringify(next.map(selectionOf))) return;
    try {
      await api.updateHold(next.map(selectionOf));
    } catch (e) {
      setTravelers(previous);
      setError(errorText(e));
      if (e instanceof ApiError && e.code === 'HOLD_EXPIRED') onExpired();
    }
  };

  const startHold = async () => {
    if (!sessionId) { setError(t.chooseSessionFirst); return; }
    setBusy(true); setError(null);
    try {
      const hold = await api.hold(sessionId, travelers.map(selectionOf));
      setExpiresAt(new Date(hold.expiresAt).getTime());
      await api.saveDraft(draftBody(travelers, rooms));
      setStep('fill');
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(errorText(e));
      await refreshAvailability();
    } finally {
      setBusy(false);
    }
  };

  const abandon = async () => {
    setBusy(true);
    await api.releaseHold().catch(() => undefined);
    await refreshAvailability();
    setExpiresAt(null); setStep('choose'); setBusy(false); setError(null);
  };

  const submit = async () => {
    if (!termsAccepted) { setTermsError(true); return; }
    setBusy(true); setError(null); setFieldErrors(new Set());
    try {
      const reg = await api.submit({ ...draftBody(travelers, rooms), termsAccepted: true });
      setRegistration(reg);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && e.code === 'INVALID_DETAILS' && Array.isArray(e.detail?.errors)) {
        setFieldErrors(new Set(e.detail.errors.map((x: { key: string; field: string }) => `${x.key}:${x.field}`)));
      }
      if (e instanceof ApiError && e.code === 'HOLD_EXPIRED') onExpired();
    } finally {
      setBusy(false);
    }
  };

  if (registration) {
    return (
      <div style={brand}>
        <Masthead state={state} />
        <Done
          registration={registration}
          session={availability.find((s) => s.id === registration.sessionId)}
          fields={state.fields}
          onCancel={async () => setRegistration(await api.requestCancel())}
        />
      </div>
    );
  }

  const picker = (
    <section className="block">
      <h2>{t.travelers}</h2>
      {travelers.map((traveler, index) => (
        <TravelerPicks
          key={traveler.key}
          index={index}
          traveler={traveler}
          state={state}
          session={session}
          canApplyToAll={travelers.length > 1}
          onChange={(next) => changeTravelers(travelers.map((x) => (x.key === next.key ? next : x)))}
          onRemove={() => changeTravelers(travelers.filter((x) => x.key !== traveler.key))}
          onApplyAll={() => changeTravelers(travelers.map((x) => ({ ...x, optionIds: traveler.optionIds })))}
        />
      ))}
      {firstDependentType && state.employee.dependentLimit > 0 ? (
        <div className="add-row">
          <button type="button" className="ghost" disabled={dependentLeft <= 0} onClick={() => changeTravelers([...travelers, newTraveler(firstDependentType.id, defaultOptions(state))])}>
            {t.addDependent}
          </button>
          <span className="muted">{t.dependentLeft(Math.max(dependentLeft, 0))}</span>
        </div>
      ) : <p className="muted">{t.noDependent}</p>}
    </section>
  );

  if (step === 'expired') {
    return (
      <div style={brand}>
        <Masthead state={state} />
        <main className="page">
          <section className="block expired" role="alert">
            <h2>{t.expiredTitle}</h2>
            <p>{t.expiredHint}</p>
            {error && <p className="error">{error}</p>}
            <button type="button" className="primary wide" disabled={busy} onClick={startHold}>{t.rehold}</button>
            <button type="button" className="ghost wide" disabled={busy} onClick={abandon}>{t.backToChoose}</button>
          </section>
        </main>
      </div>
    );
  }

  if (step === 'fill') {
    const usedRooms = [...new Set(travelers.map((x) => x.requestedRoomNo ?? 1))].sort((a, b) => a - b);
    return (
      <div style={brand}>
        <Countdown expiresAt={expiresAt} skew={clockSkew} onExpired={onExpired} session={session} />
        <main className="page has-bar">
          <h1 className="fill-title">{t.fillTitle}</h1>
          {error && <p className="error" role="alert">{error}</p>}
          <details className="edit-picks">
            <summary>{t.editPicks}</summary>
            {picker}
          </details>
          {travelers.map((traveler, index) => (
            <section className="block" key={traveler.key}>
              <h2>{t.travelerN(index + 1)}</h2>
              <TextField
                label={t.name}
                required
                invalid={fieldErrors.has(`${traveler.key}:name`)}
                value={traveler.name}
                onChange={(name) => setTravelers(travelers.map((x) => (x.key === traveler.key ? { ...x, name } : x)))}
              />
              {state.fields.map((field) => (
                <FieldInput
                  key={field.key}
                  field={field}
                  traveler={traveler}
                  invalid={fieldErrors.has(`${traveler.key}:${field.key}`)}
                  onChange={(value) => setTravelers(travelers.map((x) => (x.key === traveler.key ? { ...x, fieldValues: { ...x.fieldValues, [field.key]: value } } : x)))}
                />
              ))}
              <label className="field">
                <span>{t.roomOf}</span>
                <select
                  value={traveler.requestedRoomNo ?? 1}
                  onChange={(e) => setTravelers(travelers.map((x) => (x.key === traveler.key ? { ...x, requestedRoomNo: Number(e.target.value) } : x)))}
                >
                  {travelers.map((_, i) => <option key={i} value={i + 1}>{t.roomN(i + 1)}</option>)}
                </select>
              </label>
            </section>
          ))}
          <section className="block">
            <h2>{t.rooms}</h2>
            <p className="muted">{t.roomsHint}</p>
            {usedRooms.map((no) => (
              <TextField key={no} label={t.coworker(no)} value={rooms[no] ?? ''} onChange={(v) => setRooms({ ...rooms, [no]: v })} />
            ))}
          </section>
          <section className="block">
            <label className="check">
              <input type="checkbox" checked={termsAccepted} onChange={(e) => { setTermsAccepted(e.target.checked); setTermsError(false); }} />
              <span>{t.terms}</span>
            </label>
            {termsError && <p className="error">{t.termsRequired}</p>}
            <button type="button" className="ghost wide abandon" disabled={busy} onClick={abandon}>{t.backToChoose}</button>
          </section>
        </main>
        <FeeBar fees={fees} error={error} note={saved ? t.saving : undefined}>
          <button type="button" className="primary" disabled={busy} onClick={submit}>{busy ? t.submitting : t.submit}</button>
        </FeeBar>
      </div>
    );
  }

  const open = state.event.openState === 'open';
  return (
    <div style={brand}>
      <Masthead state={state} />
      <main className="page has-bar">
        {restored && <p className="notice">{t.draftRestored}</p>}
        <Itinerary state={state} />
        <Board sessions={availability} selected={sessionId} onSelect={(id) => { setSessionId(id); setError(null); }} disabled={!open} />
        {!open && <p className="notice">{state.event.openState === 'closed' ? t.closed : t.notOpen}</p>}
        {open && picker}
      </main>
      {open && (
        <FeeBar fees={fees} error={error} note={t.holdNote}>
          <button type="button" className="primary" disabled={busy} onClick={startHold}>{t.startFilling}</button>
        </FeeBar>
      )}
    </div>
  );
}

function defaultOptions(s: EventState): string[] {
  return s.optionGroups.filter((g) => g.minSelect > 0).flatMap((g) => g.options.slice(0, g.minSelect).map((o) => o.id));
}

function draftBody(travelers: Traveler[], rooms: Record<number, string>) {
  const used = new Set(travelers.map((x) => x.requestedRoomNo ?? 1));
  return {
    travelers: travelers.map(({ masks: _masks, ...x }) => x),
    roomPreferences: Object.entries(rooms)
      .filter(([no, name]) => name.trim() && used.has(Number(no)))
      .map(([no, name]) => ({ requestedRoomNo: Number(no), preferredCoworkerName: name.trim(), note: null })),
  };
}

function Masthead({ state }: { state: EventState }) {
  return (
    <header className="masthead">
      <p className="agency">{state.agency.name}</p>
      <h1>{state.event.name}</h1>
      <p className="who">
        {t.greeting(state.employee.name)}
        {state.employee.subsidyAmount > 0 && <span>{t.subsidy(money(state.employee.subsidyAmount))}</span>}
      </p>
    </header>
  );
}

function Itinerary({ state }: { state: EventState }) {
  const { summary, days } = state.event.itinerary;
  if (!summary && !days?.length) return null;
  return (
    <section className="block">
      <h2>{t.itinerary}</h2>
      {summary && <p>{summary}</p>}
      {days && (
        <ol className="days">
          {days.map((d) => <li key={d.title}><strong>{d.title}</strong><span>{d.description}</span></li>)}
        </ol>
      )}
    </section>
  );
}

/** 出發看板：這個頁面唯一的重點視覺。 */
function Board({ sessions, selected, onSelect, disabled }: { sessions: SessionAvailability[]; selected: string | null; onSelect: (id: string) => void; disabled: boolean }) {
  return (
    <section className="board" aria-label={t.departures}>
      <h2>{t.departures}</h2>
      {sessions.map((s) => {
        const blocked = disabled || s.status !== 'available';
        return (
          <button key={s.id} type="button" className="board-row" aria-pressed={selected === s.id} disabled={blocked} onClick={() => onSelect(s.id)}>
            <span className="board-date">{shortDate(s.departsOn)}<small>{s.returnsOn ? `－${shortDate(s.returnsOn)}` : ''}</small></span>
            <span className="board-name">{s.name}</span>
            <span className={`board-seats ${s.status}`}>
              {s.status === 'available' ? t.remaining(s.remaining) : s.status === 'held' ? t.heldOut : t.soldOut}
            </span>
          </button>
        );
      })}
    </section>
  );
}

function TravelerPicks({ index, traveler, state, session, canApplyToAll, onChange, onRemove, onApplyAll }: {
  index: number; traveler: Traveler; state: EventState; session: SessionAvailability | null; canApplyToAll: boolean;
  onChange: (t: Traveler) => void; onRemove: () => void; onApplyAll: () => void;
}) {
  const type = state.travelerTypes.find((x) => x.id === traveler.travelerTypeId);
  const isSelf = !!type?.isEmployeeSelf;
  const typeChoices = state.travelerTypes.filter((x) => !x.isEmployeeSelf);
  const toggle = (groupId: string, max: number, optionId: string) => {
    const group = state.optionGroups.find((g) => g.id === groupId)!;
    const inGroup = new Set(group.options.map((o) => o.id));
    const has = traveler.optionIds.includes(optionId);
    let next: string[];
    if (max === 1) next = [...traveler.optionIds.filter((id) => !inGroup.has(id)), optionId];
    else if (has) next = traveler.optionIds.filter((id) => id !== optionId);
    else if (traveler.optionIds.filter((id) => inGroup.has(id)).length >= max) return;
    else next = [...traveler.optionIds, optionId];
    if (max === 1 && has && group.minSelect === 0) next = traveler.optionIds.filter((id) => id !== optionId);
    onChange({ ...traveler, optionIds: next });
  };
  return (
    <div className="traveler">
      <div className="traveler-head">
        <h3>{t.travelerN(index + 1)}</h3>
        {isSelf || (state.event.allowDependentsOnly && index === 0) ? <span className="price">{type?.name} {money(type?.basePrice ?? 0)}</span> : (
          <>
            <label className="sr-only" htmlFor={`type-${traveler.key}`}>{t.travelerType}</label>
            <select id={`type-${traveler.key}`} value={traveler.travelerTypeId} onChange={(e) => onChange({ ...traveler, travelerTypeId: e.target.value })}>
              {typeChoices.map((x) => <option key={x.id} value={x.id}>{x.name} {money(x.basePrice)}</option>)}
            </select>
            <button type="button" className="link" onClick={onRemove}>{t.remove}</button>
          </>
        )}
      </div>
      {state.optionGroups.map((group) => (
        <fieldset key={group.id} className="group">
          <legend>{group.name}<small>{group.isRequired ? t.required : t.chooseMax(group.maxSelect)}</small></legend>
          {group.options.map((option) => {
            const quota = session?.options.find((q) => q.optionId === option.id);
            const checked = traveler.optionIds.includes(option.id);
            const blocked = !checked && !!quota && quota.status !== 'available';
            return (
              <label key={option.id} className={`choice${checked ? ' on' : ''}${blocked ? ' off' : ''}`}>
                <input type={group.maxSelect === 1 ? 'radio' : 'checkbox'} name={`${traveler.key}-${group.id}`} checked={checked} disabled={blocked} onChange={() => toggle(group.id, group.maxSelect, option.id)} />
                <span>{option.name}</span>
                <span className="choice-side">
                  {quota && quota.status === 'sold_out' ? t.soldOut : quota && quota.status === 'held' ? t.optionHeld : quota ? t.remaining(quota.remaining) : ''}
                  <b>{option.price ? t.plusPrice(money(option.price)) : t.included}</b>
                </span>
              </label>
            );
          })}
        </fieldset>
      ))}
      {canApplyToAll && <button type="button" className="link" onClick={onApplyAll}>{t.applyToAll}</button>}
    </div>
  );
}

function TextField({ label, value, onChange, required, invalid, type = 'text', placeholder, hint }: {
  label: string; value: string; onChange: (v: string) => void; required?: boolean; invalid?: boolean; type?: string; placeholder?: string; hint?: string;
}) {
  return (
    <label className={`field${invalid ? ' invalid' : ''}`}>
      <span>{label}{required && <em aria-hidden="true"> *</em>}</span>
      <input type={type} value={value} placeholder={placeholder} aria-invalid={invalid} onChange={(e) => onChange(e.target.value)} />
      {hint && <small>{hint}</small>}
      {invalid && <small className="error">{t.fieldRequired}</small>}
    </label>
  );
}

function FieldInput({ field, traveler, invalid, onChange }: { field: Field; traveler: Traveler; invalid: boolean; onChange: (v: string) => void }) {
  const value = (traveler.fieldValues[field.key] as string | undefined) ?? '';
  const mask = traveler.masks?.[field.key];
  if (field.type === 'select') {
    return (
      <label className={`field${invalid ? ' invalid' : ''}`}>
        <span>{field.label}{field.isRequired && <em aria-hidden="true"> *</em>}</span>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t.selectPlaceholder}</option>
          {(field.choices ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {invalid && <small className="error">{t.fieldRequired}</small>}
      </label>
    );
  }
  return (
    <TextField
      label={field.label}
      required={field.isRequired}
      invalid={invalid}
      type={field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'}
      value={value}
      hint={mask ? t.savedMask(mask) : undefined}
      onChange={onChange}
    />
  );
}

function Countdown({ expiresAt, skew, onExpired, session }: { expiresAt: number | null; skew: number; onExpired: () => void; session: SessionAvailability | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = expiresAt ? Math.min(Math.max(Math.ceil((expiresAt - now - skew) / 1000), 0), 15 * 60) : 0;
  useEffect(() => { if (expiresAt && left === 0) onExpired(); }, [expiresAt, left, onExpired]);
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  return (
    <div className={`countdown${left <= 120 ? ' urgent' : ''}`} role="timer" aria-label={t.timerLabel}>
      <span>{t.timerLabel}{session ? `｜${session.name}` : ''}</span>
      <strong>{mm}:{ss}</strong>
    </div>
  );
}

function FeeBar({ fees, error, note, children }: { fees: { total: number; subsidyApplied: number; selfPay: number }; error: string | null; note?: string; children: React.ReactNode }) {
  return (
    <div className="fee-bar">
      {error && <p className="error" role="alert">{error}</p>}
      <div className="fee-row">
        <div className="fee-text">
          <span className="fee-label">{t.selfPay}</span>
          <strong>{money(fees.selfPay)}</strong>
          <small>{t.total} {money(fees.total)}｜{t.subsidyLine} -{money(fees.subsidyApplied)}</small>
        </div>
        {children}
      </div>
      {note && <p className="fee-note">{note}</p>}
    </div>
  );
}

function Done({ registration: r, session, fields, onCancel }: { registration: Registration; session?: SessionAvailability; fields: Field[]; onCancel: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requested = r.status === 'cancel_requested';
  return (
    <main className="page">
      <section className="block done">
        <h2>{requested ? t.cancelRequestedTitle : t.doneTitle}</h2>
        {requested && <p>{t.cancelRequestedHint}</p>}
        <dl className="summary">
          {session && <div><dt>{t.session}</dt><dd>{session.name} {shortDate(session.departsOn)}</dd></div>}
          <div><dt>{t.total}</dt><dd>{money(r.totalAmount)}</dd></div>
          <div><dt>{t.subsidyLine}</dt><dd>-{money(r.subsidyApplied)}</dd></div>
          <div className="strong"><dt>{t.selfPay}</dt><dd>{money(r.selfPayAmount)}</dd></div>
          <div><dt>{t.paymentStatus}</dt><dd>{t.payment[r.paymentStatus]}</dd></div>
        </dl>
      </section>
      {r.travelers.map((x, i) => (
        <section className="block" key={i}>
          <h2>{x.name}<small className="muted"> {x.travelerTypeName}</small></h2>
          <dl className="summary">
            {fields.filter((f) => x.fieldValues[f.key]).map((f) => <div key={f.key}><dt>{f.label}</dt><dd>{String(x.fieldValues[f.key])}</dd></div>)}
            {x.options.map((o) => <div key={o.name}><dt>{o.name}</dt><dd>{o.price ? money(o.price) : t.included}</dd></div>)}
            {x.requestedRoomNo && <div><dt>{t.rooms}</dt><dd>{t.roomRequest(x.requestedRoomNo)}</dd></div>}
          </dl>
        </section>
      ))}
      {!requested && (
        <section className="block">
          {error && <p className="error" role="alert">{error}</p>}
          {confirming ? (
            <>
              <p>{t.cancelWarning}</p>
              <button type="button" className="danger wide" onClick={() => onCancel().catch((e) => setError(errorText(e)))}>{t.confirmCancel}</button>
              <button type="button" className="ghost wide" onClick={() => setConfirming(false)}>{t.keep}</button>
            </>
          ) : <button type="button" className="ghost wide" onClick={() => setConfirming(true)}>{t.requestCancel}</button>}
        </section>
      )}
    </main>
  );
}
