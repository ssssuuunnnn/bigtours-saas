-- SES 退信與客訴通知：依寄出時 SES 回傳的訊息 ID 找回那封信。

CREATE INDEX email_messages_provider_idx ON email_messages (provider_message_id) WHERE provider_message_id IS NOT NULL;

-- 通知進來時還不知道是哪間旅行社，而 email_messages 受 RLS 保護。
-- 這個函式只回傳完全相符那封信的旅行社 id，後續更新仍在該旅行社的交易內進行。
CREATE FUNCTION email_message_agency(message_id text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT agency_id FROM email_messages WHERE provider_message_id = message_id LIMIT 1 $$;
