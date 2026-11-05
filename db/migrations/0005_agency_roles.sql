-- 旅行社人員分為管理員、活動操作員與營運人員，並保存釘選的活動選單項目。

ALTER TABLE agency_users DROP CONSTRAINT agency_users_role_check;
UPDATE agency_users SET role = 'event_operator' WHERE role = 'operator';
ALTER TABLE agency_users
  ADD CONSTRAINT agency_users_role_check CHECK (role IN ('admin','event_operator','operations')),
  ADD COLUMN pinned_nav_items text[] NOT NULL DEFAULT '{}';
