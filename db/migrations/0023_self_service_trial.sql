-- 自助試用（PRD 15.3）：官網申請 → Email 驗證 → 自動開通（或由平台核准）。

-- 試用中的旅行社：合約迄日即試用最後一天；到期後唯讀，再過 30 天整間刪除。
-- 轉正式時把 is_trial 改回 false，之後就和一般旅行社相同。
ALTER TABLE agencies
  ADD COLUMN is_trial boolean NOT NULL DEFAULT false,
  ADD COLUMN tax_id text CHECK (tax_id ~ '^[0-9]{8}$'),
  -- 已寄出的到期提醒：1＝7 天前、2＝1 天前、3＝已到期
  ADD COLUMN trial_notice_level smallint NOT NULL DEFAULT 0;
CREATE INDEX agencies_tax_id_idx ON agencies (tax_id) WHERE tax_id IS NOT NULL;

-- 申請狀態：unverified 等 Email 驗證；pending 已驗證、等平台核准（關閉自動開通時）；
-- approved 已開通；rejected 平台退回；expired 驗證連結過期沒有使用。
ALTER TABLE trial_applications
  ADD COLUMN tax_id text CHECK (tax_id ~ '^[0-9]{8}$'),
  ADD COLUMN token_hash bytea UNIQUE,
  ADD COLUMN token_expires_at timestamptz,
  ADD COLUMN verified_at timestamptz,
  -- 不叫 agency_id：申請屬於平台，不是旅行社的租戶資料（刪除旅行社時保留申請紀錄，一個統編只能試用一次）
  ADD COLUMN activated_agency_id uuid REFERENCES agencies(id) ON DELETE SET NULL;
ALTER TABLE trial_applications DROP CONSTRAINT trial_applications_status_check;
ALTER TABLE trial_applications ADD CONSTRAINT trial_applications_status_check
  CHECK (status IN ('unverified', 'pending', 'approved', 'rejected', 'expired'));
DROP INDEX trial_applications_pending_code;
CREATE UNIQUE INDEX trial_applications_open_code ON trial_applications (code) WHERE status IN ('unverified', 'pending');
CREATE UNIQUE INDEX trial_applications_open_tax_id ON trial_applications (tax_id) WHERE status IN ('unverified', 'pending');
CREATE INDEX trial_applications_tax_id_idx ON trial_applications (tax_id) WHERE tax_id IS NOT NULL;

-- 平台設定
CREATE TABLE platform_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES platform_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings (key, value) VALUES ('trial_auto_approve', 'true') ON CONFLICT DO NOTHING;

-- 試用旅行社每天寄出的信件數（總共 100 封、每天 40 封）
CREATE TABLE agency_mail_usage (
  agency_id uuid NOT NULL REFERENCES agencies(id),
  day       date NOT NULL,
  sent      int NOT NULL DEFAULT 0 CHECK (sent >= 0),
  PRIMARY KEY (agency_id, day)
);
ALTER TABLE agency_mail_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_mail_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agency_mail_usage
  USING (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid)
  WITH CHECK (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid);

-- 試用級距改為最多 40 人；原本 1～100 人的免費級距停用（還沒有旅行社使用）
INSERT INTO pricing_tiers (min_travelers, max_travelers, price_amount) VALUES (1, 40, 0) ON CONFLICT DO NOTHING;
UPDATE pricing_tiers SET is_active = false WHERE min_travelers = 1 AND max_travelers = 100 AND price_amount = 0;
