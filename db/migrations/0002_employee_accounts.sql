-- 員工改用帳號（員工編號）與密碼登入，取代專屬連結；新增活動頁開關。

ALTER TABLE events
  ADD COLUMN page_mode     text NOT NULL DEFAULT 'manual' CHECK (page_mode IN ('manual','scheduled')),
  ADD COLUMN page_is_open  boolean NOT NULL DEFAULT true,  -- 手動模式使用
  ADD COLUMN page_opens_at  timestamptz,                   -- 自動模式使用
  ADD COLUMN page_closes_at timestamptz,                   -- 自動模式使用
  ADD CONSTRAINT events_page_schedule_check CHECK (
    page_mode <> 'scheduled'
    OR (page_opens_at IS NOT NULL AND page_closes_at IS NOT NULL AND page_closes_at > page_opens_at)
  );

ALTER TABLE event_employees
  DROP COLUMN link_token_hash,
  DROP COLUMN link_token_encrypted,
  DROP COLUMN link_issued_at,
  ADD COLUMN password_hash      text,                       -- NULL 表示尚未設定密碼
  ADD COLUMN password_set_at    timestamptz,
  ADD COLUMN failed_login_count int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until       timestamptz;

-- 只存雜湊；連結本身只在產生當下回傳一次
CREATE TABLE employee_password_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id         uuid NOT NULL,
  event_employee_id uuid NOT NULL,
  token_hash        bytea NOT NULL UNIQUE,
  delivery          text NOT NULL CHECK (delivery IN ('email','manual')),
  created_by_type   text NOT NULL CHECK (created_by_type IN ('agency_user','company_contact','system')),
  created_by_id     uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  used_at           timestamptz,
  revoked_at        timestamptz,
  FOREIGN KEY (agency_id, event_employee_id) REFERENCES event_employees(agency_id, id) ON DELETE CASCADE
);
-- 一位員工同時只有一個可用連結
CREATE UNIQUE INDEX employee_password_links_one_active ON employee_password_links (event_employee_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE employee_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id         uuid NOT NULL,
  event_employee_id uuid NOT NULL,
  token_hash        bytea NOT NULL UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,
  FOREIGN KEY (agency_id, event_employee_id) REFERENCES event_employees(agency_id, id) ON DELETE CASCADE
);
CREATE INDEX employee_sessions_employee_idx ON employee_sessions (event_employee_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee_password_links', 'employee_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid)
      WITH CHECK (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
