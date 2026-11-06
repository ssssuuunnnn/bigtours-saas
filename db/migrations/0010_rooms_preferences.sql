-- 員工報名時選的房型、房型床位保留，以及自選行程的第二、第三志願。

ALTER TABLE travelers
  ADD COLUMN session_room_type_id    uuid,
  ADD COLUMN room_surcharge_snapshot int NOT NULL DEFAULT 0 CHECK (room_surcharge_snapshot >= 0),
  ADD CONSTRAINT travelers_room_type_fk FOREIGN KEY (agency_id, session_room_type_id) REFERENCES session_room_types(agency_id, id);
CREATE INDEX travelers_room_type_idx ON travelers (session_room_type_id) WHERE session_room_type_id IS NOT NULL;

CREATE TABLE seat_hold_room_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id    uuid NOT NULL,
  hold_id      uuid NOT NULL,
  room_type_id uuid NOT NULL,
  quantity     int NOT NULL CHECK (quantity > 0),
  UNIQUE (hold_id, room_type_id),
  FOREIGN KEY (agency_id, hold_id) REFERENCES seat_holds(agency_id, id) ON DELETE CASCADE,
  FOREIGN KEY (agency_id, room_type_id) REFERENCES session_room_types(agency_id, id) ON DELETE CASCADE
);
CREATE INDEX seat_hold_room_items_room_idx ON seat_hold_room_items (room_type_id);

-- 第一志願就是 traveler_options 裡選的選項；這裡只放不佔名額、不計費的第二、第三志願。
CREATE TABLE traveler_option_preferences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   uuid NOT NULL,
  traveler_id uuid NOT NULL,
  group_id    uuid NOT NULL,
  rank        int NOT NULL CHECK (rank IN (2, 3)),
  option_id   uuid NOT NULL,
  UNIQUE (traveler_id, group_id, rank),
  UNIQUE (traveler_id, group_id, option_id),
  FOREIGN KEY (agency_id, traveler_id) REFERENCES travelers(agency_id, id) ON DELETE CASCADE,
  FOREIGN KEY (agency_id, option_id) REFERENCES options(agency_id, id) ON DELETE CASCADE
);
CREATE INDEX traveler_option_preferences_option_idx ON traveler_option_preferences (option_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['seat_hold_room_items', 'traveler_option_preferences'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid)
      WITH CHECK (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
