'use client';

import { calculateFees } from '@bigtours/shared';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, createClient, type EventState, type Field, type Registration, type SessionAvailability, type Traveler } from '../../lib/api';
import { formatDateTime, money, t } from '../../messages/zh-TW';
import { brandStyle } from '../../lib/brand';
import { modifiedFees, uuid } from '../../lib/fees';

const newTraveler = (typeId: string, optionIds: string[]): Traveler => ({
  key: uuid(),
  travelerTypeId: typeId,
  optionIds,
  roomTypeId: null,
  preferences: {},
  name: '',
  fieldValues: {},
  requestedRoomNo: 1,
});

const errorText = (e: unknown) => t.errors[e instanceof ApiError ? e.code : 'fallback'] ?? t.errors.fallback!;
const selectionOf = (x: Traveler) => ({ key: x.key, travelerTypeId: x.travelerTypeId, optionIds: x.optionIds, roomTypeId: x.roomTypeId, preferences: x.preferences });
const shortDate = (d: string | null) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');
/** 例如 3/12（五）。日期沒有時區，以 UTC 計算星期避免差一天。 */
const dateWithWeekday = (d: string) => `${shortDate(d)}（${'日一二三四五六'[new Date(`${d}T00:00:00Z`).getUTCDay()]}）`;

export function RegistrationFlow({ slug, onSignedOut, onPageClosed }: { slug: string; onSignedOut: () => void; onPageClosed: () => void }) {
  const api = useMemo(() => createClient(slug), [slug]);
  const [state, setState] = useState<EventState | null>(null);
  const [fatal, setFatal] = useState<'failed' | null>(null);
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
  // 修改已送出的報名：沒保留到新內容的名額前，目標梯次先放在 pendingSessionId。
  const [modifying, setModifying] = useState(false);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

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
      // 修改到一半重新整理：還在保留就回到修改頁，已逾時就問要不要重新保留。
      if (s.registration?.status === 'confirmed' && s.event.openState === 'open' && s.draft?.travelers.length) {
        setRestored(false);
        setModifying(true);
        if (s.hold?.modifying) {
          setSessionId(s.hold.sessionId);
          setExpiresAt(new Date(s.hold.expiresAt).getTime());
          setStep('fill');
        } else {
          setSessionId(s.modificationSessionId ?? s.registration.sessionId);
          setStep('expired');
        }
      } else if (s.hold) {
        setSessionId(s.hold.sessionId);
        setExpiresAt(new Date(s.hold.expiresAt).getTime());
        if (s.draft?.travelers.length) setStep('fill');
        else api.releaseHold().catch(() => undefined).then(() => setExpiresAt(null));
      }
    }).catch((e) => {
      if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') onSignedOut();
      else if (e instanceof ApiError && e.code === 'PAGE_CLOSED') onPageClosed();
      else setFatal('failed');
    });
  }, [api, onSignedOut, onPageClosed]);

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
    const surcharges = new Map(availability.flatMap((s) => s.roomTypes).map((r) => [r.id, r.surcharge]));
    return calculateFees(
      travelers.map((x) => ({ basePrice: types.get(x.travelerTypeId) ?? 0, roomSurcharge: x.roomTypeId ? surcharges.get(x.roomTypeId) ?? 0 : 0, optionPrices: x.optionIds.map((id) => options.get(id) ?? 0) })),
      state.employee.subsidyAmount,
    );
  }, [state, travelers, availability]);

  if (fatal) return <main className="center-note"><p role="alert">{t.loadFailed}</p></main>;
  if (!state || !fees) return <main className="center-note" aria-busy="true"><p>{t.loading}</p></main>;

  const brand = brandStyle(state.event.themeColor);
  const selfTypeIds = new Set(state.travelerTypes.filter((x) => x.isEmployeeSelf).map((x) => x.id));
  const dependents = travelers.filter((x) => !selfTypeIds.has(x.travelerTypeId)).length;
  const dependentLeft = state.employee.dependentLimit - dependents;
  const firstDependentType = state.travelerTypes.find((x) => !x.isEmployeeSelf);
  const session = availability.find((s) => s.id === (pendingSessionId ?? sessionId)) ?? null;
  const ownIds = new Set(modifying && registration ? registration.travelers.flatMap((x) => [...x.options.map((o) => o.optionId), ...(x.roomTypeId ? [x.roomTypeId] : [])]) : []);

  const logout = () => api.logout().catch(() => undefined).then(onSignedOut);
  const masthead = <Masthead state={state} onLogout={logout} />;

  const refreshAvailability = () => api.availability().then(setAvailability).catch(() => undefined);

  const seatsComplete = (list: Traveler[], target: SessionAvailability | null) =>
    !target?.roomTypes.length || list.every((x) => !occupiesBed(state, x) || x.roomTypeId);

  /** 修改中：內容完整才保留名額，還沒選好房型時先留在畫面上；保留時間不會重新計算。 */
  const applyModification = async (next: Traveler[], target: string) => {
    const previous = travelers;
    const alreadyHeld = target === sessionId && !pendingSessionId;
    setError(null);
    setTravelers(next);
    if (!seatsComplete(next, availability.find((s) => s.id === target) ?? null)) { setPendingSessionId(target); return; }
    if (alreadyHeld && JSON.stringify(previous.map(selectionOf)) === JSON.stringify(next.map(selectionOf))) return;
    try {
      const hold = alreadyHeld ? await api.updateHold(next.map(selectionOf)) : await api.modificationHold(target, next.map(selectionOf));
      setSessionId(target);
      setPendingSessionId(null);
      setExpiresAt(new Date(hold.expiresAt).getTime());
    } catch (e) {
      setError(errorText(e));
      if (alreadyHeld) setTravelers(previous);
      else setPendingSessionId(target);
      await refreshAvailability();
      if (e instanceof ApiError && e.code === 'HOLD_EXPIRED') onExpired();
    }
  };

  /** 填寫中修改人數或選項時同步更新保留，不重新計時；失敗時還原。 */
  const changeTravelers = async (next: Traveler[]) => {
    setError(null);
    if (step !== 'fill') { setTravelers(next); return; }
    if (modifying) { await applyModification(next, pendingSessionId ?? sessionId!); return; }
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
    if (session?.roomTypes.length && travelers.some((x) => occupiesBed(state, x) && !x.roomTypeId)) { setError(t.roomTypeRequired); return; }
    setBusy(true); setError(null);
    try {
      const target = pendingSessionId ?? sessionId;
      const hold = modifying ? await api.modificationHold(target, travelers.map(selectionOf)) : await api.hold(sessionId, travelers.map(selectionOf));
      setExpiresAt(new Date(hold.expiresAt).getTime());
      await api.saveDraft(draftBody(travelers, rooms));
      setSessionId(target);
      setPendingSessionId(null);
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
    setModifying(false); setPendingSessionId(null);
  };

  /** 開始修改：先保留目前內容（不佔新名額），之後改動才計算差額。 */
  const startModify = async () => {
    const r = registration!;
    const next: Traveler[] = r.travelers.map((x) => ({
      key: x.id,
      travelerTypeId: x.travelerTypeId,
      optionIds: x.options.map((o) => o.optionId),
      roomTypeId: x.roomTypeId,
      preferences: x.preferenceIds,
      name: x.name,
      fieldValues: x.plainValues,
      requestedRoomNo: x.requestedRoomNo ?? 1,
      masks: x.masks,
    }));
    const nextRooms = Object.fromEntries(r.roomPreferences.map((p) => [p.requestedRoomNo, p.preferredCoworkerName ?? '']));
    const hold = await api.modificationHold(r.sessionId, next.map(selectionOf));
    await api.saveDraft(draftBody(next, nextRooms));
    await refreshAvailability();
    lastSaved.current = '';
    setTravelers(next);
    setRooms(nextRooms);
    setSessionId(r.sessionId);
    setPendingSessionId(null);
    setExpanded(new Set());
    setExpiresAt(new Date(hold.expiresAt).getTime());
    setError(null);
    setNotice(null);
    setFieldErrors(new Set());
    setModifying(true);
    setStep('fill');
    window.scrollTo({ top: 0 });
  };

  const submitModification = async () => {
    if (pendingSessionId) { setError(t.modify.needRoom); return; }
    setBusy(true); setError(null); setFieldErrors(new Set());
    try {
      const reg = await api.submitModification(draftBody(travelers, rooms));
      setRegistration(reg);
      await refreshAvailability();
      setModifying(false);
      setExpiresAt(null);
      setStep('choose');
      setNotice(t.modify.done);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && e.code === 'INVALID_DETAILS' && Array.isArray(e.detail?.errors)) {
        const invalid: { key: string; field: string }[] = e.detail.errors;
        setFieldErrors(new Set(invalid.map((x) => `${x.key}:${x.field}`)));
        setExpanded(new Set([...expanded, ...invalid.map((x) => x.key)]));
      }
      if (e instanceof ApiError && e.code === 'HOLD_EXPIRED') onExpired();
    } finally {
      setBusy(false);
    }
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

  if (registration && !modifying) {
    return (
      <div style={brand}>
        {masthead}
        <Done
          paymentInstructions={state.event.paymentInstructions}
          slug={state.event.slug}
          registration={registration}
          session={availability.find((s) => s.id === registration.sessionId)}
          fields={state.fields}
          onCancel={async () => setRegistration(await api.requestCancel())}
          notice={notice}
          modifyUntil={state.event.openState === 'open' && registration.status === 'confirmed' ? formatDateTime(state.event.registrationClosesAt) : null}
          onModify={startModify}
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
          ownIds={ownIds}
          canApplyToAll={travelers.length > 1}
          onChange={(next) => changeTravelers(travelers.map((x) => (x.key === next.key ? roomRule(state, session, next) : x)))}
          onRemove={() => changeTravelers(travelers.filter((x) => x.key !== traveler.key))}
          onApplyAll={() => changeTravelers(travelers.map((x) => ({ ...x, optionIds: traveler.optionIds, preferences: traveler.preferences })))}
        />
      ))}
      {firstDependentType && state.employee.dependentLimit > 0 ? (
        <div className="add-row">
          <button type="button" className="ghost" disabled={dependentLeft <= 0} onClick={() => changeTravelers([...travelers, roomRule(state, session, newTraveler(firstDependentType.id, defaultOptions(state)))])}>
            {t.addDependent}
          </button>
          <span className="muted">{t.dependentLeft(Math.max(dependentLeft, 0))}</span>
        </div>
      ) : <p className="muted">{t.noDependent}</p>}
    </section>
  );

  if (step === 'expired' && modifying && registration) {
    const current = availability.find((s) => s.id === registration.sessionId);
    return (
      <div style={brand}>
        {masthead}
        <main className="page">
          <section className="block expired" role="alert">
            <h2>{t.modify.expiredTitle}</h2>
            <p>{t.modify.expiredHint}</p>
            <dl className="summary">
              <div><dt>{t.modify.effective}</dt><dd>{t.modify.effectiveLine(current?.name ?? '', registration.travelers.length, money(registration.selfPayAmount))}</dd></div>
            </dl>
            {error && <p className="error">{error}</p>}
            <button type="button" className="primary wide" disabled={busy} onClick={startHold}>{t.modify.rehold}</button>
            <button type="button" className="ghost wide" disabled={busy} onClick={abandon}>{t.modify.abandon}</button>
          </section>
        </main>
      </div>
    );
  }

  if (step === 'expired') {
    return (
      <div style={brand}>
        {masthead}
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

  const usedRooms = [...new Set(travelers.map((x) => x.requestedRoomNo ?? 1))].sort((a, b) => a - b);
  const travelerForm = (traveler: Traveler) => (
    <>
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
      {traveler.roomTypeId && <p className="muted">{t.roomType}：{session?.roomTypes.find((r) => r.id === traveler.roomTypeId)?.name}</p>}
      <label className="field">
        <span>{t.roomOf}</span>
        <select
          value={traveler.requestedRoomNo ?? 1}
          onChange={(e) => setTravelers(travelers.map((x) => (x.key === traveler.key ? { ...x, requestedRoomNo: Number(e.target.value) } : x)))}
        >
          {travelers.map((_, i) => <option key={i} value={i + 1}>{t.roomN(i + 1)}</option>)}
        </select>
      </label>
    </>
  );
  const roomsBlock = (
    <section className="block">
      <h2>{t.rooms}</h2>
      <p className="muted">{t.roomsHint}</p>
      {mismatchedRooms(state, session, travelers).map((no) => <p key={no} className="notice" role="status">{t.roomMismatch(no)}</p>)}
      {usedRooms.map((no) => (
        <TextField key={no} label={t.coworker(no)} value={rooms[no] ?? ''} onChange={(v) => setRooms({ ...rooms, [no]: v })} />
      ))}
    </section>
  );

  if (step === 'fill' && modifying && registration) {
    const allOptions = state.optionGroups.flatMap((g) => g.options);
    const nextFees = modifiedFees(registration, travelers, {
      types: new Map(state.travelerTypes.map((x) => [x.id, x.basePrice])),
      rooms: new Map(availability.flatMap((s) => s.roomTypes).map((r) => [r.id, r.surcharge])),
      options: new Map(allOptions.map((o) => [o.id, o.price])),
    });
    const toggle = (key: string) => {
      const next = new Set(expanded);
      if (next.has(key)) next.delete(key); else next.add(key);
      setExpanded(next);
    };
    const addType = (typeId: string) => {
      const added = roomRule(state, session, newTraveler(typeId, defaultOptions(state)));
      setExpanded(new Set([...expanded, added.key]));
      void changeTravelers([...travelers, added]);
    };
    const removeTraveler = (traveler: Traveler) => {
      if (traveler.name && !window.confirm(t.modify.removeConfirm(traveler.name))) return;
      void changeTravelers(travelers.filter((x) => x.key !== traveler.key));
    };
    return (
      <div style={brand}>
        <Countdown expiresAt={expiresAt} skew={clockSkew} onExpired={onExpired} session={session} />
        <main className="page has-bar">
          <h1 className="fill-title">{t.modify.title}</h1>
          <p className="notice">{t.modify.banner}</p>
          {error && <p className="error" role="alert">{error}</p>}
          <details className="edit-picks" open={!!pendingSessionId || undefined}>
            <summary>{session ? t.modify.current(session.name, travelers.length) : ''}<span className="edit-picks-action">{t.modify.changeParty}</span></summary>
            <Board
              sessions={availability}
              selected={pendingSessionId ?? sessionId}
              ownSessionId={registration.sessionId}
              onSelect={(id) => {
                const next = availability.find((s) => s.id === id) ?? null;
                void applyModification(travelers.map((x) => roomRule(state, next, x)), id);
              }}
              disabled={false}
              hideSeats={false}
            />
            <section className="block">
              <h2>{t.changeCount}</h2>
              <p className="muted">{t.modify.partyHint}</p>
              {state.travelerTypes.filter((x) => !x.isEmployeeSelf).map((type) => {
                const ofType = travelers.filter((x) => x.travelerTypeId === type.id);
                return (
                  <div className="stepper-row" key={type.id}>
                    <span>{type.name}<small className="muted"> {money(type.basePrice)}</small></span>
                    <span className="stepper">
                      <button type="button" className="ghost" aria-label={t.decrease(type.name)} disabled={ofType.length === 0 || travelers.length === 1} onClick={() => removeTraveler(ofType[ofType.length - 1]!)}>−</button>
                      <b aria-live="polite">{ofType.length}</b>
                      <button type="button" className="ghost" aria-label={t.increase(type.name)} disabled={dependentLeft <= 0} onClick={() => addType(type.id)}>+</button>
                    </span>
                  </div>
                );
              })}
              <p className="muted">{t.dependentLeft(Math.max(dependentLeft, 0))}</p>
            </section>
          </details>
          <section className="block">
            <h2>{t.modify.travelers}</h2>
            {travelers.map((traveler, index) => {
              const type = state.travelerTypes.find((x) => x.id === traveler.travelerTypeId);
              const open = expanded.has(traveler.key);
              const optionLine = [
                ...traveler.optionIds.map((id) => allOptions.find((o) => o.id === id)?.name),
                session?.roomTypes.find((r) => r.id === traveler.roomTypeId)?.name,
              ].filter(Boolean).join('・');
              const preferenceLine = Object.values(traveler.preferences).flatMap((ids) => ids.map((id, i) => `${t.preferenceN(i + 2).replace('（選填）', '')} ${allOptions.find((o) => o.id === id)?.name ?? ''}`)).join('、');
              return (
                <div className="modify-traveler" key={traveler.key}>
                  <div className="traveler-head">
                    <h3>{traveler.name || t.travelerN(index + 1)}<small className="muted">（{type?.name}）</small></h3>
                    <button type="button" className="link" aria-expanded={open} onClick={() => toggle(traveler.key)}>{open ? t.modify.collapse : t.modify.edit}</button>
                  </div>
                  {open ? (
                    <>
                      <TravelerPicks
                        index={index}
                        traveler={traveler}
                        state={state}
                        session={session}
                        ownIds={ownIds}
                        canApplyToAll={travelers.length > 1}
                        onChange={(next) => changeTravelers(travelers.map((x) => (x.key === next.key ? roomRule(state, session, next) : x)))}
                        onRemove={() => removeTraveler(traveler)}
                        onApplyAll={() => changeTravelers(travelers.map((x) => ({ ...x, optionIds: traveler.optionIds, preferences: traveler.preferences })))}
                      />
                      {travelerForm(traveler)}
                    </>
                  ) : (
                    <>
                      {optionLine && <p>{optionLine}</p>}
                      {preferenceLine && <p className="muted">{preferenceLine}</p>}
                    </>
                  )}
                </div>
              );
            })}
          </section>
          {roomsBlock}
          <section className="block">
            <dl className="summary">
              <div><dt>{t.modify.originalTotal}</dt><dd>{money(registration.totalAmount)}</dd></div>
              <div><dt>{t.modify.newTotal}</dt><dd>{money(nextFees.total)}</dd></div>
              <div><dt>{t.subsidyLine}</dt><dd>-{money(nextFees.subsidyApplied)}</dd></div>
              <div className="strong"><dt>{t.modify.newSelfPay}</dt><dd>{money(nextFees.selfPay)}</dd></div>
            </dl>
            <p className="muted">{nextFees.diff > 0 ? t.modify.more(money(nextFees.diff)) : nextFees.diff < 0 ? t.modify.less(money(-nextFees.diff)) : t.modify.same}</p>
            {nextFees.diff !== 0 && <p className="muted">{t.modify.paidNote(state.agency.name)}</p>}
            <button type="button" className="ghost wide abandon" disabled={busy} onClick={abandon}>{t.modify.abandon}</button>
          </section>
        </main>
        <FeeBar fees={nextFees} error={error}>
          <button type="button" className="primary" disabled={busy} onClick={submitModification}>{busy ? t.modify.submitting : t.modify.submit}</button>
        </FeeBar>
      </div>
    );
  }

  if (step === 'fill') {
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
              {travelerForm(traveler)}
            </section>
          ))}
          {roomsBlock}
          <section className="block">
            <label className="check">
              <input type="checkbox" checked={termsAccepted} onChange={(e) => { setTermsAccepted(e.target.checked); setTermsError(false); }} />
              <span>{t.terms}</span>
            </label>
            {state.event.hasTerms && <p><a className="terms-link" href={`/api/v1/public/events/${state.event.slug}/terms`} target="_blank" rel="noopener">{t.termsLink}</a></p>}
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
      {masthead}
      {state.event.images.home && <img className="home-banner" src={state.event.images.home} alt="" />}
      <main className="page has-bar">
        {restored && <p className="notice">{t.draftRestored}</p>}
        <Itinerary state={state} />
        <Board sessions={availability} selected={sessionId} onSelect={(id) => {
          setSessionId(id); setError(null);
          const next = availability.find((s) => s.id === id) ?? null;
          setTravelers(travelers.map((x) => roomRule(state, next, x)));
        }} disabled={!open} hideSeats={state.event.openState === 'not_open'} />
        {!open && <p className="notice">{state.event.openState === 'closed' ? t.closed : t.notOpenUntil(formatDateTime(state.event.registrationOpensAt))}</p>}
        {!open && <section className="block"><h2>{t.records}</h2><p className="muted">{t.noRecords}</p></section>}
        {open && <FeeList types={state.travelerTypes} />}
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

const occupiesBed = (s: EventState, x: Traveler) => s.travelerTypes.find((y) => y.id === x.travelerTypeId)?.occupiesBed ?? true;

/** 不佔床的旅客不選房型；換梯次時清掉這個梯次沒有的房型，只有一種可選時直接帶入。 */
function roomRule(s: EventState, session: SessionAvailability | null, x: Traveler): Traveler {
  const rooms = session?.roomTypes ?? [];
  if (!occupiesBed(s, x) || rooms.length === 0) return x.roomTypeId ? { ...x, roomTypeId: null } : x;
  if (x.roomTypeId && rooms.some((r) => r.id === x.roomTypeId)) return x;
  const open = rooms.filter((r) => r.status === 'available');
  return { ...x, roomTypeId: rooms.length === 1 && open.length === 1 ? open[0]!.id : null };
}

/** 同一間的佔床旅客選了不同房型，或人數超過可住人數時提醒，不阻擋。 */
function mismatchedRooms(s: EventState, session: SessionAvailability | null, travelers: Traveler[]): number[] {
  const byRoom = new Map<number, Traveler[]>();
  for (const x of travelers) {
    if (!x.roomTypeId) continue;
    const no = x.requestedRoomNo ?? 1;
    byRoom.set(no, [...(byRoom.get(no) ?? []), x]);
  }
  return [...byRoom].filter(([, members]) => {
    const types = new Set(members.map((m) => m.roomTypeId));
    const capacity = session?.roomTypes.find((r) => r.id === members[0]!.roomTypeId)?.capacity ?? members.length;
    return types.size > 1 || members.length > capacity;
  }).map(([no]) => no).sort((a, b) => a - b);
}

function FeeList({ types }: { types: EventState['travelerTypes'] }) {
  return (
    <section className="block">
      <h2>{t.feeList}</h2>
      <dl className="summary">
        {types.map((x) => (
          <div key={x.id}>
            <dt>{x.name}{x.note && <small className="muted type-note">{x.note}</small>}</dt>
            <dd>{money(x.basePrice)}</dd>
          </div>
        ))}
      </dl>
    </section>
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

function Masthead({ state, onLogout }: { state: EventState; onLogout: () => void }) {
  return (
    <header className="masthead">
      <p className="agency">{state.agency.name}</p>
      <h1>{state.event.name}</h1>
      <p className="who">
        {t.greeting(state.employee.name)}
        {state.employee.subsidyAmount > 0 && <span>{t.subsidy(money(state.employee.subsidyAmount))}</span>}
        <button type="button" className="logout" onClick={onLogout}>{t.logout}</button>
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
function Board({ sessions, selected, onSelect, disabled, hideSeats, ownSessionId }: { sessions: SessionAvailability[]; selected: string | null; onSelect: (id: string) => void; disabled: boolean; hideSeats: boolean; ownSessionId?: string }) {
  return (
    <section className="board" aria-label={t.departures}>
      <h2>{t.departures}</h2>
      {sessions.map((s) => {
        // 修改時，自己目前報名的梯次即使額滿也能選回來。
        const blocked = disabled || (s.status !== 'available' && s.id !== ownSessionId);
        return (
          <button key={s.id} type="button" className="board-row" aria-pressed={selected === s.id} disabled={blocked} onClick={() => onSelect(s.id)}>
            <span className="board-name">{s.name}</span>
            <span className="board-legs">
              <Leg label={t.outbound} date={s.departsOn} time={s.departureTime ? t.departAt(s.departureTime) : null} flight={s.outboundFlightNo} />
              <Leg label={t.inbound} date={s.returnsOn} time={s.returnArrivalTime ? t.arriveAt(s.returnArrivalTime) : null} flight={s.returnFlightNo} />
            </span>
            {!hideSeats && (
              <span className={`board-seats ${s.status}`}>
                {s.status === 'available' ? t.remaining(s.remaining) : s.status === 'held' ? t.heldOut : t.soldOut}
              </span>
            )}
          </button>
        );
      })}
    </section>
  );
}

function Leg({ label, date, time, flight }: { label: string; date: string | null; time: string | null; flight: string | null }) {
  const detail = [date ? dateWithWeekday(date) : null, time, flight].filter(Boolean);
  if (!detail.length) return null;
  return <span className="board-leg"><b>{label}</b> {detail.join(' ')}</span>;
}

function TravelerPicks({ index, traveler, state, session, ownIds, canApplyToAll, onChange, onRemove, onApplyAll }: {
  index: number; traveler: Traveler; state: EventState; session: SessionAvailability | null; ownIds: Set<string>; canApplyToAll: boolean;
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
    // 第一志願換掉或取消時，同一個選項不能再留在其他志願。
    const first = next.find((id) => inGroup.has(id));
    const kept = first ? (traveler.preferences[groupId] ?? []).filter((id) => id !== first) : [];
    onChange({ ...traveler, optionIds: next, preferences: { ...traveler.preferences, [groupId]: kept } });
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
      {type?.occupiesBed === false
        ? (session?.roomTypes.length ? <p className="muted">{t.roomTypeNoBed}</p> : null)
        : (session?.roomTypes.length ? (
          <label className="field">
            <span>{t.roomType}</span>
            <select value={traveler.roomTypeId ?? ''} onChange={(e) => onChange({ ...traveler, roomTypeId: e.target.value || null })}>
              <option value="">{t.roomTypeChoose}</option>
              {session.roomTypes.map((r) => {
                const blocked = r.status !== 'available' && r.id !== traveler.roomTypeId && !ownIds.has(r.id);
                const side = r.status === 'sold_out' ? ` ${t.soldOut}` : r.status === 'held' ? ` ${t.optionHeld}` : ` ${t.remaining(r.remaining)}`;
                return <option key={r.id} value={r.id} disabled={blocked}>{t.roomTypeOption(r.name, r.capacity, r.surcharge ? t.plusPrice(money(r.surcharge)) : '', side)}</option>;
              })}
            </select>
          </label>
        ) : !session && state.availability.some((s) => s.roomTypes.length) ? <p className="muted">{t.roomTypeNeedSession}</p> : null)}
      {state.optionGroups.map((group) => (
        <fieldset key={group.id} className="group">
          <legend>{group.name}<small>{group.isRequired ? t.required : t.chooseMax(group.maxSelect)}</small></legend>
          {group.options.map((option) => {
            const quota = session?.options.find((q) => q.optionId === option.id);
            const checked = traveler.optionIds.includes(option.id);
            const blocked = !checked && !!quota && quota.status !== 'available' && !ownIds.has(option.id);
            return (
              <Fragment key={option.id}>
              <label className={`choice${checked ? ' on' : ''}${blocked ? ' off' : ''}`}>
                <input type={group.maxSelect === 1 ? 'radio' : 'checkbox'} name={`${traveler.key}-${group.id}`} checked={checked} disabled={blocked} onChange={() => toggle(group.id, group.maxSelect, option.id)} />
                <span>{option.name}</span>
                <span className="choice-side">
                  {quota && quota.status === 'sold_out' ? t.soldOut : quota && quota.status === 'held' ? t.optionHeld : quota ? t.remaining(quota.remaining) : ''}
                  <b>{option.price ? t.plusPrice(money(option.price)) : t.included}</b>
                </span>
              </label>
              {option.hasPdf && <a className="option-pdf" href={`/api/v1/public/events/${state.event.slug}/options/${option.id}/pdf`} target="_blank" rel="noopener" aria-label={`${option.name}：${t.optionPdfLink}`}>{t.optionPdfLink}</a>}
              </Fragment>
            );
          })}
          <Preferences group={group} traveler={traveler} session={session} onChange={(ids) => onChange({ ...traveler, preferences: { ...traveler.preferences, [group.id]: ids } })} />
        </fieldset>
      ))}
      {canApplyToAll && <button type="button" className="link" onClick={onApplyAll}>{t.applyToAll}</button>}
    </div>
  );
}

/** 第二、第三志願：可選已額滿的選項，填了第二才能填第三。 */
function Preferences({ group, traveler, session, onChange }: { group: EventState['optionGroups'][number]; traveler: Traveler; session: SessionAvailability | null; onChange: (ids: string[]) => void }) {
  const first = group.options.find((o) => traveler.optionIds.includes(o.id));
  if (group.preferenceCount <= 1 || !first) return null;
  const chosen = traveler.preferences[group.id] ?? [];
  const label = (id: string, name: string) => (session?.options.find((q) => q.optionId === id)?.status === 'sold_out' ? `${name}${t.preferenceFull}` : name);
  const set = (index: number, id: string) => {
    const next = chosen.slice(0, index);
    if (id) next.push(id);
    onChange(next);
  };
  return (
    <div className="preferences">
      <small className="muted">{t.preferenceHint}</small>
      {Array.from({ length: group.preferenceCount - 1 }, (_, i) => i).filter((i) => i <= chosen.length).map((i) => (
        <label key={i} className="field">
          <span>{t.preferenceN(i + 2)}</span>
          <select value={chosen[i] ?? ''} onChange={(e) => set(i, e.target.value)}>
            <option value="">{t.preferenceNone}</option>
            {group.options.filter((o) => o.id !== first.id && !chosen.slice(0, i).includes(o.id)).map((o) => <option key={o.id} value={o.id}>{label(o.id, o.name)}</option>)}
          </select>
        </label>
      ))}
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

function FieldInput({ field, traveler, invalid, onChange }: { field: Field; traveler: Traveler; invalid: boolean; onChange: (v: string | string[]) => void }) {
  const mask = traveler.masks?.[field.key];
  if (field.type === 'multiselect') {
    const picked = (traveler.fieldValues[field.key] as string[] | undefined) ?? [];
    return (
      <fieldset className={`field choices${invalid ? ' invalid' : ''}`}>
        <legend>{field.label}{field.isRequired && <em aria-hidden="true"> *</em>}</legend>
        {(field.choices ?? []).map((c) => (
          <label className="check" key={c}>
            <input type="checkbox" checked={picked.includes(c)} onChange={() => onChange(picked.includes(c) ? picked.filter((x) => x !== c) : [...picked, c])} />
            <span>{c}</span>
          </label>
        ))}
        {invalid && <small className="error">{t.fieldRequired}</small>}
      </fieldset>
    );
  }
  const value = (traveler.fieldValues[field.key] as string | undefined) ?? '';
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

function Done({ registration: r, session, fields, paymentInstructions, slug: slug, onCancel, notice, modifyUntil, onModify }: { registration: Registration; paymentInstructions: string | null; slug: string; session?: SessionAvailability; fields: Field[]; onCancel: () => Promise<void>; notice: string | null; modifyUntil: string | null; onModify: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const requested = r.status === 'cancel_requested';
  const modify = async () => {
    setStarting(true); setError(null);
    await onModify().catch((e) => setError(errorText(e)));
    setStarting(false);
  };
  return (
    <main className="page">
      {notice && <p className="notice" role="status">{notice}</p>}
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
      {paymentInstructions && r.selfPayAmount > 0 && !requested && (
        <section className="block">
          <h2>{t.paymentInstructions}</h2>
          <p className="preline">{paymentInstructions}</p>
        </section>
      )}
      {r.travelers.map((x, i) => (
        <section className="block" key={i}>
          <h2>{x.name}<small className="muted"> {x.travelerTypeName}</small></h2>
          <dl className="summary">
            {fields.filter((f) => x.fieldValues[f.key]).map((f) => {
              const v = x.fieldValues[f.key];
              return <div key={f.key}><dt>{f.label}</dt><dd>{Array.isArray(v) ? v.join('、') : String(v)}</dd></div>;
            })}
            {x.options.map((o) => <div key={o.name}><dt>{o.name}{o.hasPdf && <> <a className="option-pdf" href={`/api/v1/public/events/${slug}/options/${o.optionId}/pdf`} target="_blank" rel="noopener" aria-label={`${o.name}：${t.optionPdfLink}`}>{t.optionPdfLink}</a></>}</dt><dd>{o.price ? money(o.price) : t.included}</dd></div>)}
            {x.roomType && <div><dt>{t.roomType}：{x.roomType.name}</dt><dd>{x.roomType.surcharge ? t.plusPrice(money(x.roomType.surcharge)) : t.included}</dd></div>}
            {x.preferences.map((p) => <div key={`${p.groupName}-${p.rank}`}><dt>{p.groupName}{t.preferenceN(p.rank).replace('（選填）', '')}</dt><dd>{p.optionName}</dd></div>)}
            {x.requestedRoomNo && <div><dt>{t.rooms}</dt><dd>{t.roomRequest(x.requestedRoomNo)}</dd></div>}
          </dl>
        </section>
      ))}
      <section className="block">
        <h2>{t.finalRooms}</h2>
        {!r.finalRooms ? <p className="muted">{t.finalRoomsPending}</p> : r.finalRooms.length === 0 ? <p className="muted">{t.finalRoomsNone}</p> : (
          <dl className="summary">
            {r.finalRooms.map((room) => <div key={room.label}><dt>{room.label}{room.typeName ? ` ${room.typeName}` : ''}</dt><dd>{room.names.join('、')}</dd></div>)}
          </dl>
        )}
      </section>
      {!requested && (
        <section className="block">
          {error && <p className="error" role="alert">{error}</p>}
          {modifyUntil && !confirming && (
            <>
              <p className="muted">{t.modify.until(modifyUntil)}</p>
              <button type="button" className="primary wide" disabled={starting} onClick={modify}>{t.modify.action}</button>
            </>
          )}
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
