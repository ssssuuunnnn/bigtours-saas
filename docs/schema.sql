-- 大團系統 資料表定義（PostgreSQL 16）
-- 金額單位：新台幣元（整數）。說明見 DATA_MODEL.md。

CREATE EXTENSION IF NOT EXISTS citext;

-- ===== 平台層級（不套用 RLS） =====

CREATE TABLE agencies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'), -- 子網域
  name              text NOT NULL,
  logo_object_key   text,
  primary_color     text,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  contract_starts_on date,
  contract_ends_on  date,
  plan_note         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pricing_tiers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  min_travelers int NOT NULL CHECK (min_travelers >= 0),
  max_travelers int NOT NULL,
  price_amount  int NOT NULL CHECK (price_amount >= 0),
  is_active     boolean NOT NULL DEFAULT true,
  CHECK (max_travelers >= min_travelers),
  UNIQUE (min_travelers, max_travelers)
);

-- ===== 旅行社與企業 =====

CREATE TABLE agency_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     uuid NOT NULL REFERENCES agencies(id),
  email         citext NOT NULL,
  password_hash text NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin','operator')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, email)
);

CREATE TABLE companies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id  uuid NOT NULL REFERENCES agencies(id),
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, id)
);

CREATE TABLE company_contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     uuid NOT NULL,
  company_id    uuid NOT NULL,
  email         citext NOT NULL,
  password_hash text NOT NULL,
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, email),
  FOREIGN KEY (agency_id, company_id) REFERENCES companies(agency_id, id)
);

-- ===== 活動設定 =====

CREATE TABLE events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id                uuid NOT NULL REFERENCES agencies(id),
  company_id               uuid NOT NULL,
  slug                     text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'), -- 活動代碼
  name                     text NOT NULL,
  itinerary                jsonb NOT NULL DEFAULT '{}',
  hero_object_key          text,
  status                   text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed','archived')),
  registration_opens_at    timestamptz,
  registration_closes_at   timestamptz,
  ends_on                  date,                                   -- 保存期限由此起算
  pricing_tier_id          uuid NOT NULL REFERENCES pricing_tiers(id),
  default_subsidy_amount   int NOT NULL DEFAULT 0 CHECK (default_subsidy_amount >= 0),
  default_dependent_limit  int NOT NULL DEFAULT 0 CHECK (default_dependent_limit >= 0),
  allow_dependents_only    boolean NOT NULL DEFAULT false,
  terms_object_key         text,
  terms_version            int NOT NULL DEFAULT 1,
  retention_days           int NOT NULL DEFAULT 180 CHECK (retention_days > 0),
  personal_data_purged_at  timestamptz,
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, slug),
  UNIQUE (agency_id, id),
  CHECK (registration_closes_at IS NULL OR registration_opens_at IS NULL OR registration_closes_at > registration_opens_at),
  FOREIGN KEY (agency_id, company_id) REFERENCES companies(agency_id, id)
);
CREATE INDEX events_company_idx ON events (agency_id, company_id);

CREATE TABLE agency_quota_ledger (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id          uuid NOT NULL REFERENCES agencies(id),
  pricing_tier_id    uuid NOT NULL REFERENCES pricing_tiers(id),
  change             int NOT NULL CHECK (change <> 0),  -- 正數增加、負數扣除
  reason             text NOT NULL CHECK (reason IN ('grant','event_created','event_deleted','tier_upgrade','adjustment')),
  event_id           uuid,                              -- 活動可能已刪除，不設外鍵
  note               text,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agency_quota_ledger_balance_idx ON agency_quota_ledger (agency_id, pricing_tier_id);

CREATE TABLE event_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id          uuid NOT NULL,
  event_id           uuid NOT NULL,
  name               text NOT NULL,
  departs_on         date,
  returns_on         date,
  capacity           int NOT NULL CHECK (capacity >= 0),
  sold_count         int NOT NULL DEFAULT 0 CHECK (sold_count >= 0),
  rooms_published_at timestamptz,
  sort_order         int NOT NULL DEFAULT 0,
  UNIQUE (agency_id, id),
  CHECK (sold_count <= capacity),
  FOREIGN KEY (agency_id, event_id) REFERENCES events(agency_id, id) ON DELETE CASCADE
);
CREATE INDEX event_sessions_event_idx ON event_sessions (agency_id, event_id);

CREATE TABLE traveler_types (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id        uuid NOT NULL,
  event_id         uuid NOT NULL,
  name             text NOT NULL,
  base_price       int NOT NULL CHECK (base_price >= 0),
  is_employee_self boolean NOT NULL DEFAULT false,
  sort_order       int NOT NULL DEFAULT 0,
  UNIQUE (agency_id, id),
  FOREIGN KEY (agency_id, event_id) REFERENCES events(agency_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX traveler_types_one_self ON traveler_types (event_id) WHERE is_employee_self;

CREATE TABLE option_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   uuid NOT NULL,
  event_id    uuid NOT NULL,
  name        text NOT NULL,
  is_required boolean NOT NULL DEFAULT false,
  min_select  int NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select  int NOT NULL DEFAULT 1,
  is_room_type boolean NOT NULL DEFAULT false,
  sort_order  int NOT NULL DEFAULT 0,
  UNIQUE (agency_id, id),
  CHECK (max_select >= min_select AND max_select >= 1),
  CHECK (NOT is_required OR min_select >= 1),
  FOREIGN KEY (agency_id, event_id) REFERENCES events(agency_id, id) ON DELETE CASCADE
);

CREATE TABLE options (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   uuid NOT NULL,
  group_id    uuid NOT NULL,
  name        text NOT NULL,
  description text,
  price       int NOT NULL DEFAULT 0 CHECK (price >= 0),
  sort_order  int NOT NULL DEFAULT 0,
  UNIQUE (agency_id, id),
  FOREIGN KEY (agency_id, group_id) REFERENCES option_groups(agency_id, id) ON DELETE CASCADE
);

-- 選項名額依梯次計算；沒有列表示該梯次此選項不限名額
CREATE TABLE option_session_quotas (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id  uuid NOT NULL,
  option_id  uuid NOT NULL,
  session_id uuid NOT NULL,
  capacity   int NOT NULL CHECK (capacity >= 0),
  sold_count int NOT NULL DEFAULT 0 CHECK (sold_count >= 0),
  UNIQUE (agency_id, id),
  UNIQUE (option_id, session_id),
  CHECK (sold_count <= capacity),
  FOREIGN KEY (agency_id, option_id) REFERENCES options(agency_id, id) ON DELETE CASCADE,
  FOREIGN KEY (agency_id, session_id) REFERENCES event_sessions(agency_id, id) ON DELETE CASCADE
);

CREATE TABLE event_fields (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id    uuid NOT NULL,
  event_id     uuid NOT NULL,
  field_key    text NOT NULL,
  label        text NOT NULL,
  field_type   text NOT NULL CHECK (field_type IN ('text','number','date','select','multiselect','checkbox','national_id','passport')),
  choices      jsonb,
  validation   jsonb,
  is_required  boolean NOT NULL DEFAULT false,
  is_sensitive boolean NOT NULL DEFAULT false,
  sort_order   int NOT NULL DEFAULT 0,
  UNIQUE (event_id, field_key),
  CHECK (field_type NOT IN ('national_id','passport') OR is_sensitive),
  FOREIGN KEY (agency_id, event_id) REFERENCES events(agency_id, id) ON DELETE CASCADE
);

-- ===== 名單 =====

CREATE TABLE event_employees (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id            uuid NOT NULL,
  event_id             uuid NOT NULL,
  employee_no          text NOT NULL,
  name                 text NOT NULL,
  email                citext,
  department           text,
  subsidy_amount       int CHECK (subsidy_amount >= 0),   -- NULL 時套用活動預設值
  dependent_limit      int CHECK (dependent_limit >= 0),  -- NULL 時套用活動預設值
  link_token_hash      bytea NOT NULL UNIQUE,             -- 查詢用；重新產生後舊連結立即失效
  link_token_encrypted bytea NOT NULL,                    -- 供窗口再次匯出
  link_issued_at       timestamptz NOT NULL DEFAULT now(),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, id),
  UNIQUE (event_id, employee_no),
  FOREIGN KEY (agency_id, event_id) REFERENCES events(agency_id, id) ON DELETE CASCADE
);

-- ===== 報名與名額保留 =====

CREATE TABLE registrations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id              uuid NOT NULL,
  event_id               uuid NOT NULL,
  event_employee_id      uuid NOT NULL,
  session_id             uuid NOT NULL,
  status                 text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancel_requested','cancelled')),
  total_amount           int NOT NULL CHECK (total_amount >= 0),
  subsidy_amount         int NOT NULL DEFAULT 0 CHECK (subsidy_amount >= 0), -- 報名當下的補助額度
  self_pay_amount        int GENERATED ALWAYS AS (GREATEST(total_amount - subsidy_amount, 0)) STORED,
  payment_status         text NOT NULL CHECK (payment_status IN ('unpaid','paid','refunded','not_required')),
  terms_version_accepted int NOT NULL,
  terms_accepted_at      timestamptz NOT NULL,
  submitted_at           timestamptz NOT NULL DEFAULT now(),
  cancel_requested_at    timestamptz,
  cancelled_at           timestamptz,
  cancelled_by           uuid,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, id),
  FOREIGN KEY (agency_id, event_id) REFERENCES events(agency_id, id),
  FOREIGN KEY (agency_id, event_employee_id) REFERENCES event_employees(agency_id, id),
  FOREIGN KEY (agency_id, session_id) REFERENCES event_sessions(agency_id, id)
);
CREATE UNIQUE INDEX registrations_one_active ON registrations (event_employee_id) WHERE status <> 'cancelled';
CREATE INDEX registrations_event_idx ON registrations (agency_id, event_id, status);

CREATE TABLE seat_holds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id         uuid NOT NULL,
  event_id          uuid NOT NULL,
  event_employee_id uuid NOT NULL,
  session_id        uuid NOT NULL,
  quantity          int NOT NULL CHECK (quantity > 0),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','converted','released','expired')),
  expires_at        timestamptz NOT NULL,
  registration_id   uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  UNIQUE (agency_id, id),
  FOREIGN KEY (agency_id, event_id) REFERENCES events(agency_id, id),
  FOREIGN KEY (agency_id, event_employee_id) REFERENCES event_employees(agency_id, id),
  FOREIGN KEY (agency_id, session_id) REFERENCES event_sessions(agency_id, id),
  FOREIGN KEY (agency_id, registration_id) REFERENCES registrations(agency_id, id)
);
CREATE UNIQUE INDEX seat_holds_one_active ON seat_holds (event_employee_id) WHERE status = 'active';
CREATE INDEX seat_holds_active_session_idx ON seat_holds (session_id, expires_at) INCLUDE (quantity) WHERE status = 'active';
CREATE INDEX seat_holds_sweep_idx ON seat_holds (expires_at) WHERE status = 'active';

CREATE TABLE seat_hold_items (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL,
  hold_id   uuid NOT NULL,
  quota_id  uuid NOT NULL,
  quantity  int NOT NULL CHECK (quantity > 0),
  UNIQUE (hold_id, quota_id),
  FOREIGN KEY (agency_id, hold_id) REFERENCES seat_holds(agency_id, id) ON DELETE CASCADE,
  FOREIGN KEY (agency_id, quota_id) REFERENCES option_session_quotas(agency_id, id)
);
CREATE INDEX seat_hold_items_quota_idx ON seat_hold_items (quota_id);

-- 倒數結束後仍保留已填內容，員工重新保留時不用重填；整份加密
CREATE TABLE registration_drafts (
  event_employee_id uuid PRIMARY KEY,
  agency_id         uuid NOT NULL,
  payload_encrypted bytea NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agency_id, event_employee_id) REFERENCES event_employees(agency_id, id) ON DELETE CASCADE
);

CREATE TABLE travelers (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id                  uuid NOT NULL,
  registration_id            uuid NOT NULL,
  traveler_type_id           uuid NOT NULL,
  is_employee_self           boolean NOT NULL DEFAULT false,
  name                       text NOT NULL,
  base_price_snapshot        int NOT NULL CHECK (base_price_snapshot >= 0),
  field_values               jsonb NOT NULL DEFAULT '{}',  -- 一般自訂欄位
  sensitive_values_encrypted bytea,                        -- 敏感自訂欄位
  sensitive_masks            jsonb NOT NULL DEFAULT '{}',  -- 遮罩後內容，顯示時不必解密
  requested_room_no          int,                          -- 員工在同一筆報名內的房間分配
  anonymized_at              timestamptz,
  sort_order                 int NOT NULL DEFAULT 0,
  UNIQUE (agency_id, id),
  FOREIGN KEY (agency_id, registration_id) REFERENCES registrations(agency_id, id) ON DELETE CASCADE,
  FOREIGN KEY (agency_id, traveler_type_id) REFERENCES traveler_types(agency_id, id)
);
CREATE INDEX travelers_registration_idx ON travelers (registration_id);
CREATE UNIQUE INDEX travelers_one_self ON travelers (registration_id) WHERE is_employee_self;

CREATE TABLE traveler_options (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id      uuid NOT NULL,
  traveler_id    uuid NOT NULL,
  option_id      uuid NOT NULL,
  price_snapshot int NOT NULL CHECK (price_snapshot >= 0),
  UNIQUE (traveler_id, option_id),
  FOREIGN KEY (agency_id, traveler_id) REFERENCES travelers(agency_id, id) ON DELETE CASCADE,
  FOREIGN KEY (agency_id, option_id) REFERENCES options(agency_id, id)
);
CREATE INDEX traveler_options_option_idx ON traveler_options (option_id);

-- ===== 分房 =====

CREATE TABLE room_preferences (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id               uuid NOT NULL,
  registration_id         uuid NOT NULL,
  requested_room_no       int NOT NULL,
  preferred_coworker_name text,   -- 跨員工同房意願，不會自動成立
  note                    text,
  UNIQUE (registration_id, requested_room_no),
  FOREIGN KEY (agency_id, registration_id) REFERENCES registrations(agency_id, id) ON DELETE CASCADE
);

CREATE TABLE rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   uuid NOT NULL,
  session_id  uuid NOT NULL,
  label       text NOT NULL,
  room_type_option_id uuid,
  capacity    int NOT NULL CHECK (capacity > 0),
  note        text,
  UNIQUE (agency_id, id),
  UNIQUE (session_id, label),
  FOREIGN KEY (agency_id, session_id) REFERENCES event_sessions(agency_id, id) ON DELETE CASCADE,
  FOREIGN KEY (agency_id, room_type_option_id) REFERENCES options(agency_id, id)
);

CREATE TABLE room_assignments (
  traveler_id uuid PRIMARY KEY,
  agency_id   uuid NOT NULL,
  room_id     uuid NOT NULL,
  assigned_by uuid,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agency_id, traveler_id) REFERENCES travelers(agency_id, id) ON DELETE CASCADE,
  FOREIGN KEY (agency_id, room_id) REFERENCES rooms(agency_id, id) ON DELETE CASCADE
);
CREATE INDEX room_assignments_room_idx ON room_assignments (room_id);

-- ===== 稽核與工作 =====

CREATE TABLE registration_revisions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id          uuid NOT NULL,
  registration_id    uuid NOT NULL,
  revision_no        int NOT NULL,
  actor_type         text NOT NULL CHECK (actor_type IN ('employee','agency_user','company_contact','platform_user','system')),
  actor_id           uuid,
  changed_fields     text[] NOT NULL DEFAULT '{}',
  before_encrypted   bytea,   -- 含個資，整份加密
  after_encrypted    bytea,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (registration_id, revision_no),
  FOREIGN KEY (agency_id, registration_id) REFERENCES registrations(agency_id, id) ON DELETE CASCADE
);

CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agency_id   uuid REFERENCES agencies(id),  -- 平台層級操作為 NULL
  actor_type  text NOT NULL CHECK (actor_type IN ('employee','agency_user','company_contact','platform_user','system')),
  actor_id    uuid,
  action      text NOT NULL,
  target_type text,
  target_id   uuid,
  metadata    jsonb NOT NULL DEFAULT '{}',
  ip_address  inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_agency_idx ON audit_logs (agency_id, created_at DESC);

CREATE TABLE email_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id    uuid NOT NULL REFERENCES agencies(id),
  template_key text NOT NULL,
  subject      text NOT NULL,
  body         text NOT NULL,
  sender_name  text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, template_key)
);

CREATE TABLE email_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id           uuid NOT NULL,
  event_id            uuid,
  event_employee_id   uuid,
  recipient_email     citext NOT NULL,
  template_key        text NOT NULL,
  idempotency_key     text NOT NULL UNIQUE,   -- 避免重試時重複寄送
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','bounced','failed')),
  provider_message_id text,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  FOREIGN KEY (agency_id, event_id) REFERENCES events(agency_id, id) ON DELETE SET NULL (event_id),
  FOREIGN KEY (agency_id, event_employee_id) REFERENCES event_employees(agency_id, id) ON DELETE SET NULL (event_employee_id)
);
CREATE INDEX email_messages_event_idx ON email_messages (agency_id, event_id, status);

CREATE TABLE import_jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id      uuid NOT NULL,
  event_id       uuid NOT NULL,
  source_object_key text NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','validating','awaiting_confirmation','importing','completed','failed')),
  total_rows     int,
  error_rows     jsonb,
  created_by_type text NOT NULL,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  FOREIGN KEY (agency_id, event_id) REFERENCES events(agency_id, id) ON DELETE CASCADE
);

CREATE TABLE export_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id  uuid NOT NULL REFERENCES agencies(id),
  name       text NOT NULL,
  columns    jsonb NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, id),
  UNIQUE (agency_id, name)
);

CREATE TABLE export_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id         uuid NOT NULL,
  event_id          uuid NOT NULL,
  template_id       uuid,
  columns           jsonb NOT NULL,
  contains_sensitive boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  result_object_key text,
  expires_at        timestamptz,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  FOREIGN KEY (agency_id, event_id) REFERENCES events(agency_id, id) ON DELETE CASCADE,
  FOREIGN KEY (agency_id, template_id) REFERENCES export_templates(agency_id, id) ON DELETE SET NULL (template_id)
);

-- ===== 列級安全 =====
-- 應用程式在每筆交易開始時執行：SELECT set_config('app.agency_id', '<旅行社 ID>', true);
-- 未設定時 current_setting 回傳 NULL，查不到任何資料。

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb USING (table_schema, table_name)
    WHERE c.table_schema = 'public' AND c.column_name = 'agency_id' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid)
      WITH CHECK (agency_id = NULLIF(current_setting('app.agency_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
