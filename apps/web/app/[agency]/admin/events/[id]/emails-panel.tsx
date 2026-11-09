'use client';

import { AgencyLink as Link } from '../../../../../lib/agency';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../../../../lib/api';
import { adminApi, type AdminEvent, type EmailOverview, type EmailTemplateView } from '../../../../../lib/admin-api';
import { a } from '../../../../../messages/admin';
import { adminError, useAdminMe } from '../../admin-shell';

const when = (iso: string) => new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export function EmailsPanel({ event }: { event: AdminEvent }) {
  const [data, setData] = useState<EmailOverview | null>(null);
  const [selected, setSelected] = useState('registration_success');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => adminApi.emails(event.id).then(setData).catch((e) => setError(adminError(e))), [event.id]);
  useEffect(() => { void load(); }, [load]);

  if (!data) return error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">{a.loading}</p>;
  const template = data.templates.find((t) => t.key === selected) ?? data.templates[0]!;

  return (
    <section className="admin-panel">
      <p className="muted">{a.emailsHint}</p>
      <div className="admin-email-grid">
        <nav className="admin-email-list" aria-label={a.emailTemplatesLabel}>
          {data.templates.map((t) => (
            <button key={t.key} type="button" aria-current={t.key === template.key ? 'true' : undefined} onClick={() => setSelected(t.key)}>
              <span>{t.label}</span>{t.customized && <small>{a.emailCustomized}</small>}
            </button>
          ))}
        </nav>
        <div className="admin-reg-col">
          <TemplateEditor key={template.key} event={event} template={template} onSaved={load} />
          {template.key === 'deadline_reminder' && <ReminderCard event={event} reminder={data.reminder} onSent={load} />}
        </div>
      </div>
      <NotifyCard event={event} emails={data.notifyEmails} onSaved={load} />
      <FailuresCard event={event} data={data} onChanged={load} />
    </section>
  );
}

function TemplateEditor({ event, template, onSaved }: { event: AdminEvent; template: EmailTemplateView; onSaved: () => Promise<unknown> }) {
  const me = useAdminMe();
  const [senderName, setSenderName] = useState(template.senderName ?? '');
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const values = () => ({ senderName: senderName.trim() || null, subject, body });
  const run = async (action: () => Promise<string | null>) => {
    setBusy(true); setNote(null); setError(null);
    try {
      setNote(await action());
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TEMPLATE_INVALID') {
        const { unknown = [], missing = [] } = e.detail ?? {};
        setError([unknown.length ? a.emailUnknown(unknown) : '', missing.length ? a.emailMissing(missing) : ''].join(''));
      } else setError(adminError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="admin-email-editor" onSubmit={(e) => { e.preventDefault(); void run(async () => { await adminApi.saveEmailTemplate(event.id, template.key, values()); await onSaved(); return a.emailSaved; }); }}>
      <h2>{template.label}</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="admin-note" role="status">{note}</p>}
      <label className="field"><span>{a.emailSender}</span><input type="text" maxLength={100} value={senderName} onChange={(e) => setSenderName(e.target.value)} /><small>{a.emailSenderHint(me.agencyName)}</small></label>
      <label className="field"><span>{a.emailSubject}</span><input type="text" required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
      <label className="field"><span>{a.emailBody}</span><textarea required maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} /></label>
      <div>
        <small className="muted">{a.emailPlaceholderHint}</small>
        <ul className="admin-email-tokens">{template.placeholders.map((p) => <li key={p}><code>[{p}]</code></li>)}</ul>
      </div>
      <div className="admin-email-actions">
        <div>
          {template.customized && <button type="button" className="link" disabled={busy} onClick={() => { if (window.confirm(a.emailResetConfirm)) void run(async () => { await adminApi.resetEmailTemplate(event.id, template.key); setSenderName(''); setSubject(template.defaultSubject); setBody(template.defaultBody); await onSaved(); return a.emailResetDone; }); }}>{a.emailReset}</button>}
        </div>
        <div>
          <button type="button" className="ghost" disabled={busy} onClick={() => run(async () => a.emailTestSent((await adminApi.testEmailTemplate(event.id, template.key, values())).to))}>{a.emailTest}</button>
          <button type="submit" className="primary" disabled={busy}>{a.emailSave}</button>
        </div>
      </div>
    </form>
  );
}

function ReminderCard({ event, reminder, onSent }: { event: AdminEvent; reminder: EmailOverview['reminder']; onSent: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (!window.confirm(a.emailReminderConfirm(reminder.pending))) return;
    setBusy(true); setNote(null); setError(null);
    try {
      const { queued } = await adminApi.sendDeadlineReminder(event.id);
      setNote(a.emailReminderQueued(queued));
      await onSent();
    } catch (e) {
      setError(adminError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="admin-card">
      <h2>{a.emailReminderTitle}</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="admin-note" role="status">{note}</p>}
      {reminder.sendable ? <p>{a.emailReminderCount(reminder.pending, reminder.noEmail)}</p> : <p className="muted">{a.emailReminderClosed}</p>}
      {reminder.lastSentAt && <small className="muted">{a.emailReminderLast(when(reminder.lastSentAt))}</small>}
      {reminder.sendable && <div><button type="button" className="primary" disabled={busy || reminder.pending === 0} onClick={send}>{a.emailReminderSend(reminder.pending)}</button></div>}
    </div>
  );
}

function NotifyCard({ event, emails, onSaved }: { event: AdminEvent; emails: string[]; onSaved: () => Promise<unknown> }) {
  const [text, setText] = useState(emails.join('\n'));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setNote(null); setError(null);
    try {
      await adminApi.saveNotifyEmails(event.id, text.split(/[\n,，、\s]+/).map((x) => x.trim()).filter(Boolean));
      setNote(a.notifySaved);
      await onSaved();
    } catch (err) {
      setError(adminError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="admin-card" onSubmit={save}>
      <h2>{a.notifyTitle}</h2>
      <p className="muted">{a.notifyHint}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="admin-note" role="status">{note}</p>}
      <label className="field"><span>{a.notifyLabel}</span><textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <div><button type="submit" className="ghost" disabled={busy}>{a.notifySave}</button></div>
    </form>
  );
}

function FailuresCard({ event, data, onChanged }: { event: AdminEvent; data: EmailOverview; onChanged: () => Promise<unknown> }) {
  const [fixing, setFixing] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resend = async (id: string, newEmail?: string) => {
    setNote(null); setError(null);
    try {
      await adminApi.resendEmail(event.id, id, newEmail);
      setFixing(null); setEmail('');
      setNote(a.failureResent);
      await onChanged();
    } catch (e) {
      setError(adminError(e));
    }
  };
  return (
    <div className="admin-card">
      <h2>{a.failuresTitle}</h2>
      <p className="muted">{a.failuresStats(data.stats.total, data.stats.failed)}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="admin-note" role="status">{note}</p>}
      {data.failures.length === 0 && <p className="muted">{a.failuresNone}</p>}
      {data.failures.map((f) => {
        const who = f.employeeName ?? a.failureAgencyRecipient;
        return (
          <div className="admin-failure" key={f.id}>
            <div><strong>{who}</strong>{f.employeeNo && <small className="muted"> {f.employeeNo}</small>}・{f.label}・{f.email}</div>
            <small className="muted">{a.failureReasons[f.reason]}・{when(f.at)}</small>
            {fixing === f.id ? (
              <form className="admin-failure-fix" onSubmit={(e) => { e.preventDefault(); void resend(f.id, email); }}>
                <input type="email" required aria-label={a.failureNewEmail(who)} value={email} onChange={(e) => setEmail(e.target.value)} />
                <button type="submit" className="primary">{a.failureResend}</button>
                <button type="button" className="ghost" onClick={() => setFixing(null)}>{a.cancel}</button>
              </form>
            ) : (
              <div className="admin-failure-actions">
                {f.isEmployee && <button type="button" className="link" onClick={() => { setFixing(f.id); setEmail(f.email); }}>{a.failureFix}</button>}
                <button type="button" className="link" onClick={() => resend(f.id)}>{a.failureResend}</button>
                {f.templateKey === 'account' && <Link href={`/admin/events/${event.id}/roster`}>{a.failureLink}</Link>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
