-- 修改紀錄的摘要：不含個資，畫面可以直接顯示，完整內容仍加密存在前後快照。
ALTER TABLE registration_revisions ADD COLUMN summary jsonb NOT NULL DEFAULT '{}';
