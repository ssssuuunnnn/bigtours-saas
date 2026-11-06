import type { Tx } from './database.service.ts';

export type RevisionSummary =
  | { action: 'created' }
  | { action: 'cancel_requested' }
  | { action: 'cancel_confirmed' }
  | { action: 'cancel_rejected' }
  | { action: 'payment'; from: string; to: string }
  | { action: 'fee_adjusted'; from: number; to: number; reason: string }
  | { action: 'reassigned'; from: number; to: number; reason: string; changes: { traveler: string; from: string; to: string }[] };

/** 呼叫前要先鎖定這筆報名，版本號才不會重複。 */
export async function addRevision(
  tx: Tx,
  agencyId: string,
  registrationId: string,
  actor: { type: 'employee' | 'agency_user'; id: string | null },
  summary: RevisionSummary,
) {
  await tx.query(
    `INSERT INTO registration_revisions (agency_id, registration_id, revision_no, actor_type, actor_id, changed_fields, summary)
     VALUES ($1, $2, (SELECT COALESCE(max(revision_no), 0) + 1 FROM registration_revisions WHERE registration_id = $2), $3, $4, $5, $6)`,
    [agencyId, registrationId, actor.type, actor.id, [summary.action], JSON.stringify(summary)],
  );
}

/** 費用改變後的付款狀態：自付變 0 就不用付款；原本不用付款、現在要付就回到未付。已付與已退款由旅行社處理。 */
export function paymentAfter(current: string, selfPay: number) {
  if (selfPay === 0 && current === 'unpaid') return 'not_required';
  if (selfPay > 0 && current === 'not_required') return 'unpaid';
  return current;
}
