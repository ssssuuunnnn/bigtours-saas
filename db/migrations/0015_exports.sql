-- 匯出：範本分旅客與報名兩種層級；工作記錄名稱、範圍與筆數，畫面才能列出最近匯出。
ALTER TABLE export_templates ADD COLUMN scope text NOT NULL DEFAULT 'travelers' CHECK (scope IN ('travelers', 'registrations'));

ALTER TABLE export_jobs
  ADD COLUMN name text NOT NULL DEFAULT '',
  ADD COLUMN scope text NOT NULL DEFAULT 'travelers' CHECK (scope IN ('travelers', 'registrations')),
  ADD COLUMN session_id uuid,
  ADD COLUMN row_count int,
  ADD COLUMN error text,
  ADD CONSTRAINT export_jobs_session_fk FOREIGN KEY (agency_id, session_id) REFERENCES event_sessions(agency_id, id) ON DELETE SET NULL (session_id);
CREATE INDEX export_jobs_event_idx ON export_jobs (agency_id, event_id, created_at DESC);
