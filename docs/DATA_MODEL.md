# 大團系統 資料模型

> 狀態：第一版。需求來源為 [PRD](PRD.md)，架構見 [ARCHITECTURE](ARCHITECTURE.md)，完整欄位與限制定義在 [db/migrations](../db/migrations/)。

## 1. 資料表總覽

| 領域 | 資料表 | 內容 |
|---|---|---|
| 平台與額度 | `agencies`、`platform_users` | 旅行社租戶、平台人員 |
| | `pricing_tiers`、`agency_quota_ledger` | 收費級距；開通、扣除、退回額度的流水帳 |
| 旅行社與企業 | `agency_users`、`companies`、`company_contacts` | 旅行社人員（管理員、活動操作員、營運人員，含釘選的選單項目）、企業客戶（含前台顯示的名稱與 Logo）、企業窗口 |
| 活動設定 | `events`、`event_sessions`、`event_service_contacts` | 活動、梯次與名額（含梯次另外設定的每日行程）、活動的服務人員 |
| | `traveler_types` | 旅客類型、團費、備註與是否佔床 |
| | `session_room_types` | 各梯次的房型、可住人數、每人加價與可售床位 |
| | `option_groups`、`options`、`option_quotas`、`option_quota_sessions` | 選項群組（含舉辦日期）、選項、選項的名額組與名額組適用的梯次 |
| | `event_fields` | 自訂欄位定義 |
| 名單 | `event_employees` | 活動員工名單、補助金額、眷屬上限、登入密碼雜湊、LINE 綁定（識別碼雜湊與綁定時間） |
| 帳號 | `employee_password_links`、`employee_sessions`、`agency_user_sessions` | 設定密碼連結、員工與旅行社人員的登入狀態 |
| 報名 | `seat_holds`、`seat_hold_items` | 15 分鐘的名額保留與選項保留 |
| | `registration_drafts` | 倒數結束後保留的已填內容（加密） |
| | `registrations`、`travelers`、`traveler_options`、`traveler_option_preferences` | 報名、費用與付款狀態、旅客、每位旅客的選項、第二與第三志願（不佔名額） |
| 分房 | `room_preferences`、`rooms`、`room_assignments` | 員工填寫的意願、旅行社確認的最終分房 |
| 稽核與工作 | `registration_revisions`、`audit_logs` | 報名修改前後內容、查看與匯出個資等操作紀錄 |
| | `email_templates`、`email_messages` | 旅行社調整的範本、寄信狀態 |
| | `import_jobs`、`export_jobs`、`export_templates` | 匯入匯出進度、匯出範本 |

## 2. 主要關聯

```text
agencies
├─ agency_users
├─ agency_quota_ledger ── pricing_tiers
└─ companies
   ├─ company_contacts
   └─ events ── pricing_tiers
      ├─ event_sessions ──┐
      ├─ traveler_types   │
      ├─ event_fields     │
      ├─ option_groups ── options ── option_quotas（名額組）── option_quota_sessions（名額組 × 梯次）
      └─ event_employees
         ├─ seat_holds ── seat_hold_items
         ├─ registration_drafts（一人一份）
         └─ registrations（一人同時一筆有效）
            ├─ room_preferences
            ├─ registration_revisions
            └─ travelers ── traveler_options
               └─ room_assignments ── rooms（屬於梯次）
```

## 3. 設計規則

### 3.1 租戶隔離

- 除 `agencies`、`platform_users`、`pricing_tiers` 外，每張表都有 `agency_id` 並套用 RLS。
- 應用程式使用不可略過 RLS 的資料庫角色，每筆交易開始時設定 `app.agency_id`；未設定時查不到任何資料。
- 平台後台使用另一個可略過 RLS 的角色，只開放給平台功能。
- 跨表外鍵包含 `agency_id`，資料庫層就能防止引用其他旅行社的資料。
- 企業窗口只能存取自家企業：RLS 只隔離旅行社，企業層級由應用程式依 `company_id` 檢查。

### 3.2 費用與快照

- 報名時將團費存入 `travelers.base_price_snapshot`、房型與加價存入 `travelers`、選項價格存入 `traveler_options.price_snapshot`、補助額度存入 `registrations.subsidy_amount`。
- `registrations.self_pay_amount` 由資料庫計算：`GREATEST(total_amount - subsidy_amount, 0)`。
- 建立報名時，自付金額為 $0 的 `payment_status` 設為 `not_required`，其餘設為 `unpaid`。

### 3.3 自訂欄位與個資

- 一般欄位存於 `travelers.field_values`（JSONB）。
- 敏感欄位存於 `travelers.sensitive_values_encrypted`，遮罩後內容存於 `sensitive_masks`，一般顯示不需解密。
- `registration_drafts`、`registration_revisions` 含個資，整份加密。
- 到達保存期限時，由背景工作清除敏感欄位、匿名化旅客資料與員工名單，刪除草稿，並記錄於 `events.personal_data_purged_at`。

### 3.3.1 選項名額組

- 一個選項可以有多組名額（`option_quotas`），每組適用的梯次記在 `option_quota_sessions`；適用多個梯次就是共用名額。`(option_id, session_id)` 唯一，每個梯次最多屬於一組；沒有列在任何一組的梯次不限名額。
- 保留與已售都記在名額組上（`seat_hold_items.quota_id`、`option_quotas.sold_count`）；依梯次找名額時經由 `option_quota_sessions` 對應。鎖定順序不變：先梯次，再依 ID 排序的名額組。
- 旅行社調整名額組時整份覆蓋：依各梯次實際已選（未取消的報名）與保留中的人數重新計算每組已售人數，盡量沿用原本的名額組，保留中的名額改指到梯次目前所屬的組。
- 刪除梯次時從名額組移除；沒有任何梯次的名額組一併刪除。
- `event_sessions.itinerary_days` 為 NULL 時沿用活動的每日行程；`option_groups.activity_date` 是群組的舉辦日期，前台依梯次去程日期換算第幾天。

### 3.4 員工帳號與登入

- `events.theme_color` 必填，建立活動時預設為系統預設色；複製活動時帶入原活動的主色。
- 刪除未發布的活動時，保留資料列並標記為 `archived`、釋出活動代碼，額度寫入 `event_deleted` 退回。
- 帳號為 `event_employees.employee_no`，屬於活動名單，不跨活動共用；`password_hash` 為 NULL 表示尚未設定密碼。
- `employee_password_links` 只存雜湊。每位員工同時只有一個可用連結，由唯一索引保證；重新產生時先撤銷舊連結。
- 使用連結時以同一筆更新確認並標記 `used_at`，同時送出也只會成功一次；設定完成後撤銷該員工所有登入狀態。
- 產生連結與設定密碼都寫入 `audit_logs`，記錄產生人與時間。
- `employee_sessions` 只存雜湊，登出或重設密碼時撤銷，12 小時後過期。
- LINE 登入：`agencies.line_channel_id` 與 `line_liff_id` 一起設定或一起清空；`events.line_enabled` 是活動的 LINE 入口開關。
- `event_employees.line_user_hash` 是 `line:Channel ID:LINE 帳號識別碼` 的 HMAC 雜湊，不存識別碼本身；`(event_id, line_user_hash)` 唯一，保證同一活動中一個 LINE 帳號只綁一位員工。移出名單、重新加入、換 Channel ID 時清除。
- LINE 登入與密碼登入建立同一種 `employee_sessions`；綁定與解除寫入 `audit_logs`（`employee.line_bound`、`employee.line_unbound`）。

### 3.5 活動頁開關

- `events.page_mode` 為 `manual` 時只看 `page_is_open`，為 `scheduled` 時只看 `page_opens_at`、`page_closes_at`。
- 活動頁開關與 `registration_opens_at`、`registration_closes_at` 分開：前者決定能否登入與存取，後者決定能否報名。

### 3.6 額度

- 額度餘額 = 該旅行社、該級距在 `agency_quota_ledger` 的 `change` 總和。
- 建立活動時扣一場；未開放報名就刪除時退回；升級級距時退回舊級距並扣新級距。
- 梯次總名額不得超過所購級距上限，由應用程式在儲存梯次時檢查。

## 4. 名額流程

名額判斷都在資料庫交易內進行。可用名額 = `capacity - sold_count - 未逾時保留總和`。

### 4.1 保留名額

1. 設定 `app.agency_id`。
2. 以 `FOR UPDATE` 鎖定梯次，再依 ID 排序鎖定相關的選項名額，避免死結。
3. 將此員工已逾時的保留標記為 `expired`；若仍有有效保留，先處理該保留，不新增第二份。
4. 檢查梯次與每個選項的可用名額，不足就回滾並回傳額滿原因。
5. 新增 `seat_holds` 與 `seat_hold_items`，到期時間為 15 分鐘後。

### 4.2 送出報名

1. 以相同順序鎖定梯次與選項名額。
2. 確認保留仍有效，否則拒絕送出。
3. 建立報名與旅客資料，增加梯次與選項的 `sold_count`。
4. 將保留標記為 `converted`，刪除草稿。

### 4.3 其他情況

- 頁面狀態：`sold_count >= capacity` 顯示「已額滿」；已售加保留達到容量但未售完時，顯示「名額保留中，可稍後再試」。
- 倒數結束：查詢時已自動排除；背景工作定期將狀態改為 `expired`。
- 取消生效：減少 `sold_count`，釋出名額。
- 活動人數使用量：有效報名的旅客數加未逾時保留數，用於收費級距的提醒與上限。

## 5. 驗證紀錄

已在 PostgreSQL 16 上套用資料表定義 並實測：

- RLS：未設定旅行社時查不到資料；無法讀取、寫入或修改其他旅行社的資料；外鍵會擋下跨旅行社引用。
- 併發：100 人搶 10 個名額只成功 10 位；多人一筆與多個選項同時搶也不超賣，且沒有死結。
- 保留：同一員工只有一份有效保留；逾時保留未清理也不佔名額，且不能再轉成報名。
- 報名：轉成報名後名額只算一次；自付金額計算正確；一人一筆有效報名，取消後可重新報名。

送出報名與取消時的選項名額增減，已由 `apps/api/test` 的整合測試涵蓋。本機測得單一梯次約每秒 273 次保留（50 條連線、無網路延遲），只能作為參考，正式驗收仍以壓力測試為準。
