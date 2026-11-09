'use client';

import { a } from '../../../../../messages/admin';

export interface Day { title: string; description: string }

/** 每日行程的編輯列：活動基本資料的預設行程與梯次另外設定的行程共用。 */
export function DaysEditor({ days, onChange }: { days: Day[]; onChange: (days: Day[]) => void }) {
  const setDay = (i: number, patch: Partial<Day>) => onChange(days.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  return (
    <>
      <div className="admin-days">
        {days.map((d, i) => (
          <div key={i} style={{ display: 'contents' }}>
            <input aria-label={a.dayTitleLabel(i + 1)} type="text" required maxLength={50} value={d.title} onChange={(e) => setDay(i, { title: e.target.value })} />
            <input aria-label={a.dayContentLabel(i + 1)} type="text" maxLength={500} value={d.description} onChange={(e) => setDay(i, { description: e.target.value })} />
            <button type="button" className="link" onClick={() => onChange(days.filter((_, j) => j !== i))}>{a.remove}</button>
          </div>
        ))}
      </div>
      <button type="button" className="link" onClick={() => onChange([...days, { title: a.dayTitle(days.length + 1), description: '' }])}>{a.addDay}</button>
    </>
  );
}
