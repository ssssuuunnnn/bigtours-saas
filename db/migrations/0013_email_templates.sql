-- 範本改成每個活動各自一份；沒有資料列時用系統預設。
DELETE FROM email_templates;
ALTER TABLE email_templates
  ADD COLUMN event_id uuid NOT NULL,
  DROP CONSTRAINT email_templates_agency_id_template_key_key,
  ADD CONSTRAINT email_templates_event_key UNIQUE (event_id, template_key),
  ADD CONSTRAINT email_templates_event_fk FOREIGN KEY (agency_id, event_id) REFERENCES events(agency_id, id) ON DELETE CASCADE;

-- 重寄需要原本信件的資料；帳號信的連結不存，重寄時重新產生。
ALTER TABLE email_messages
  ADD COLUMN payload jsonb,
  ADD COLUMN resolved_at timestamptz;

-- 新的取消申請、員工修改報名要通知的旅行社信箱。
ALTER TABLE events ADD COLUMN notify_emails text[] NOT NULL DEFAULT '{}';
