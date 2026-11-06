-- 旅行社人員以邀請信開通，建立時還沒有密碼。
ALTER TABLE agency_users
  ALTER COLUMN password_hash DROP NOT NULL,
  ADD COLUMN last_login_at timestamptz;

CREATE TABLE agency_user_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id      uuid NOT NULL REFERENCES agencies(id),
  agency_user_id uuid NOT NULL REFERENCES agency_users(id) ON DELETE CASCADE,
  token_hash     bytea NOT NULL UNIQUE,
  created_by     uuid,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agency_user_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_user_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agency_user_links
  USING (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid)
  WITH CHECK (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid);
