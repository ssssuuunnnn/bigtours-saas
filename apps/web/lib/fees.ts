/** 修改後的費用，規則和後端相同：沒改動的項目用原價格，新選的用目前價格，手動調整過的差額保留。 */
export interface ModifiableRegistration {
  totalAmount: number;
  subsidyAmount: number;
  travelers: { id: string; travelerTypeId: string; roomTypeId: string | null; basePrice: number; roomType: { surcharge: number } | null; options: { optionId: string; price: number }[] }[];
}
export interface Prices { types: Map<string, number>; rooms: Map<string, number>; options: Map<string, number> }

export function modifiedFees(reg: ModifiableRegistration, next: { key: string; travelerTypeId: string; roomTypeId: string | null; optionIds: string[] }[], prices: Prices) {
  const original = new Map(reg.travelers.map((x) => [x.id, x]));
  const oldSum = reg.travelers.reduce((sum, x) => sum + x.basePrice + (x.roomType?.surcharge ?? 0) + x.options.reduce((a, o) => a + o.price, 0), 0);
  const newSum = next.reduce((sum, x) => {
    const old = original.get(x.key);
    const base = old && old.travelerTypeId === x.travelerTypeId ? old.basePrice : prices.types.get(x.travelerTypeId) ?? 0;
    const room = !x.roomTypeId ? 0 : old && old.roomTypeId === x.roomTypeId ? old.roomType?.surcharge ?? 0 : prices.rooms.get(x.roomTypeId) ?? 0;
    const oldOptions = new Map(old?.options.map((o) => [o.optionId, o.price]) ?? []);
    return sum + base + room + x.optionIds.reduce((a, id) => a + (oldOptions.get(id) ?? prices.options.get(id) ?? 0), 0);
  }, 0);
  const total = Math.max(reg.totalAmount + newSum - oldSum, 0);
  return { total, subsidyApplied: Math.min(total, reg.subsidyAmount), selfPay: Math.max(total - reg.subsidyAmount, 0), diff: total - reg.totalAmount };
}

/** crypto.randomUUID 只能在 HTTPS 使用；本機以 http://*.lvh.me 開發時改用 getRandomValues。 */
export function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
