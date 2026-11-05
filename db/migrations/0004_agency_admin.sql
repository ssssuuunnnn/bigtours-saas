-- 旅行社人員登入，以及後台設定需要的限制。

ALTER TABLE agency_users
  ADD COLUMN failed_login_count int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until       timestamptz;

CREATE TABLE agency_user_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id      uuid NOT NULL REFERENCES agencies(id),
  agency_user_id uuid NOT NULL REFERENCES agency_users(id) ON DELETE CASCADE,
  token_hash     bytea NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz
);
CREATE INDEX agency_user_sessions_user_idx ON agency_user_sessions (agency_user_id);

ALTER TABLE agency_user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_user_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agency_user_sessions
  USING (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid)
  WITH CHECK (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid);

-- 後台網址是 旅行社代號.平台網域/admin，活動代碼不能與它相同
ALTER TABLE events ADD CONSTRAINT events_slug_not_reserved CHECK (slug <> 'admin');
