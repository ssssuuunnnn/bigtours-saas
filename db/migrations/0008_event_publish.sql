-- 付款說明、條款檔名與活動的服務人員。

ALTER TABLE events
  ADD COLUMN payment_instructions text,
  ADD COLUMN terms_file_name      text;

CREATE TABLE event_service_contacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id  uuid NOT NULL,
  event_id   uuid NOT NULL,
  name       text NOT NULL,
  phone      text NOT NULL,
  scope      text NOT NULL,  -- 服務範圍
  sort_order int NOT NULL DEFAULT 0,
  UNIQUE (agency_id, id),
  FOREIGN KEY (agency_id, event_id) REFERENCES events(agency_id, id) ON DELETE CASCADE
);
CREATE INDEX event_service_contacts_event_idx ON event_service_contacts (agency_id, event_id);

ALTER TABLE event_service_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_service_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON event_service_contacts
  USING (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid)
  WITH CHECK (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid);
