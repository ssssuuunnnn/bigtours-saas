# 部署：AWS Lightsail ＋ Cloudflare

大團報名與 Bookdex 預約簿部署在**同一台 Lightsail 主機**（`gym-system`，ap-southeast-2），各自一組 docker compose，互不影響。

```
使用者 ─HTTPS─► Cloudflare Proxy
                  │  bigtour.bookdex.cc         ── Origin Rule：改連 8443
                  │  其他 *.bookdex.cc（預約簿） ── 443
                  ▼
        Lightsail gym-system
        ├─ /opt/gym-system  預約簿：nginx :443
        └─ /opt/bigtours    大團報名：nginx :8443 ─ web（Next.js）─ api（NestJS）─ postgres
```

| 項目 | 設定 |
|---|---|
| 網址 | 全部在 `bigtour.bookdex.cc`：官網 `/`、試玩 `/try`、平台後台 `/platform`、旅行社 `/<代號>/admin`、員工報名 `/<代號>/<活動>` |
| 主機目錄 | `/opt/bigtours`：只有 `docker-compose.prod.yml`、`deploy/lightsail/`、`.env`；程式在映像檔裡 |
| 映像檔 | GitHub Actions 建置後推到 GHCR（`ghcr.io/ssssuuunnnn/bigtours-saas:<commit>`），主機只下載，不在主機上編譯 |
| 對外連接埠 | 8443，只開放 Cloudflare 的 IP |
| 資料 | 具名 volume `bigtours_postgres-data`（資料庫）、`bigtours_storage-data`（上傳的條款、圖片）；Lightsail 每日快照一起備份 |

## 檔案

- `Dockerfile`（repo 根目錄）：正式映像檔，API、前端、資料庫遷移共用。
- `docker-compose.prod.yml`（repo 根目錄）：postgres、migrate（每次部署先跑）、api、web、nginx。密碼與金鑰都從主機的 `.env` 讀取。
- `nginx.conf`：Origin 憑證、Cloudflare 真實 IP、`/api/` 轉給 API，其他轉給前端。
- `init-env.sh`：第一次部署時用隨機值產生 `.env`；寄信設定沒填就停止。
- `deploy.sh`：上傳設定檔 → 檢查 `.env` → 下載映像檔 → 遷移資料庫並重新啟動（`--wait` 等到全部健康）。
- `firewall.sh`：在 Lightsail 防火牆的 22 埠加入或移除一個 IP，只動那一個 IP。
- `.github/workflows/ci.yml`、`deploy.yml`：CI 與自動部署。

## 一次性設定

### 用 setup.sh 一次設定（建議）

`deploy/lightsail/setup.sh` 把下面 1～4 的一次性設定與第一次部署寫成腳本，在本機 Mac 執行。每一步先查現況、已完成就跳過，可以重複執行；密碼與金鑰只寫進本機檔案，不會印在畫面上。用 Claude Code 時說「部署」或輸入 `/deploy`，會照 `.claude/skills/deploy/SKILL.md` 一步步執行。

```bash
deploy/lightsail/setup.sh check        # 檢查工具、登入狀態與權杖（不改任何東西）
deploy/lightsail/setup.sh ses smtp     # SES 驗證 bookdex.cc、DKIM／DMARC、申請 production access、SMTP 帳密
deploy/lightsail/setup.sh cloudflare   # DNS、Origin Rule（→ 8443）、Origin 憑證
deploy/lightsail/setup.sh firewall     # Lightsail 8443 只開放給 Cloudflare
deploy/lightsail/setup.sh host         # 上傳 Origin 憑證、在主機產生並填好 .env、備份到本機
deploy/lightsail/setup.sh github       # 部署用 SSH 金鑰與 IAM 使用者、GitHub production Secrets
deploy/lightsail/setup.sh deploy       # 執行 Actions 的 Deploy 並等到完成
PLATFORM_ADMIN_EMAIL=<email> deploy/lightsail/setup.sh platform-user
deploy/lightsail/setup.sh status
```

需要：`aws`（已登入，可建立 IAM 使用者、操作 SES 與 Lightsail）、`gh`（已登入）、`jq`、`curl`、`ssh`、`openssl`、`node`，以及主機 SSH 金鑰 `~/.ssh/gym-lightsail.pem`。

**Cloudflare 權杖**：我的設定檔 → API 權杖 → 建立自訂權杖，區域資源限定 `bookdex.cc`，權限為「區域 → 區域 → 讀取」「區域 → DNS → 編輯」「區域 → SSL 和憑證 → 編輯」「區域 → Origin Rules → 編輯」（選填「區域 → 區域設定 → 讀取」，用來檢查 SSL 模式）。複製權杖後執行：

```bash
mkdir -p ~/.bigtours-deploy && chmod 700 ~/.bigtours-deploy
pbpaste > ~/.bigtours-deploy/cloudflare-token && chmod 600 ~/.bigtours-deploy/cloudflare-token
```

本機產生的檔案：

| 檔案 | 內容 |
|---|---|
| `~/.bigtours-deploy/ses-smtp-url` | 主機 `.env` 的 `SMTP_URL` |
| `~/.bigtours-deploy/deploy-aws-key.json` | GitHub 部署用 IAM 使用者的金鑰 |
| `~/.bigtours-deploy/host.env` | 主機 `.env` 的備份（含加密金鑰，請另存密碼管理器） |
| `~/.bigtours-deploy/platform-user.txt` | 第一個平台人員帳密 |
| `deploy/lightsail/certs/origin.pem`、`origin.key` | Origin 憑證（不進 git） |
| `~/.ssh/bigtours-github-deploy` | GitHub Actions 用的 SSH 金鑰 |

預設值（寄件地址、通知信箱、LINE 網址、主機名稱等）都可以用環境變數覆寫，見 `setup.sh` 開頭。腳本只做 1～4 的設定；預約簿的 `RESERVED_SUBDOMAINS` 要另外到 gym_system 修改。

以下是各步驟的手動做法，也就是腳本做的事。

### 1. Cloudflare

1. **DNS**：不用新增。`bigtour.bookdex.cc` 已由預約簿現有的 `*` 紀錄（已代理）接住。若想在 DNS 頁面一目了然，也可以另外新增 `A` 紀錄 `bigtour` 指向同一個固定 IP、已代理。
2. **邊緣憑證**：不用處理。`bigtour.bookdex.cc` 是第一層子網域，Cloudflare 免費的 Universal SSL（`*.bookdex.cc`）已涵蓋。
3. **Origin Rule**：Rules → Origin Rules → 建立規則
   - 條件：自訂運算式 `(http.host eq "bigtour.bookdex.cc")`
   - 目的地連接埠：改寫為 `8443`
4. **Origin 憑證**：SSL/TLS → 原始伺服器 → 建立憑證，主機名稱填 `bigtour.bookdex.cc`，有效期 15 年。（預約簿現有的 `*.bookdex.cc` Origin 憑證其實也涵蓋，但另建一張，兩個產品要撤銷時互不影響。）存成本機的 `deploy/lightsail/certs/origin.pem`（原始憑證）與 `origin.key`（私密金鑰）；此目錄不進 git，`deploy.sh` 會上傳。

SSL/TLS 加密模式沿用預約簿的 Full (strict)。

5. **預約簿保留 `bigtour`**：在 gym_system 的 `RESERVED_SUBDOMAINS` 加上 `bigtour`，避免有店家申請到這個子網域（Origin Rule 會先把流量轉走，店家會開不了自己的網址）。

### 1-1. 寄信：Amazon SES（ap-southeast-2）

寄件地址用 `no-reply@bookdex.cc`，所以驗證根網域 `bookdex.cc`（與預約簿共用寄信信譽；之後要分開，再驗證 `bigtour.bookdex.cc` 並改 `MAIL_FROM`）。

1. SES → Identities → Create identity → Domain：`bookdex.cc`（已存在就沿用），Easy DKIM、RSA 2048。把產生的 3 筆 CNAME 加到 Cloudflare，**設為「僅 DNS」（灰色雲）**。
2. Cloudflare 的 `_dmarc`（`bookdex.cc`）若還沒有 DMARC，新增 TXT：`v=DMARC1; p=none; rua=mailto:service@bookdex.cc`。一個網域只能有一筆 DMARC，已有就沿用。
3. Account dashboard → Request production access（用途 Transactional：報名確認、密碼設定連結等系統通知）。核准前只能寄給已驗證的信箱。
4. SMTP settings → Create SMTP credentials，記下使用者與密碼（只顯示一次）。
5. 填進主機 `.env`：`SMTP_URL=smtps://<使用者>:<密碼>@email-smtp.ap-southeast-2.amazonaws.com:465`（密碼中的 `/`、`+`、`=` 寫成 `%2F`、`%2B`、`%3D`）、`MAIL_FROM=no-reply@bookdex.cc`；另外填 `TRIAL_NOTIFY_EMAIL=service@bookdex.cc`、`SITE_LINE_URL=https://line.me/R/ti/p/@184nyral`。

試用旅行社的寄信數量有上限（總共 100 封、每天 40 封），避免自助試用被拿來大量寄信、影響 SES 的寄信信譽。

### 2. Lightsail 防火牆：開放 8443 給 Cloudflare

在 Lightsail 主控台 → 主機 → 網路 → IPv4 防火牆，新增規則「自訂 TCP 8443」，來源限定為 [Cloudflare IP](https://www.cloudflare.com/ips-v4)（與預約簿 443 規則的來源相同）。

### 3. 第一次部署（從本機）

```bash
# 映像檔要先由 GitHub Actions 建好（Actions → Deploy → Run workflow 會建置並部署）；
# 或在本機建置推上 GHCR 後指定：
export APP_IMAGE=ghcr.io/ssssuuunnnn/bigtours-saas:<commit>
export GHCR_USER=<GitHub 帳號> GHCR_TOKEN=<有 read:packages 權限的 token>
deploy/lightsail/deploy.sh ubuntu@<固定 IP>
```

第一次執行會在主機產生 `/opt/bigtours/.env` 並停下來，請登入主機填好寄信設定再執行一次：

```bash
ssh -i ~/.ssh/gym-lightsail.pem ubuntu@<固定 IP>
nano /opt/bigtours/.env   # 填 SMTP_URL、MAIL_FROM，以及選填的 TRIAL_NOTIFY_EMAIL、SITE_LINE_URL
```

部署完成後建立第一個平台人員帳號（密碼只顯示一次）：

```bash
cd /opt/bigtours
docker compose -f docker-compose.prod.yml --env-file .env run --rm migrate node_modules/.bin/tsx db/create-platform-user.ts <email> <姓名>
```

**不要更換 `.env` 的 `DATA_ENCRYPTION_KEY` 與 `TOKEN_HASH_KEY`**：已加密的旅客個資會解不開，已發出的登入狀態與連結也會全部失效。請另外備份 `.env`。

### 4. 自動部署（GitHub Actions）

main 的 CI 通過後，`deploy.yml` 會建置映像檔推到 GHCR、暫時把 runner 的 IP 加到 22 埠、執行 `deploy.sh`、移除那個 IP，最後確認 `https://bigtour.bookdex.cc/api/v1/health` 有回應。主機用該次工作的 `GITHUB_TOKEN` 下載私有映像檔，部署完立即登出，不在主機上留下長期權杖。

**部署專用的 SSH 金鑰**（和預約簿分開，要停用時刪這把就好）：

```bash
ssh-keygen -t ed25519 -N "" -C bigtours-github-deploy -f ~/.ssh/bigtours-github-deploy
cat ~/.ssh/bigtours-github-deploy.pub | ssh -i ~/.ssh/gym-lightsail.pem ubuntu@<固定 IP> 'cat >> ~/.ssh/authorized_keys'
ssh-keyscan -t ed25519 <固定 IP>   # 給 DEPLOY_KNOWN_HOSTS
```

**AWS**：IAM 使用者只需要改這台主機防火牆的權限，做法與預約簿 `deploy/lightsail/README.md` 的步驟 2 相同（政策 `lightsail:GetInstancePortStates`、`lightsail:PutInstancePublicPorts`）。建議另建 `bigtours-github-deploy` 使用者，兩個產品的金鑰可以分開停用。

**GitHub**：Settings → Environments → 新增 `production`：

| 種類 | 名稱 | 值 |
|---|---|---|
| Secret | `DEPLOY_HOST` | `ubuntu@<固定 IP>` |
| Secret | `DEPLOY_SSH_KEY` | `~/.ssh/bigtours-github-deploy` 的完整內容 |
| Secret | `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan` 印出的那一行 |
| Secret | `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY` | IAM 使用者的金鑰 |

選用的 Variable：`PLATFORM_DOMAIN`（預設 `bigtour.bookdex.cc`，只用於部署後的健康檢查網址；正式環境的網域以主機 `.env` 為準）、`LIGHTSAIL_INSTANCE`（預設 `gym-system`）、`AWS_REGION`（預設 `ap-southeast-2`）、`HEALTHCHECK_URL`。想要部署前先人工核准，在 `production` 環境勾 Required reviewers。

## 維運

```bash
cd /opt/bigtours
C="docker compose -f docker-compose.prod.yml --env-file .env"
$C ps
$C logs -f api
$C exec -T postgres pg_dump -U postgres -Fc bigtours > backup-$(date +%F).dump   # 手動備份
```

- 修改 `.env` 後：`$C up -d`。
- 回到上一版：Actions → Deploy 重新執行舊的那次，或在主機把 `.env` 的 `APP_IMAGE` 改回舊的 commit 後 `$C up -d`（資料庫遷移只會往前，不會倒回）。

## 已知限制與注意

- **記憶體**：主機只有 2 GB，現在跑兩組服務。映像檔在 GitHub 建置，主機不用編譯；若開放報名尖峰時記憶體不足，建議升級到 4 GB 方案。
- 單機、單一可用區，主機故障時從每日快照還原，最多遺失約一天的資料。
- 兩個產品的部署可能同時修改 22 埠的防火牆；`firewall.sh` 只增減自己的 IP，但讀取與寫入之間仍有幾秒的空窗，極少數情況可能需要重新執行部署。
