-- 前台圖片與行程 PDF。hero_object_key 是登入頁背景（PC）。

ALTER TABLE events
  ADD COLUMN login_mobile_object_key text,
  ADD COLUMN home_image_object_key   text;

ALTER TABLE options
  ADD COLUMN pdf_object_key text,
  ADD COLUMN pdf_file_name  text;
