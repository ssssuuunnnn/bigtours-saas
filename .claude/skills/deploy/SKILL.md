---
name: deploy
description: 大團報名第一次上線到 Lightsail（SES、Cloudflare、防火牆、主機 .env、GitHub Secrets、第一次部署、平台帳號），或檢查正式環境的上線設定狀態。使用者說「部署」「上線」「setup」「/deploy」時使用。
---

# 大團報名：上線部署

一次性設定與第一次部署都由 `deploy/lightsail/setup.sh` 完成。每一步先查現況、已完成就跳過，可以重複執行。之後的日常部署是 main 合併後 GitHub Actions 自動進行，不需要這個技能。

細節見 `deploy/lightsail/README.md`「用 setup.sh 一次設定」。

## 規則

- **不要讀取或印出任何密碼、金鑰**：不要 `cat`、`Read`、`grep` 這些檔案：`~/.bigtours-deploy/` 底下所有檔案、`deploy/lightsail/certs/origin.key`、`~/.ssh/` 的私密金鑰、主機的 `/opt/bigtours/.env`。腳本本身不會印出它們；只需要回報「已存在」或路徑。
- 不要更換主機 `.env` 的 `DATA_ENCRYPTION_KEY`、`TOKEN_HASH_KEY`，也不要刪除 `/opt/bigtours` 或 docker volume。
- 不要自己建立 Cloudflare 權杖或貼權杖到對話；請使用者自己建立並存檔（見下方）。
- 每執行一個步驟就停下來，用一兩句話跟使用者說結果，再繼續下一步。遇到 `✗` 先說明原因與建議，不要自己改腳本繞過；`!` 是提醒，說給使用者聽。
- 要送出 SES production access 申請（`ses` 步驟）前，先跟使用者確認一次。

## 流程

1. **檢查**：`deploy/lightsail/setup.sh check`
   - 缺工具：請使用者 `brew install <工具>`。
   - aws、gh 沒登入：請使用者自己執行 `aws configure`（或 `aws sso login`）、`gh auth login`。
   - 缺 Cloudflare 權杖：請使用者到 Cloudflare → 我的設定檔 → API 權杖 → 建立自訂權杖，區域資源限定 `bookdex.cc`，權限：
     - 區域 → 區域 → 讀取
     - 區域 → DNS → 編輯
     - 區域 → SSL 和憑證 → 編輯
     - 區域 → Origin Rules → 編輯
     - 區域 → 區域設定 → 讀取（選填，用來檢查 SSL 模式）

     然後請使用者自己在終端機執行（權杖不要貼到對話）：
     ```bash
     mkdir -p ~/.bigtours-deploy && chmod 700 ~/.bigtours-deploy
     pbpaste > ~/.bigtours-deploy/cloudflare-token && chmod 600 ~/.bigtours-deploy/cloudflare-token
     ```
2. **寄信**：`setup.sh ses`，再 `setup.sh smtp`。production access 審核約一天，不用等，繼續下一步。
3. **Cloudflare 與防火牆**：`setup.sh cloudflare`，再 `setup.sh firewall`。
4. **主機**：`setup.sh host`（會暫時開放本機 IP 的 SSH，結束自動移除）。
5. **GitHub**：`setup.sh github`。
6. **部署**：`setup.sh deploy`（建置映像檔約 5～10 分鐘，用背景執行並等它完成）。
7. **退信與客訴通知**：`setup.sh ses-feedback`（SES 網域要先驗證通過；主機服務會短暫重啟）。
8. **平台帳號**：問使用者要用哪個 Email，執行 `PLATFORM_ADMIN_EMAIL=<email> PLATFORM_ADMIN_NAME=<姓名> deploy/lightsail/setup.sh platform-user`。帳密存在 `~/.bigtours-deploy/platform-user.txt`，請使用者自己開啟，不要讀出來。
9. **收尾**：`setup.sh status`，然後提醒使用者還沒做的：
   - SES production access 核准前，只能寄給 SES 已驗證的信箱；核准前不要對外開放試用申請。
   - 把 `~/.bigtours-deploy/host.env` 存到密碼管理器。
   - 預約簿（gym_system repo）的 `RESERVED_SUBDOMAINS` 加上 `bigtour`。
   - 打開 https://bigtour.bookdex.cc 、`/try`、`/platform` 實際看一次。

## 預設值

寄件 `no-reply@bookdex.cc`（SES 驗證 `bookdex.cc`）、試用通知與 DMARC 報告 `service@bookdex.cc`、LINE `https://line.me/R/ti/p/@184nyral`、主機 `gym-system`（ap-southeast-2）。要改用環境變數覆寫，名稱見 `setup.sh` 開頭。
