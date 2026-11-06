-- 平台人員登入。平台不屬於任何旅行社，這兩張表沒有租戶隔離，只有平台後台會用到。
ALTER TABLE platform_users
  ADD COLUMN failed_login_count int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz;

CREATE TABLE platform_user_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  token_hash       bytea NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
