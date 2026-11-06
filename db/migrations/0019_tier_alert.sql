-- 記錄已寄過哪個門檻的用量提醒，同一門檻只寄一次；升級級距後重新計算。
ALTER TABLE events ADD COLUMN tier_alert_level int NOT NULL DEFAULT 0 CHECK (tier_alert_level IN (0, 80, 100));
