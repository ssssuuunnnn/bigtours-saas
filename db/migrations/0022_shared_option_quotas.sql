-- 梯次行程不同：梯次可另外設定每日行程、自選行程群組可設定舉辦日期、選項名額可跨梯次共用。

-- 梯次另外設定的每日行程；NULL 表示沿用活動的預設行程。
ALTER TABLE event_sessions ADD COLUMN itinerary_days jsonb CHECK (itinerary_days IS NULL OR jsonb_typeof(itinerary_days) = 'array');

-- 群組的舉辦日期，同一群組的選項都在同一天；前台依梯次的去程日期換算第幾天。
ALTER TABLE option_groups ADD COLUMN activity_date date;

-- 選項名額改成「名額組」：一組名額可適用多個梯次，任一梯次選了都扣同一組。
-- 原本每列就是一個梯次的名額，搬成只適用一個梯次的名額組，id 不變，保留中的名額不受影響。
ALTER TABLE option_session_quotas RENAME TO option_quotas;
ALTER TABLE option_quotas ADD CONSTRAINT option_quotas_option_key UNIQUE (agency_id, id, option_id);

CREATE TABLE option_quota_sessions (
  agency_id  uuid NOT NULL,
  quota_id   uuid NOT NULL,
  option_id  uuid NOT NULL,
  session_id uuid NOT NULL,
  PRIMARY KEY (quota_id, session_id),
  -- 同一個選項中，每個梯次最多屬於一組名額。
  UNIQUE (option_id, session_id),
  FOREIGN KEY (agency_id, quota_id, option_id) REFERENCES option_quotas(agency_id, id, option_id) ON DELETE CASCADE,
  FOREIGN KEY (agency_id, session_id) REFERENCES event_sessions(agency_id, id) ON DELETE CASCADE
);
CREATE INDEX option_quota_sessions_session_idx ON option_quota_sessions (session_id);

INSERT INTO option_quota_sessions (agency_id, quota_id, option_id, session_id)
SELECT agency_id, id, option_id, session_id FROM option_quotas;

ALTER TABLE option_quotas DROP COLUMN session_id;

ALTER TABLE option_quota_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE option_quota_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON option_quota_sessions
  USING (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid)
  WITH CHECK (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid);
