-- 旅客類型的備註與不佔床、各梯次的房型、自選行程群組的志願設定。

ALTER TABLE traveler_types
  ADD COLUMN note         text,
  ADD COLUMN occupies_bed boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT traveler_types_self_occupies_bed CHECK (occupies_bed OR NOT is_employee_self);

-- 每個活動固定有員工本人這個類型，團費由旅行社填寫。
INSERT INTO traveler_types (agency_id, event_id, name, base_price, is_employee_self)
SELECT e.agency_id, e.id, '員工本人', 0, true FROM events e
 WHERE NOT EXISTS (SELECT 1 FROM traveler_types t WHERE t.event_id = e.id AND t.is_employee_self);

CREATE TABLE session_room_types (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id  uuid NOT NULL,
  session_id uuid NOT NULL,
  name       text NOT NULL,
  capacity   int NOT NULL CHECK (capacity >= 1),  -- 可住人數
  surcharge  int NOT NULL DEFAULT 0 CHECK (surcharge >= 0),  -- 每人加價
  bed_quota  int NOT NULL CHECK (bed_quota >= 0),  -- 可售床位，以人計算
  sold_count int NOT NULL DEFAULT 0 CHECK (sold_count >= 0),
  sort_order int NOT NULL DEFAULT 0,
  UNIQUE (agency_id, id),
  CHECK (sold_count <= bed_quota),
  FOREIGN KEY (agency_id, session_id) REFERENCES event_sessions(agency_id, id) ON DELETE CASCADE
);
CREATE INDEX session_room_types_session_idx ON session_room_types (agency_id, session_id);

ALTER TABLE session_room_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_room_types FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON session_room_types
  USING (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid)
  WITH CHECK (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid);

-- 可填到第幾志願；1 表示不開啟。志願只用於單選的群組。
ALTER TABLE option_groups
  ADD COLUMN preference_count int NOT NULL DEFAULT 1 CHECK (preference_count BETWEEN 1 AND 3),
  ADD CONSTRAINT option_groups_preference_single CHECK (preference_count = 1 OR max_select = 1);
