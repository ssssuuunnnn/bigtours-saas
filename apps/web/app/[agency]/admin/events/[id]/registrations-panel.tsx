'use client';

import { AgencyLink as Link, useAgencyRouter } from '../../../../../lib/agency';
import {useSearchParams} from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { adminApi, type AdminEvent, type ReassignPlan, type ReassignSource, type RegistrationDetail, type RegistrationPage, type RevisionSnapshot } from '../../../../../lib/admin-api';
import { a } from '../../../../../messages/admin';
import { adminError } from '../../admin-shell';
import { RegistrationEdit } from './registration-edit';

const money = (n: number) => `$${n.toLocaleString('en-US')}`;
const when = (iso: string) => new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

/** 明細與改派放在網址，瀏覽器的上一頁才能回到列表。 */
export function RegistrationsPanel({ event }: { event: AdminEvent }) {
  const params = useSearchParams();
  const id = params.get('registration');
  const [note, setNote] = useState<string | null>(null);
  if (params.get('view') === 'reassign') return <ReassignView event={event} onDone={setNote} />;
  if (id && params.get('view') === 'edit') return <RegistrationEdit key={id} event={event} id={id} onDone={setNote} />;
  if (id) return <DetailView key={id} event={event} id={id} note={note} />;
  return <ListView event={event} note={note} initialStatus={params.get('status') ?? ''} initialPayment={params.get('payment') ?? ''} />;
}

function ListView({ event, note, initialStatus, initialPayment }: { event: AdminEvent; note: string | null; initialStatus: string; initialPayment: string }) {
  const base = `/admin/events/${event.id}/registrations`;
  const [data, setData] = useState<RegistrationPage | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [session, setSession] = useState('');
  const [payment, setPayment] = useState(initialPayment);
  const [status, setStatus] = useState(initialStatus);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi.registrations(event.id, { search: query, session, payment, status, page }).then(setData).catch((e) => setError(adminError(e)));
  }, [event.id, query, session, payment, status, page]);

  if (!data) return error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const reset = (apply: () => void) => { apply(); setPage(1); };

  return (
    <section className="admin-panel">
      <div className="admin-panel-head">
        <p className="muted">{a.regSummary(data.registrations, data.travelers)}</p>
        <Link className="ghost-link" href={`${base}?view=reassign`}>{a.reassignAction}</Link>
      </div>
      {note && <p className="admin-note" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <form className="admin-roster-tools" role="search" onSubmit={(e) => { e.preventDefault(); reset(() => setQuery(search)); }}>
        <label className="field">
          <span>{a.searchRegistration}</span>
          <input type="search" placeholder={a.searchRegistrationPlaceholder} value={search} onChange={(e) => setSearch(e.target.value)} onBlur={() => { if (search !== query) reset(() => setQuery(search)); }} />
        </label>
        <label className="field">
          <span>{a.sessionFilter}</span>
          <select value={session} onChange={(e) => reset(() => setSession(e.target.value))}>
            <option value="">{a.sessionAll}</option>
            {data.sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>{a.paymentFilter}</span>
          <select value={payment} onChange={(e) => reset(() => setPayment(e.target.value))}>
            <option value="">{a.paymentAll}</option>
            {Object.entries(a.paymentStates).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="field">
          <span>{a.statusFilter}</span>
          <select value={status} onChange={(e) => reset(() => setStatus(e.target.value))}>
            <option value="">{a.statusAll}</option>
            {Object.entries(a.regStates).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </form>
      {data.rows.length === 0 ? <p className="muted">{data.registrations === 0 && !status ? a.noRegistrations : a.noRegistrationMatches}</p> : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">{a.regCols.employee}</th><th scope="col">{a.regCols.session}</th><th scope="col">{a.regCols.travelers}</th><th scope="col">{a.regCols.total}</th>
                <th scope="col">{a.regCols.subsidy}</th><th scope="col">{a.regCols.self}</th><th scope="col">{a.regCols.payment}</th><th scope="col">{a.regCols.status}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`${base}?registration=${r.id}`}><strong>{r.employeeName}</strong></Link><br /><small className="muted">{r.employeeNo}</small></td>
                  <td>{r.sessionName}</td>
                  <td className="admin-nowrap">{a.travelerCount(r.travelerCount)}</td>
                  <td>{money(r.totalAmount)}</td>
                  <td>{money(r.subsidyAmount)}</td>
                  <td>{money(r.selfPayAmount)}</td>
                  <td className="admin-nowrap"><span className={`admin-pay ${r.paymentStatus}`}>{a.paymentStates[r.paymentStatus]}</span>{r.paymentDiff !== 0 && <><br /><small className="admin-diff-tag">{a.paymentDiffShort(r.paymentDiff)}</small></>}</td>
                  <td className="admin-nowrap"><span className={`admin-reg ${r.status}`}>{a.regStates[r.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="admin-pager">
          <button type="button" className="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>{a.prevPage}</button>
          <span>{a.pageOf(page, pages)}</span>
          <button type="button" className="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>{a.nextPage}</button>
        </div>
      )}
    </section>
  );
}

function DetailView({ event, id, note }: { event: AdminEvent; id: string; note: string | null }) {
  const [r, setR] = useState<RegistrationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, Record<string, unknown>> | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [total, setTotal] = useState('');
  const [reason, setReason] = useState('');
  const load = useCallback(() => adminApi.registration(event.id, id).then(setR).catch((e) => setError(adminError(e))), [event.id, id]);
  useEffect(() => { void load(); }, [load]);

  const back = <Link href={`/admin/events/${event.id}/registrations`}>{a.backToRegistrations}</Link>;
  if (!r) return <section className="admin-panel">{back}{error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>}</section>;

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await load();
      return true;
    } catch (err) {
      setError(adminError(err));
      await load();
      return false;
    }
  };
  const reveal = async () => {
    if (!window.confirm(a.sensitiveConfirm)) return;
    setError(null);
    try {
      setRevealed(await adminApi.revealSensitive(event.id, id));
    } catch (err) {
      setError(adminError(err));
    }
  };
  const submitFee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await run(() => adminApi.adjustFee(event.id, id, Number(total), reason))) { setAdjusting(false); setReason(''); }
  };
  const cancelled = r.status === 'cancelled';
  const fieldValue = (travelerId: string, f: { key: string; value: string; sensitive: boolean }) => {
    const full = f.sensitive ? revealed?.[travelerId]?.[f.key] : undefined;
    return full === undefined ? f.value : String(full);
  };

  return (
    <section className="admin-panel">
      {back}
      <div className="admin-panel-head">
        <div>
          <h2>{a.regTitle(r.employeeName, r.employeeNo)}</h2>
          <p className="muted">{a.regSubtitle(r.sessionName, r.travelers.length)}</p>
        </div>
        {!cancelled && <Link className="ghost-link" href={`/admin/events/${event.id}/registrations?registration=${id}&view=edit`}>{a.modifyRegistration}</Link>}
      </div>
      {note && <p className="admin-note" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {r.status === 'cancel_requested' && (
        <div className="admin-cancel-banner" role="status">
          <p>{a.cancelRequested(when(r.cancelRequestedAt!), r.travelers.length)}</p>
          <div className="admin-actions">
            <button type="button" className="ghost" onClick={() => { if (window.confirm(a.cancelRejectPrompt)) void run(() => adminApi.rejectCancel(event.id, id)); }}>{a.cancelReject}</button>{' '}
            <button type="button" className="danger" onClick={() => { if (window.confirm(a.cancelConfirmPrompt(r.travelers.length))) void run(() => adminApi.confirmCancel(event.id, id)); }}>{a.cancelConfirm}</button>
          </div>
        </div>
      )}
      {cancelled && r.cancelledAt && <p className="admin-note" role="status">{a.cancelledNote(when(r.cancelledAt))}</p>}
      <div className="admin-reg-grid">
        <div>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th scope="col">{a.detailCols.traveler}</th><th scope="col">{a.detailCols.data}</th><th scope="col">{a.detailCols.options}</th><th scope="col">{a.detailCols.fee}</th></tr></thead>
              <tbody>
                {r.travelers.map((t) => (
                  <tr key={t.id}>
                    <td><strong>{t.name}</strong><br /><small className="muted">{t.isEmployeeSelf ? a.selfTag : t.typeName}</small></td>
                    <td>
                      <ul className="admin-cell-list">
                        {t.fields.map((f) => <li key={f.key}>{f.label}：{fieldValue(t.id, f)}</li>)}
                        {t.requestedRoomNo && <li className="muted">{a.roomRequested(t.requestedRoomNo)}</li>}
                      </ul>
                    </td>
                    <td>
                      <ul className="admin-cell-list">
                        {t.options.map((o) => <li key={o.name}>{o.name}{o.price ? `（+${money(o.price)}）` : ''}</li>)}
                        {t.roomType && <li>{a.roomSelected(t.roomType.name)}{t.roomType.surcharge ? `（+${money(t.roomType.surcharge)}）` : ''}</li>}
                        {t.preferences.map((p) => <li key={p.rank} className="muted">{a.preferenceLine(p.rank, p.optionName)}</li>)}
                      </ul>
                    </td>
                    <td>{money(t.fee)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.coworkers.length > 0 && <ul className="admin-cell-list">{r.coworkers.map((c) => <li key={c.requestedRoomNo}>{a.coworkerLine(c.requestedRoomNo, c.name)}</li>)}</ul>}
          {r.canViewSensitive ? (
            revealed ? <p className="muted">{a.sensitiveShown}</p> : <div><button type="button" className="link" onClick={reveal}>{a.viewSensitive}</button> <small className="muted">{a.sensitiveHint}</small></div>
          ) : <small className="muted">{a.sensitiveHint}</small>}
          <div className="admin-card">
            <h2>{a.revisionsTitle}</h2>
            <ol className="admin-revisions">
              {r.revisions.map((v, i) => (
                <li key={i}><time dateTime={v.at}>{when(v.at)}・{v.actorName ?? a.systemActor}</time>{a.revisionText(v.summary)}{v.hasContent && <RevisionContent eventId={event.id} registrationId={id} no={v.no} />}</li>
              ))}
            </ol>
          </div>
        </div>
        <div>
          <div className="admin-card">
            <dl>
              <div><dt>{a.totalFee}</dt><dd>{money(r.totalAmount)}</dd></div>
              <div><dt>{a.corpSubsidy}</dt><dd>−{money(r.subsidyApplied)}</dd></div>
              <div className="strong"><dt>{a.selfPay}</dt><dd>{money(r.selfPayAmount)}</dd></div>
            </dl>
            {r.travelers.reduce((sum, t) => sum + t.fee, 0) !== r.totalAmount && <small className="muted">{a.adjustHint}</small>}
            {!cancelled && !adjusting && <div><button type="button" className="link" onClick={() => { setTotal(String(r.totalAmount)); setAdjusting(true); }}>{a.adjustFee}</button></div>}
            {adjusting && (
              <form className="admin-card" style={{ padding: 0 }} onSubmit={submitFee}>
                <label className="field"><span>{a.adjustTotal}</span><input type="number" required min={0} max={100000000} value={total} onChange={(e) => setTotal(e.target.value)} /></label>
                <label className="field"><span>{a.adjustReason}</span><input type="text" required maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
                <div className="admin-form-actions">
                  <button type="button" className="ghost" onClick={() => setAdjusting(false)}>{a.cancel}</button>
                  <button type="submit" className="primary">{a.adjustAction}</button>
                </div>
              </form>
            )}
          </div>
          <fieldset className="admin-card">
            <legend className="sr-only">{a.paymentTitle2}</legend>
            <h2>{a.paymentTitle2}</h2>
            {r.paymentDiff !== 0 && r.paidAmount !== null && <p className="admin-note" role="status">{a.paymentDiffNote(r.paidAmount, r.paymentDiff)}</p>}
            {r.selfPayAmount === 0 && r.paymentStatus === 'not_required' ? <p className="muted">{a.paymentNotRequiredHint}</p> : (
              <div className="admin-radio-row">
                {(['unpaid', 'paid', 'refunded'] as const).map((s) => (
                  <label key={s}><input type="radio" name="payment" checked={r.paymentStatus === s} onChange={() => { setR({ ...r, paymentStatus: s }); void run(() => adminApi.setPayment(event.id, id, s)); }} />{a.paymentStates[s]}</label>
                ))}
              </div>
            )}
          </fieldset>
        </div>
      </div>
    </section>
  );
}

type SnapshotTraveler = RevisionSnapshot['travelers'][number];
const travelerLines = (t: SnapshotTraveler) => [
  `${t.name}（${t.type}）${money(t.basePrice)}`,
  ...t.fields.map((f) => `${f.label}：${f.value}`),
  ...t.options.map((o) => `${o.name}${o.price ? `（+${money(o.price)}）` : ''}`),
  ...(t.roomType ? [`${a.revisionRoom}：${t.roomType}${t.roomSurcharge ? `（+${money(t.roomSurcharge)}）` : ''}`] : []),
  ...(t.preferences.length ? [`${a.revisionPreference}：${t.preferences.join('、')}`] : []),
];
const headLines = (s: RevisionSnapshot) => [`${a.revisionSession}：${s.session}`, `${a.revisionTotal}：${money(s.total)}`];

/** 只有修改報名的紀錄有前後內容；全部列出並標出差異，同一位旅客用 ID 對照，改名時其他欄位才不會被當成變動。 */
function RevisionContent({ eventId, registrationId, no }: { eventId: string; registrationId: string; no: number }) {
  const [content, setContent] = useState<{ before: RevisionSnapshot; after: RevisionSnapshot } | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    if (!content) {
      try {
        setContent(await adminApi.registrationRevision(eventId, registrationId, no));
      } catch (e) {
        setError(adminError(e));
        return;
      }
    }
    setOpen(!open);
  };
  const list = (lines: string[], other: string[]) => <ul className="admin-cell-list">{lines.map((l) => <li key={l} className={other.includes(l) ? undefined : 'admin-diff-changed'}>{l}</li>)}</ul>;
  const column = (title: string, mine: RevisionSnapshot, other: RevisionSnapshot) => (
    <div>
      <h3>{title}</h3>
      {list(headLines(mine), headLines(other))}
      {mine.travelers.map((t) => {
        const match = other.travelers.find((x) => x.id === t.id);
        return <div className="admin-diff-traveler" key={t.id}>{list(travelerLines(t), match ? travelerLines(match) : [])}</div>;
      })}
    </div>
  );
  return (
    <div>
      <button type="button" className="link" aria-expanded={open} onClick={toggle}>{open ? a.revisionHide : a.revisionView}</button>
      {error && <p className="error" role="alert">{error}</p>}
      {open && content && (
        <div className="admin-diff">
          {column(a.revisionBefore, content.before, content.after)}
          {column(a.revisionAfter, content.after, content.before)}
        </div>
      )}
    </div>
  );
}

function ReassignView({ event, onDone }: { event: AdminEvent; onDone: (message: string) => void }) {
  const router = useAgencyRouter();
  const listUrl = `/admin/events/${event.id}/registrations`;
  const [sources, setSources] = useState<ReassignSource[] | null>(null);
  const [pick, setPick] = useState('');
  const [source, setSource] = useState<ReassignSource | null>(null);
  const [plan, setPlan] = useState<ReassignPlan | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminApi.reassignSources(event.id).then((s) => { setSources(s); if (s[0]) setPick(`${s[0].sessionId}/${s[0].optionId}`); }).catch((e) => setError(adminError(e)));
  }, [event.id]);

  const start = async () => {
    const found = sources?.find((s) => `${s.sessionId}/${s.optionId}` === pick);
    if (!found) return;
    setError(null);
    try {
      const p = await adminApi.reassignPlan(event.id, found.sessionId, found.optionId);
      setSource(found);
      setPlan(p);
      setChoice(Object.fromEntries(p.travelers.map((t) => [t.id, t.suggested ?? ''])));
    } catch (err) {
      setError(adminError(err));
    }
  };

  const back = <Link href={listUrl}>{a.backToRegistrations}</Link>;
  if (!plan || !source) {
    return (
      <section className="admin-panel">
        {back}
        <h2>{a.reassignTitle}</h2>
        {error && <p className="error" role="alert">{error}</p>}
        {!sources ? <p aria-busy="true">{a.loading}</p> : sources.length === 0 ? <p className="admin-note">{a.reassignNoSources}</p> : (
          <div className="admin-form">
            <label className="field span-3">
              <span>{a.reassignPick}</span>
              <select value={pick} onChange={(e) => setPick(e.target.value)}>
                {sources.map((s) => <option key={`${s.sessionId}/${s.optionId}`} value={`${s.sessionId}/${s.optionId}`}>{a.reassignPickOption(s)}</option>)}
              </select>
            </label>
            <div className="admin-form-actions span-3"><button type="button" className="primary" onClick={start}>{a.reassignContinue}</button></div>
          </div>
        )}
      </section>
    );
  }

  const nameOf = (id: string | undefined) => plan.targets.find((t) => t.id === id)?.name;
  const assigned = plan.travelers.filter((t) => choice[t.id]);
  const unassigned = plan.travelers.length - assigned.length;
  const over = plan.targets.flatMap((t) => {
    const n = assigned.filter((x) => choice[x.id] === t.id).length;
    return t.remaining !== null && n > t.remaining ? [{ name: t.name, over: n - t.remaining }] : [];
  });
  const submit = async () => {
    if (!window.confirm(a.reassignConfirmPrompt(assigned.length))) return;
    setBusy(true); setError(null);
    try {
      const r = await adminApi.reassign(event.id, { sessionId: source.sessionId, optionId: source.optionId, reason, assignments: assigned.map((t) => ({ travelerId: t.id, toOptionId: choice[t.id]! })) });
      onDone(a.reassignDone(r.moved, r.registrations));
      router.push(listUrl);
    } catch (err) {
      setError(adminError(err));
      setBusy(false);
    }
  };

  return (
    <section className="admin-panel">
      {back}
      <h2>{a.reassignHead(plan.option.name)}</h2>
      <p className="muted">{a.reassignIntro(source.sessionName, plan.travelers.length)}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <label className="field">
        <span>{a.reassignReason}</span>
        <input type="text" required maxLength={200} placeholder={a.reassignReasonPlaceholder} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="admin-import-cards">
        {plan.targets.map((t) => <div key={t.id}><span>{t.name}</span><strong>{a.reassignLeft(t.remaining)}</strong></div>)}
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead><tr><th scope="col">{a.reassignCols.traveler}</th><th scope="col">{a.reassignCols.second}</th><th scope="col">{a.reassignCols.third}</th><th scope="col">{a.reassignCols.to}</th><th scope="col">{a.reassignCols.diff}</th></tr></thead>
          <tbody>
            {plan.travelers.map((t) => {
              const target = plan.targets.find((x) => x.id === choice[t.id]);
              const diff = target ? target.price - t.currentPrice : null;
              return (
                <tr key={t.id}>
                  <td><strong>{t.name}</strong><br /><small className="muted">{t.isEmployeeSelf ? t.employeeNo : a.dependentOf(t.employeeName)}</small></td>
                  <td>{nameOf(t.preferences[0]) ?? <span className="muted">—</span>}</td>
                  <td>{nameOf(t.preferences[1]) ?? <span className="muted">—</span>}</td>
                  <td>
                    <select className="admin-select-compact" aria-label={a.reassignField(t.name)} value={choice[t.id] ?? ''} onChange={(e) => setChoice({ ...choice, [t.id]: e.target.value })}>
                      <option value="">{a.reassignChoose}</option>
                      {plan.targets.filter((x) => !t.excluded.includes(x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                    {!choice[t.id] && t.preferences.length === 0 && <><br /><small className="muted">{a.reassignKeep}</small></>}
                  </td>
                  <td className="admin-nowrap">{diff === null ? <span className="muted">—</span> : <span className={diff > 0 ? 'admin-diff-up' : diff < 0 ? 'admin-diff-down' : undefined}>{diff > 0 ? '+' : diff < 0 ? '−' : ''}{money(Math.abs(diff))}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {over.map((o) => <p key={o.name} className="error" role="alert">{a.reassignOver(o.name, o.over)}</p>)}
      <p className="muted">{a.reassignFeeNote}</p>
      <p className="admin-note">{unassigned ? a.reassignUnassigned(unassigned) : a.reassignAll}</p>
      <div className="admin-form-actions">
        <Link className="ghost-link" href={listUrl}>{a.cancel}</Link>
        <button type="button" className="primary" disabled={busy || assigned.length === 0 || !reason.trim() || over.length > 0} onClick={submit}>{a.reassignConfirm(assigned.length)}</button>
      </div>
    </section>
  );
}
