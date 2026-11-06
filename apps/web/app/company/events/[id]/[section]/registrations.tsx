'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { contactApi, feeReportUrl, type ContactRegistration, type ContactRegistrationPage } from '../../../../../lib/admin-api';
import { a } from '../../../../../messages/admin';
import { adminError } from '../../../../admin/admin-shell';
import { useContactMe } from '../../../contact-shell';

const money = (n: number) => `$${n.toLocaleString('en-US')}`;
const when = (iso: string) => new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export function ContactRegistrationsPanel({ id }: { id: string }) {
  const registration = useSearchParams().get('registration');
  return registration ? <Detail key={registration} id={id} rid={registration} /> : <List id={id} />;
}

function List({ id }: { id: string }) {
  const me = useContactMe();
  const [page, setPage] = useState<ContactRegistrationPage | null>(null);
  const [search, setSearch] = useState('');
  const [session, setSession] = useState('');
  const [payment, setPayment] = useState('');
  const [n, setN] = useState(1);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    contactApi.registrations(id, { search, session, payment, page: n }).then(setPage).catch((e) => setError(adminError(e)));
  }, [id, search, session, payment, n]);
  if (!page) return error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>;
  const pages = Math.max(Math.ceil(page.total / page.pageSize), 1);
  return (
    <section className="admin-panel">
      <div className="admin-panel-head">
        <p className="muted">{a.c.regSummary(page.registrations, page.travelers, me.agencyName)}</p>
        <a className="ghost-link" href={feeReportUrl(id)}>{a.c.feeReport}</a>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="admin-log-filters">
        <label className="field"><span>{a.c.search}</span><input type="search" value={search} onChange={(e) => { setSearch(e.target.value); setN(1); }} /></label>
        <label className="field"><span>{a.c.sessionFilter}</span>
          <select value={session} onChange={(e) => { setSession(e.target.value); setN(1); }}>
            <option value="">{a.c.sessionAll}</option>
            {page.sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="field"><span>{a.c.paymentFilter}</span>
          <select value={payment} onChange={(e) => { setPayment(e.target.value); setN(1); }}>
            <option value="">{a.c.paymentAll}</option>
            {Object.entries(a.paymentStates).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      {page.rows.length === 0 ? <p className="muted">{a.c.regEmpty}</p> : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr>{Object.values(a.c.regCols).map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
            <tbody>
              {page.rows.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/company/events/${id}/registrations?registration=${r.id}`}>{r.employeeName}</Link><br /><small className="muted">{r.employeeNo}</small></td>
                  <td>{r.sessionName}</td>
                  <td>{a.c.travelersN(r.travelerCount)}</td>
                  <td>{money(r.totalAmount)}</td>
                  <td>{money(Math.min(r.subsidyAmount, r.totalAmount))}</td>
                  <td>{money(r.selfPayAmount)}</td>
                  <td>{a.paymentStates[r.paymentStatus]}</td>
                  <td>{a.c.status[r.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="admin-email-actions">
          <button type="button" className="ghost" disabled={n <= 1} onClick={() => setN(n - 1)}>‹</button>
          <span>{n} / {pages}</span>
          <button type="button" className="ghost" disabled={n >= pages} onClick={() => setN(n + 1)}>›</button>
        </div>
      )}
      <small className="muted">{a.c.feeReportHint}</small>
    </section>
  );
}

function Detail({ id, rid }: { id: string; rid: string }) {
  const me = useContactMe();
  const [r, setR] = useState<ContactRegistration | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { contactApi.registration(id, rid).then(setR).catch((e) => setError(adminError(e))); }, [id, rid]);
  const back = <Link href={`/company/events/${id}/registrations`}>{a.c.backToRegistrations}</Link>;
  if (!r) return <section className="admin-panel">{back}{error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>}</section>;
  return (
    <section className="admin-panel">
      {back}
      <h2>{r.employeeName}（{r.employeeNo}）</h2>
      {r.status === 'cancel_requested' && r.cancelRequestedAt && <p className="admin-note" role="status">{a.c.cancelRequested(when(r.cancelRequestedAt), me.agencyName)}</p>}
      {r.status === 'cancelled' && r.cancelledAt && <p className="admin-note" role="status">{a.c.cancelled(when(r.cancelledAt))}</p>}
      <p className="muted">{a.c.regSubtitle(r.sessionName, r.travelers.length)}</p>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead><tr><th scope="col">{a.c.travelerCols.traveler}</th><th scope="col">{a.c.travelerCols.options}</th><th scope="col">{a.c.travelerCols.fee}</th></tr></thead>
          <tbody>
            {r.travelers.map((t) => (
              <tr key={t.id}>
                <td>{t.name}<br /><small className="muted">{t.typeName}</small></td>
                <td>{[...t.options, t.roomTypeName].filter(Boolean).join('、') || '—'}</td>
                <td>{money(t.fee)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <small className="muted">{a.c.noSensitive}</small>
      <dl className="contact-sum">
        <div className="admin-email-actions"><dt>{a.c.total}</dt><dd>{money(r.totalAmount)}</dd></div>
        <div className="admin-email-actions"><dt>{a.c.subsidy}</dt><dd>−{money(r.subsidyApplied)}</dd></div>
        <div className="admin-email-actions"><dt><strong>{a.c.self}</strong></dt><dd><strong>{money(r.selfPayAmount)}</strong></dd></div>
        <div className="admin-email-actions"><dt>{a.c.payment}</dt><dd>{a.paymentStates[r.paymentStatus]}</dd></div>
      </dl>
    </section>
  );
}
