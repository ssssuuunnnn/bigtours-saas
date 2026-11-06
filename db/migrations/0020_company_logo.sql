-- 企業 Logo 顯示在前台頁首，同一企業的活動共用。
ALTER TABLE companies ADD COLUMN logo_object_key text;
