/**
 * 示範活動的內容，本機示範資料（db/seed.ts）與官網公開試玩（DemoService）共用。
 * 只用傳入的查詢函式寫入，呼叫端決定連線與交易。
 */
export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

/** 刪除整間旅行社時的順序：先刪參照別人的資料表。新增帶 agency_id 的資料表時要加進來，測試會檢查。 */
export const AGENCY_TABLES = [
  'audit_logs', 'import_jobs', 'agency_user_links', 'company_contact_sessions', 'company_contact_links', 'export_jobs', 'export_templates', 'email_messages', 'email_templates',
  'room_publications', 'agency_user_sessions', 'employee_sessions', 'employee_password_links', 'room_assignments', 'rooms', 'room_preferences',
  'registration_revisions', 'traveler_option_preferences', 'traveler_options', 'travelers', 'seat_hold_room_items', 'seat_hold_items', 'seat_holds', 'registration_drafts', 'registrations',
  'event_employees', 'event_fields', 'option_quota_sessions', 'option_quotas', 'options', 'option_groups', 'session_room_types', 'event_service_contacts',
  'traveler_types', 'event_sessions', 'agency_quota_ledger', 'agency_mail_usage', 'events', 'company_contacts', 'companies', 'agency_users',
] as const;

export interface DemoEventOptions {
  slug: string;
  /** 第一梯名額；第二梯固定 3 位，方便看到額滿與保留中的狀態。 */
  firstSessionCapacity: number;
  /** 兩個梯次共用的名額。 */
  aquariumCapacity: number;
  dinnerCapacity: number;
}

export const DEMO_EVENT_NAME = '2027 艾克米員工旅遊・沖繩三日';

export async function buildDemoEvent(q: Query, agencyId: string, companyId: string, tierId: string, o: DemoEventOptions): Promise<{ eventId: string; sessionIds: [string, string] }> {
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params)).rows[0];
  const eventId: string = (await one(
    `INSERT INTO events (agency_id, company_id, slug, name, status, pricing_tier_id, default_subsidy_amount, default_dependent_limit, ends_on,
                         registration_opens_at, registration_closes_at, itinerary)
     VALUES ($1, $2, $3, $4, 'published', $5, 10000, 2, '2027-03-20',
             now() - interval '1 day', now() + interval '60 days', $6) RETURNING id`,
    [agencyId, companyId, o.slug, DEMO_EVENT_NAME, tierId, JSON.stringify({
      summary: '三天兩夜的沖繩員工旅遊，3/2 可自選行程。',
      days: [
        { title: '第一天', description: '桃園出發，抵達那霸，國際通自由活動。' },
        { title: '第二天', description: '依自選行程分組活動。' },
        { title: '第三天', description: '首里城巡禮，傍晚搭機返台。' },
      ],
    })],
  )).id;

  const s1: string = (await one(`INSERT INTO event_sessions (agency_id, event_id, name, departs_on, returns_on, outbound_flight_no, return_flight_no, departure_time, return_arrival_time, capacity, sort_order) VALUES ($1, $2, '第一梯 沖繩三日遊', '2027-03-01', '2027-03-03', 'CX001', 'CX002', '08:30', '19:40', $3, 1) RETURNING id`, [agencyId, eventId, o.firstSessionCapacity])).id;
  // 第二梯晚一天出發，自選行程同樣在 3/2，是第二梯的第一天下午，所以另外設定每日行程。
  const s2Days = [
    { title: '第一天', description: '上午抵達那霸，下午依自選行程分組活動。' },
    { title: '第二天', description: '國際通自由活動。' },
    { title: '第三天', description: '首里城巡禮，傍晚搭機返台。' },
  ];
  const s2: string = (await one(`INSERT INTO event_sessions (agency_id, event_id, name, departs_on, returns_on, departure_time, return_arrival_time, capacity, itinerary_days, sort_order) VALUES ($1, $2, '第二梯 沖繩三日遊', '2027-03-02', '2027-03-04', '07:15', '21:05', 3, $3, 2) RETURNING id`, [agencyId, eventId, JSON.stringify(s2Days)])).id;

  const types: [string, number, boolean][] = [['員工本人', 15000, true], ['成人眷屬', 12000, false], ['兒童眷屬', 8000, false], ['嬰兒眷屬', 1000, false]];
  for (const [i, [name, price, self]] of types.entries()) {
    await q(`INSERT INTO traveler_types (agency_id, event_id, name, base_price, is_employee_self, sort_order) VALUES ($1, $2, $3, $4, $5, $6)`, [agencyId, eventId, name, price, self, i]);
  }
  await q(`UPDATE traveler_types SET note = '含機票與保險' WHERE event_id = $1 AND name = '成人眷屬'`, [eventId]);
  await q(`UPDATE traveler_types SET note = '未滿 2 歲', occupies_bed = false WHERE event_id = $1 AND name = '嬰兒眷屬'`, [eventId]);

  const group = async (name: string, required: boolean, min: number, max: number, sort: number): Promise<string> =>
    (await one(`INSERT INTO option_groups (agency_id, event_id, name, is_required, min_select, max_select, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [agencyId, eventId, name, required, min, max, sort])).id;
  /** 每組名額列出適用的梯次；列多個梯次就是共用名額。 */
  const option = async (g: string, name: string, price: number, quotas: [string[], number][], sort: number) => {
    const id: string = (await one(`INSERT INTO options (agency_id, group_id, name, price, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [agencyId, g, name, price, sort])).id;
    for (const [sessions, capacity] of quotas) {
      const quota: string = (await one(`INSERT INTO option_quotas (agency_id, option_id, capacity) VALUES ($1, $2, $3) RETURNING id`, [agencyId, id, capacity])).id;
      for (const session of sessions) {
        await q(`INSERT INTO option_quota_sessions (agency_id, quota_id, option_id, session_id) VALUES ($1, $2, $3, $4)`, [agencyId, quota, id, session]);
      }
    }
  };
  const day2 = await group('自選行程', true, 1, 1, 1);
  await q(`UPDATE option_groups SET preference_count = 3, activity_date = '2027-03-02' WHERE id = $1`, [day2]);
  // 兩個梯次在同一天參加，共用名額，方便測試跨梯次額滿。
  await option(day2, '美麗海水族館', 2000, [[[s1, s2], o.aquariumCapacity]], 1);
  await option(day2, '市區觀光', 0, [], 2);
  const addOn = await group('加購活動', false, 0, 2, 2);
  await option(addOn, '溫泉', 500, [], 1);
  await option(addOn, '晚宴升級', 800, [[[s1], o.dinnerCapacity]], 2);

  // 床位依第一梯名額放大，試玩的人多也排得下
  const rooms: [string, string, number, number, number][] = [
    [s1, '二人房', 2, 0, Math.max(60, o.firstSessionCapacity + 20)], [s1, '單人房', 1, 3000, Math.max(10, Math.ceil(o.firstSessionCapacity / 4))],
    [s2, '三人房', 3, 0, 30], [s2, '二人房', 2, 1000, 20],
  ];
  for (const [i, [session, name, capacity, surcharge, beds]] of rooms.entries()) {
    await q(`INSERT INTO session_room_types (agency_id, session_id, name, capacity, surcharge, bed_quota, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [agencyId, session, name, capacity, surcharge, beds, i]);
  }

  for (const [i, [name, phone, scope]] of [['李冠廷', '0912-000-111', '報名與付款問題'], ['吳佩珊', '0912-000-222', '行前說明、出團當天聯繫']].entries()) {
    await q(`INSERT INTO event_service_contacts (agency_id, event_id, name, phone, scope, sort_order) VALUES ($1, $2, $3, $4, $5, $6)`, [agencyId, eventId, name, phone, scope, i]);
  }
  await q(
    `UPDATE events SET payment_instructions = '請於 2/5（五）前匯款至 示範銀行 012-345678，並在備註填寫員工姓名。\n付款問題請洽 02-2345-6789。' WHERE id = $1`,
    [eventId],
  );

  const fields: [string, string, string, unknown, boolean, boolean][] = [
    ['birthday', '生日', 'date', null, true, false],
    ['national_id', '身分證字號', 'text', null, true, true],
    ['diet', '飲食需求', 'select', ['一般', '素食', '不吃牛'], false, false],
    ['height', '身高（公分）', 'number', null, false, false],
    ['needs', '需要的協助（可複選）', 'multiselect', ['輪椅', '嬰兒車', '低樓層房間'], false, false],
  ];
  for (const [i, [k, label, type, choices, required, sensitive]] of fields.entries()) {
    await q(`INSERT INTO event_fields (agency_id, event_id, field_key, label, field_type, choices, is_required, is_sensitive, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [agencyId, eventId, k, label, type, choices ? JSON.stringify(choices) : null, required, sensitive, i]);
  }
  return { eventId, sessionIds: [s1, s2] };
}
