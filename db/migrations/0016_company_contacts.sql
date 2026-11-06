-- 企業窗口帳號：以邀請信開通，所以建立時還沒有密碼。
ALTER TABLE company_contacts
  ALTER COLUMN password_hash DROP NOT NULL,
  ADD COLUMN failed_login_count int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz;

ALTER TABLE company_contacts ADD CONSTRAINT company_contacts_agency_id_key UNIQUE (agency_id, id);

CREATE TABLE company_contact_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   uuid NOT NULL,
  contact_id  uuid NOT NULL,
  token_hash  bytea NOT NULL UNIQUE,
  created_by  uuid,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agency_id, contact_id) REFERENCES company_contacts(agency_id, id) ON DELETE CASCADE
);

CREATE TABLE company_contact_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   uuid NOT NULL,
  contact_id  uuid NOT NULL,
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agency_id, contact_id) REFERENCES company_contacts(agency_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_contact_links', 'company_contact_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid)
      WITH CHECK (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
