'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { adminFetch, errorMessage, money } from '../../lib/admin-api';
import { Shell } from './shell';

const STATUS: Record<string, string> = { draft: '草稿', published: '已發布', closed: '已關閉', archived: '已封存' };

export default function EventsPage() {
  const [events, setEvents] = useState<any[] | null>(null);
  const [companies, setCompanies] = useState<any[]>([]);
  const [quota, setQuota] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState('');
  const [form, setForm] = useState({ companyId: '', name: '', slug: '', pricingTierId: '' });

  const load = useCallback(async () => {
    const [e, c, q] = await Promise.all([adminFetch('GET', '/events'), adminFetch('GET', '/companies'), adminFetch('GET', '/quota')]);
    setEvents(e); setCompanies(c); setQuota(q);
  }, []);
  useEffect(() => { load().catch((e) => setError(errorMessage(e))); }, [load]);

  const addCompany = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try {
      const c = await adminFetch('POST', '/companies', { name: companyName });
      setCompanyName(''); setForm((f) => ({ ...f, companyId: c.id }));
      await load();
    } catch (err) { setError(errorMessage(err)); }
  };

  const addEvent = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try {
      const created = await adminFetch('POST', '/events', form);
      window.location.href = `/admin/events/${created.id}`;
    } catch (err) { setError(errorMessage(err)); }
  };

  const available = quota.filter((q) => q.balance > 0);

  return (
    <Shell>
      <h1 className="page-title">活動</h1>
      {error && <p className="msg-error" role="alert">{error}</p>}

      <section className="panel">
        <div className="table-wrap">
          <table className="admin-table">
            <thead><tr><th>活動</th><th>企業</th><th>狀態</th><th className="num">已報名／名額</th><th className="num">員工名單</th></tr></thead>
            <tbody>
              {events?.map((e) => (
                <tr key={e.id}>
                  <td><Link href={`/admin/events/${e.id}`}>{e.name}</Link><div className="stat-note">{e.slug}</div></td>
                  <td>{e.companyName}</td>
                  <td><span className={`badge ${e.status}`}>{STATUS[e.status] ?? e.status}</span></td>
                  <td className="num">{e.sold.toLocaleString()} / {e.capacity.toLocaleString()}</td>
                  <td className="num">{e.employees.toLocaleString()}</td>
                </tr>
              ))}
              {events?.length === 0 && <tr><td colSpan={5}>還沒有活動。先在下方建立企業，再建立第一個活動。</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>建立活動</h2>
        <form className="row" onSubmit={addEvent}>
          <label className="lab">企業
            <select required value={form.companyId} onChange={(e) => setForm({ ...form, companyId: e.target.value })}>
              <option value="">請選擇</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="lab">活動名稱<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="lab">活動代碼（用於網址，英數小寫與連字號）
            <input required pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="acme-2027" />
          </label>
          <label className="lab">人數級距
            <select required value={form.pricingTierId} onChange={(e) => setForm({ ...form, pricingTierId: e.target.value })}>
              <option value="">請選擇</option>
              {available.map((q) => <option key={q.id} value={q.id}>{q.minTravelers}～{q.maxTravelers} 人（剩 {q.balance} 場）</option>)}
            </select>
          </label>
          <button className="btn main" type="submit">建立活動</button>
        </form>
        {quota.length > 0 && available.length === 0 && <p className="msg-error">活動額度已用完，請聯繫平台開通。</p>}
      </section>

      <section className="panel">
        <h2>企業</h2>
        <form className="row" onSubmit={addCompany}>
          <label className="lab">企業名稱<input required value={companyName} onChange={(e) => setCompanyName(e.target.value)} /></label>
          <button className="btn" type="submit">新增企業</button>
        </form>
        <p className="page-sub">{companies.map((c) => c.name).join('、') || '尚未建立企業'}</p>
      </section>

      <section className="panel">
        <h2>活動額度</h2>
        <div className="table-wrap">
          <table className="admin-table">
            <thead><tr><th>人數級距</th><th className="num">單場費用</th><th className="num">可用場數</th></tr></thead>
            <tbody>{quota.map((q) => <tr key={q.id}><td>{q.minTravelers}～{q.maxTravelers} 人</td><td className="num">{money(q.price)}</td><td className="num">{q.balance}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
    </Shell>
  );
}
