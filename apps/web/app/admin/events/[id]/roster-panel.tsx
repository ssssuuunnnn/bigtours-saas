'use client';

import { useSearchParams } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { adminApi as agencyApi, type AccountState, type AdminEmployee, type RosterApi, type AdminEvent, type EmployeeValues, type ImportPreview, type PasswordLink, type RosterPage } from '../../../../lib/admin-api';
import { a } from '../../../../messages/admin';
import { adminError } from '../../admin-shell';
import { EventLineLink } from '../../line-link';

const STATE_TONE: Record<AccountState, string> = {
  activated: 'good', sent: 'wait', sending: 'wait', link_issued: 'wait', failed: 'bad', expired: 'bad', no_email: 'bad', none: 'idle',
};
const money = (n: number) => `$${n.toLocaleString('en-US')}`;

type View = { kind: 'list' } | { kind: 'import' } | { kind: 'copy' };

const RosterApiContext = createContext<RosterApi>(agencyApi);

/** 旅行社和企業窗口共用這個畫面，只有呼叫的 API 不同。 */
export function RosterPanel({ event, api = agencyApi }: { event: Pick<AdminEvent, 'id'>; api?: RosterApi }) {
  return <RosterApiContext.Provider value={api}><RosterView event={event} /></RosterApiContext.Provider>;
}

function RosterView({ event }: { event: Pick<AdminEvent, 'id'> }) {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [note, setNote] = useState<string | null>(null);
  const done = (message: string) => { setNote(message); setView({ kind: 'list' }); };

  if (view.kind === 'import') return <ImportView event={event} onCancel={() => setView({ kind: 'list' })} onDone={done} />;
  if (view.kind === 'copy') return <CopyView event={event} onCancel={() => setView({ kind: 'list' })} onDone={done} />;
  return <ListView event={event} note={note} onNote={setNote} onImport={() => { setNote(null); setView({ kind: 'import' }); }} onCopy={() => { setNote(null); setView({ kind: 'copy' }); }} />;
}

function ListView({ event, note, onNote, onImport, onCopy }: { event: Pick<AdminEvent, 'id'>; note: string | null; onNote: (n: string | null) => void; onImport: () => void; onCopy: () => void }) {
  const adminApi = useContext(RosterApiContext);
  const [data, setData] = useState<RosterPage | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [account, setAccount] = useState('');
  const [registration, setRegistration] = useState(useSearchParams().get('registration') ?? '');
  const [line, setLine] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<AdminEmployee | 'new' | null>(null);
  const [link, setLink] = useState<{ name: string; link: PasswordLink } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => adminApi.employees(event.id, { search: query, account, registration, line, page })
    .then(setData).catch((e) => setError(adminError(e))), [event.id, query, account, registration, line, page]);
  useEffect(() => { void load(); }, [load]);

  // 寄送在背景進行，有寄送中的員工時持續更新狀態。
  const sending = (data?.summary.sending ?? 0) > 0;
  useEffect(() => {
    if (!sending) return;
    const timer = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(timer);
  }, [sending, load]);

  if (!data) return error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>;

  const pending = data.summary.none + data.summary.failed + data.summary.expired;
  // 活動關閉 LINE 入口後仍顯示既有的綁定，方便解除。
  const showLine = data.line.available || data.line.boundCount > 0;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const pageIds = data.rows.map((r) => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
  const toggle = (id: string) => setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const reset = (apply: () => void) => { apply(); setPage(1); setSelected([]); };

  const send = async (body: { employeeIds: string[] } | { allPending: true }, confirmText: string) => {
    if (!window.confirm(confirmText)) return;
    setError(null); onNote(null);
    try {
      const r = await adminApi.sendAccountEmails(event.id, body);
      onNote(a.sendResult(r.queued, r.skipped));
      setSelected([]);
      await load();
    } catch (err) {
      setError(adminError(err));
    }
  };
  const generate = async (e: AdminEmployee) => {
    setError(null); onNote(null);
    try {
      setLink({ name: e.name, link: await adminApi.passwordLink(event.id, e.id) });
      await load();
    } catch (err) {
      setError(adminError(err));
    }
  };
  const unbindLine = async (e: AdminEmployee) => {
    if (!window.confirm(a.line.unbindConfirm(e.name))) return;
    setError(null); onNote(null);
    try {
      await adminApi.unbindLine(event.id, e.id);
      onNote(a.line.unbindDone(e.name));
      await load();
    } catch (err) {
      setError(adminError(err));
    }
  };
  const remove = async (e: AdminEmployee) => {
    if (!window.confirm(a.removeEmployeeConfirm(e.name))) return;
    setError(null); onNote(null);
    try {
      await adminApi.removeEmployee(event.id, e.id);
      setEditing(null);
      await load();
    } catch (err) {
      setError(adminError(err));
    }
  };

  return (
    <section className="admin-panel">
      <div className="admin-panel-head">
        <p className="muted">{a.rosterSummary(data.rosterTotal, data.summary)}</p>
        <div className="admin-actions">
          <button type="button" className="ghost" onClick={onImport}>{a.importCsv}</button>{' '}
          <button type="button" className="primary" onClick={() => setEditing('new')}>{a.addEmployee}</button>
        </div>
      </div>
      {note && <p className="admin-note" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {data.line.url && <EventLineLink url={data.line.url} boundCount={data.line.boundCount} />}
      {editing && editing !== 'new' && <EmployeeForm key={editing.id} event={event} employee={editing} defaults={data.defaults} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {editing === 'new' && <EmployeeForm event={event} employee={null} defaults={data.defaults} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}

      {data.rosterTotal > 0 && (
        <form className="admin-roster-tools" role="search" onSubmit={(e) => { e.preventDefault(); reset(() => setQuery(search)); }}>
          <label className="field">
            <span>{a.searchEmployee}</span>
            <input type="search" placeholder={a.searchPlaceholder} value={search} onChange={(e) => setSearch(e.target.value)} onBlur={() => { if (search !== query) reset(() => setQuery(search)); }} />
          </label>
          <label className="field">
            <span>{a.accountFilter}</span>
            <select value={account} onChange={(e) => reset(() => setAccount(e.target.value))}>
              <option value="">{a.accountAll}</option>
              {Object.entries(a.accountStates).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>{a.registrationFilter}</span>
            <select value={registration} onChange={(e) => reset(() => setRegistration(e.target.value))}>
              <option value="">{a.registrationAll}</option>
              {Object.entries(a.registrationStates).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
          {showLine && (
            <label className="field">
              <span>{a.line.filter}</span>
              <select value={line} onChange={(e) => reset(() => setLine(e.target.value))}>
                <option value="">{a.line.filterAll}</option>
                <option value="bound">{a.line.bound}</option>
                <option value="unbound">{a.line.unbound}</option>
              </select>
            </label>
          )}
        </form>
      )}

      {data.rosterTotal > 0 && (selected.length > 0 || pending > 0) && (
        <div className="admin-roster-bulk">
          {selected.length > 0 && (
            <>
              <strong>{a.selectedCount(selected.length)}</strong>
              <button type="button" className="primary" onClick={() => send({ employeeIds: selected }, a.sendSelectedConfirm(selected.length))}>{a.sendAccountEmail}</button>
            </>
          )}
          {selected.length === 0 && pending > 0 && <button type="button" className="ghost" onClick={() => send({ allPending: true }, a.sendPendingConfirm(pending))}>{a.sendPending(pending)}</button>}
        </div>
      )}

      {data.rosterTotal === 0 ? <p className="muted">{a.noEmployees}</p> : data.rows.length === 0 ? <p className="muted">{a.noEmployeeMatches}</p> : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col"><input className="admin-row-input" type="checkbox" aria-label={a.selectAllPage} checked={allOnPage} onChange={() => setSelected(allOnPage ? selected.filter((id) => !pageIds.includes(id)) : [...new Set([...selected, ...pageIds])])} /></th>
                <th scope="col">{a.employeeCol}</th><th scope="col">{a.deptCol}</th><th scope="col">{a.subsidyCol}</th><th scope="col">{a.limitCol}</th>
                <th scope="col">{a.accountCol}</th><th scope="col">{a.registrationCol}</th>
                {showLine && <th scope="col">{a.line.col}</th>}
                <th scope="col">{a.actions}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((e) => (
                <tr key={e.id}>
                  <td><input className="admin-row-input" type="checkbox" aria-label={a.selectEmployee(e.name)} checked={selected.includes(e.id)} onChange={() => toggle(e.id)} /></td>
                  <td><strong>{e.name}</strong><br /><small className="muted">{e.employeeNo}</small></td>
                  <td>{e.department ?? <span className="muted">—</span>}</td>
                  <td>{e.subsidyAmount === null ? <span className="muted">{a.useDefault}</span> : money(e.subsidyAmount)}</td>
                  <td>{e.dependentLimit === null ? <span className="muted">{a.useDefault}</span> : e.dependentLimit}</td>
                  <td><span className={`admin-account ${STATE_TONE[e.accountState]}`}>{a.accountStates[e.accountState]}</span></td>
                  <td>{a.registrationStates[e.registered ? 'registered' : 'unregistered']}</td>
                  {showLine && <td>{e.lineBound ? a.line.bound : <span className="muted">—</span>}</td>}
                  <td className="admin-actions">
                    <button type="button" className="link" onClick={() => generate(e)}>{a.generateLink}</button>{' '}
                    <button type="button" className="link" onClick={() => setEditing(e)}>{a.edit}</button>{' '}
                    {e.lineBound && <><button type="button" className="link" onClick={() => unbindLine(e)}>{a.line.unbind}</button>{' '}</>}
                    <button type="button" className="link" disabled={e.registered} onClick={() => remove(e)}>{a.removeEmployee}</button>
                  </td>
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
      <p className="muted">{a.rosterHint(money(data.defaults.subsidyAmount))}</p>
      <div><button type="button" className="link" onClick={onCopy}>{a.copyRosterAction}</button></div>
      {link && <LinkDialog name={link.name} link={link.link} onClose={() => setLink(null)} />}
    </section>
  );
}

function EmployeeForm({ event, employee, defaults, onCancel, onSaved }: { event: Pick<AdminEvent, 'id'>; employee: AdminEmployee | null; defaults: RosterPage['defaults']; onCancel: () => void; onSaved: () => void }) {
  const adminApi = useContext(RosterApiContext);
  const [v, setV] = useState({
    employeeNo: employee?.employeeNo ?? '',
    name: employee?.name ?? '',
    email: employee?.email ?? '',
    department: employee?.department ?? '',
    subsidy: employee?.subsidyAmount?.toString() ?? '',
    limit: employee?.dependentLimit?.toString() ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = !!employee && (employee.activated || employee.registered);
  const set = (patch: Partial<typeof v>) => setV({ ...v, ...patch });
  // 名單很長時，從下方的列點編輯也要看得到表單。
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { formRef.current?.scrollIntoView({ block: 'nearest' }); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const values: EmployeeValues = {
      employeeNo: v.employeeNo, name: v.name, email: v.email || null, department: v.department || null,
      subsidyAmount: v.subsidy === '' ? null : Number(v.subsidy), dependentLimit: v.limit === '' ? null : Number(v.limit),
    };
    try {
      if (employee) await adminApi.updateEmployee(event.id, employee.id, values);
      else await adminApi.createEmployee(event.id, values);
      onSaved();
    } catch (err) {
      setError(adminError(err));
      setBusy(false);
    }
  };

  return (
    <form ref={formRef} className="admin-form" onSubmit={submit}>
      {error && <p className="error span-3" role="alert">{error}</p>}
      <label className="field">
        <span>{a.employeeNo}</span>
        <input type="text" required maxLength={50} disabled={locked} value={v.employeeNo} onChange={(e) => set({ employeeNo: e.target.value })} />
        {locked && <small className="muted">{a.employeeNoLocked}</small>}
      </label>
      <label className="field"><span>{a.employeeName}</span><input type="text" required maxLength={100} value={v.name} onChange={(e) => set({ name: e.target.value })} /></label>
      <label className="field"><span>{a.employeeEmail}</span><input type="email" maxLength={200} value={v.email} onChange={(e) => set({ email: e.target.value })} /></label>
      <label className="field"><span>{a.employeeDept}</span><input type="text" maxLength={100} value={v.department} onChange={(e) => set({ department: e.target.value })} /></label>
      <label className="field"><span>{a.employeeSubsidy}</span><input type="number" min={0} max={10000000} placeholder={a.defaultPlaceholder(money(defaults.subsidyAmount))} value={v.subsidy} onChange={(e) => set({ subsidy: e.target.value })} /></label>
      <label className="field"><span>{a.employeeLimit}</span><input type="number" min={0} max={50} placeholder={a.defaultPlaceholder(String(defaults.dependentLimit))} value={v.limit} onChange={(e) => set({ limit: e.target.value })} /></label>
      <div className="admin-form-actions span-3">
        <button type="button" className="ghost" onClick={onCancel}>{a.cancel}</button>
        <button type="submit" className="primary" disabled={busy}>{busy ? a.saving : a.save}</button>
      </div>
    </form>
  );
}

const TEMPLATE = '﻿員工編號,姓名,部門,Email,補助金額,眷屬人數上限\nE10234,陳怡君,研發部,yijun@example.com,8000,3\nE10238,周志偉,工廠,,,1\n';

function ImportView({ event, onCancel, onDone }: { event: Pick<AdminEvent, 'id'>; onCancel: () => void; onDone: (message: string) => void }) {
  const adminApi = useContext(RosterApiContext);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const template = () => {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'employee-roster-template.csv';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const choose = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0];
    e.target.value = '';
    if (!chosen) return;
    setError(null); setPreview(null); setFile(null);
    if (chosen.size > 5 * 1024 * 1024) { setError(a.errors.FILE_TOO_LARGE!); return; }
    setBusy(true);
    try {
      setPreview(await adminApi.previewImport(event.id, chosen));
      setFile(chosen);
    } catch (err) {
      setError(adminError(err));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const r = await adminApi.importEmployees(event.id, file);
      onDone(a.importDone(r.created, r.updated));
    } catch (err) {
      setError(adminError(err));
      setBusy(false);
    }
  };
  const importable = preview ? preview.newCount + preview.updateCount : 0;

  return (
    <section className="admin-panel">
      <h2>{preview && file ? a.importConfirmTitle : a.importTitle}</h2>
      <p className="muted">{preview && file ? a.importConfirmHint(file.name) : a.importHint}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="admin-actions">
        <button type="button" className="ghost" onClick={template}>{a.downloadTemplate}</button>{' '}
        <input id="roster-csv" className="admin-file-input" type="file" accept=".csv,text/csv" disabled={busy} onChange={choose} />
        <label htmlFor="roster-csv" className="admin-file-button">{busy && !preview ? a.checking : a.chooseCsv}</label>
      </div>
      {preview && (
        <>
          <div className="admin-import-cards">
            <div><span>{a.importNew}</span><strong>{a.importPeople(preview.newCount)}</strong></div>
            <div><span>{a.importUpdate}</span><strong>{a.importPeople(preview.updateCount)}</strong></div>
            <div className={preview.errorCount ? 'bad' : undefined}><span>{a.importErrors}</span><strong>{a.importRows(preview.errorCount)}</strong></div>
            <div><span>{a.importDuplicates}</span><strong>{a.importRows(preview.duplicateCount)}</strong></div>
          </div>
          {preview.issues.length > 0 && (
            <>
              <h3>{a.importIssuesTitle}</h3>
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead><tr><th scope="col">{a.importRow}</th><th scope="col">{a.employeeNo}</th><th scope="col">{a.employeeName}</th><th scope="col">{a.importIssue}</th></tr></thead>
                  <tbody>
                    {preview.issues.map((i) => (
                      <tr key={i.row}>
                        <td>{i.row}</td>
                        <td>{i.employeeNo || <span className="muted">{a.importBlank}</span>}</td>
                        <td>{i.name || <span className="muted">{a.importBlank}</span>}</td>
                        <td>{a.importIssueText(i)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.issuesTruncated && <p className="muted">{a.importIssuesMore}</p>}
            </>
          )}
          <p className="admin-note">{importable > 0 ? a.importSummary(preview.newCount, preview.updateCount, preview.errorCount) : a.importNothing}</p>
        </>
      )}
      <div className="admin-form-actions">
        <button type="button" className="ghost" onClick={onCancel}>{a.cancel}</button>
        {preview && importable > 0 && <button type="button" className="primary" disabled={busy} onClick={confirm}>{a.importAction(importable)}</button>}
      </div>
    </section>
  );
}

function CopyView({ event, onCancel, onDone }: { event: Pick<AdminEvent, 'id'>; onCancel: () => void; onDone: (message: string) => void }) {
  const adminApi = useContext(RosterApiContext);
  const [sources, setSources] = useState<{ id: string; name: string; employees: number }[] | null>(null);
  const [from, setFrom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminApi.rosterSources(event.id).then((s) => { setSources(s); setFrom(s[0]?.id ?? ''); }).catch((e) => setError(adminError(e)));
  }, [event.id]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await adminApi.copyRoster(event.id, from);
      onDone(a.copyRosterDone(r.added, r.skipped));
    } catch (err) {
      setError(adminError(err));
      setBusy(false);
    }
  };

  return (
    <section className="admin-panel">
      <h2>{a.copyRosterTitle}</h2>
      <p className="muted">{a.copyRosterHint}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {sources && sources.length === 0 && <p className="admin-note">{a.copyRosterNone}</p>}
      <form className="admin-form" onSubmit={submit}>
        {sources && sources.length > 0 && (
          <label className="field span-3">
            <span>{a.copyRosterSource}</span>
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              {sources.map((s) => <option key={s.id} value={s.id}>{a.copyRosterOption(s.name, s.employees)}</option>)}
            </select>
          </label>
        )}
        <div className="admin-form-actions span-3">
          <button type="button" className="ghost" onClick={onCancel}>{a.cancel}</button>
          {sources && sources.length > 0 && <button type="submit" className="primary" disabled={busy}>{a.copyRosterAction}</button>}
        </div>
      </form>
    </section>
  );
}

function LinkDialog({ name, link, onClose }: { name: string; link: PasswordLink; onClose: () => void }) {
  const url = `${window.location.origin}/${link.slug}/set-password/${link.token}`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      document.getElementById('password-link')?.focus();
    }
  };
  return (
    <div className="admin-modal">
      <div role="dialog" aria-modal="true" aria-labelledby="link-title">
        <h2 id="link-title">{a.linkTitle(name)}</h2>
        <p className="admin-note">{a.linkWarning}</p>
        <label className="field" htmlFor="password-link"><span>{a.linkLabel}</span></label>
        <div className="admin-link-url">
          <input id="password-link" type="text" readOnly value={url} onFocus={(e) => e.target.select()} />
          <button type="button" className="ghost" onClick={copy}>{copied ? a.linkCopied : a.linkCopy}</button>
        </div>
        <ul className="admin-link-notes">
          <li>{a.linkValidity}</li>
          <li>{a.linkOldRevoked}</li>
          <li>{a.linkRecorded(link.issuedBy, link.notified)}</li>
          <li>{a.linkSessions}</li>
        </ul>
        <div className="admin-form-actions">
          <button type="button" className="primary" onClick={onClose}>{a.linkClose}</button>
        </div>
      </div>
    </div>
  );
}
