-- 前台主色改為每個活動各自設定，並新增登入頁客服資訊。

ALTER TABLE events
  ADD COLUMN theme_color   text NOT NULL DEFAULT '#0E6B72' CHECK (theme_color ~ '^#[0-9A-Fa-f]{6}$'),
  ADD COLUMN support_phone text,
  ADD COLUMN support_hours text;

UPDATE events e SET theme_color = a.primary_color
  FROM agencies a
 WHERE a.id = e.agency_id AND a.primary_color ~ '^#[0-9A-Fa-f]{6}$';

ALTER TABLE agencies DROP COLUMN primary_color;
