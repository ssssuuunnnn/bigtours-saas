-- 分房：房間對應梯次的房型；公布時存下當時的結果，重新公布前員工看到的都是這份。
ALTER TABLE rooms
  DROP COLUMN room_type_option_id,
  ADD COLUMN session_room_type_id uuid,
  ADD CONSTRAINT rooms_room_type_fk FOREIGN KEY (agency_id, session_room_type_id) REFERENCES session_room_types(agency_id, id) ON DELETE SET NULL (session_room_type_id);

CREATE TABLE room_publications (
  session_id   uuid PRIMARY KEY,
  agency_id    uuid NOT NULL,
  snapshot     jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid,
  FOREIGN KEY (agency_id, session_id) REFERENCES event_sessions(agency_id, id) ON DELETE CASCADE
);

ALTER TABLE room_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON room_publications
  USING (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid)
  WITH CHECK (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid);

-- 公布時間改記在 room_publications。
ALTER TABLE event_sessions DROP COLUMN rooms_published_at;
