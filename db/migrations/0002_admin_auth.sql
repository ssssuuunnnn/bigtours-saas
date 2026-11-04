-- 後台登入：工作階段與登入失敗鎖定

ALTER TABLE agency_users
  ADD COLUMN failed_login_count int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz;

ALTER TABLE company_contacts
  ADD COLUMN failed_login_count int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz;

CREATE TABLE admin_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id  uuid NOT NULL REFERENCES agencies(id),
  actor_type text NOT NULL CHECK (actor_type IN ('agency_user','company_contact')),
  actor_id   uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_sessions_expiry_idx ON admin_sessions (expires_at);

ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON admin_sessions
  USING (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid)
  WITH CHECK (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid);
