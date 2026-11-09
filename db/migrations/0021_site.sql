-- 官網：試用申請與試用級距。試用申請屬於平台，不屬於任何旅行社，沒有租戶隔離。

CREATE TABLE trial_applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_name   text NOT NULL,
  code          text NOT NULL,
  contact_name  text NOT NULL,
  phone         text NOT NULL,
  email         citext NOT NULL,
  expected_size text NOT NULL,
  note          text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  ip_address    inet,
  handled_by    uuid REFERENCES platform_users(id),
  handled_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trial_applications_status_idx ON trial_applications (status, created_at DESC);
CREATE INDEX trial_applications_ip_idx ON trial_applications (ip_address, created_at);
-- 同一個網址同時只能有一筆待處理的申請
CREATE UNIQUE INDEX trial_applications_pending_code ON trial_applications (code) WHERE status = 'pending';

-- 免費試用：一場活動，最多 100 位旅客，不收費。由平台人員開通額度。
INSERT INTO pricing_tiers (min_travelers, max_travelers, price_amount) VALUES (1, 100, 0) ON CONFLICT DO NOTHING;
