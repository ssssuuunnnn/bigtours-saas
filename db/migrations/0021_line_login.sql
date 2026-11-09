-- LINE 登入：旅行社各自設定 LINE Login Channel 與 LIFF，員工在 LINE 裡以員工編號＋密碼綁定一次後自動登入。

ALTER TABLE agencies
  ADD COLUMN line_channel_id text CHECK (line_channel_id ~ '^[0-9]{6,20}$'),
  ADD COLUMN line_liff_id    text CHECK (line_liff_id ~ '^[0-9]{6,20}-[A-Za-z0-9]{4,32}$'),
  ADD CONSTRAINT agencies_line_pair_check CHECK ((line_channel_id IS NULL) = (line_liff_id IS NULL));

-- 旅行社已設定 LINE 時才有作用；新活動預設開啟。
ALTER TABLE events ADD COLUMN line_enabled boolean NOT NULL DEFAULT true;

-- 不需要推播，所以不存 LINE 帳號識別碼本身，只存雜湊；不存暱稱、大頭貼與 Email。
ALTER TABLE event_employees
  ADD COLUMN line_user_hash bytea,
  ADD COLUMN line_bound_at  timestamptz,
  ADD CONSTRAINT event_employees_line_pair_check CHECK ((line_user_hash IS NULL) = (line_bound_at IS NULL));

-- 同一個活動裡，一個 LINE 帳號只能綁定一位員工。
CREATE UNIQUE INDEX event_employees_line_user_unique ON event_employees (event_id, line_user_hash)
  WHERE line_user_hash IS NOT NULL;
-- 旅行社共用連結依 LINE 帳號找出已綁定的活動。
CREATE INDEX event_employees_line_user_idx ON event_employees (agency_id, line_user_hash)
  WHERE line_user_hash IS NOT NULL;
