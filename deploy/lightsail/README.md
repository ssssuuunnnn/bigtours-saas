# 部署：AWS Lightsail ＋ Cloudflare

大團報名與 Bookdex 預約簿部署在**同一台 Lightsail 主機**（`gym-system`，ap-southeast-2），各自一組 docker compose，互不影響。

```
使用者 ─HTTPS─► Cloudflare Proxy
                  │  tours.bookdex.cc、*.tours.bookdex.cc ── Origin Rule：改連 8443
                  │  其他 *.bookdex.cc（預約簿）           ── 443
                  ▼
        Lightsail gym-system
        ├─ /opt/gym-system  預約簿：nginx :443
        └─ /opt/bigtours    大團報名：nginx :8443 ─ web（Next.js）─ api（NestJS）─ postgres
```

| 項目 | 設定 |
|---|---|
| 網址 | 官網 `tours.bookdex.cc`、旅行社 `<代號>.tours.bookdex.cc`、試玩 `demo.tours.bookdex.cc`、平台後台 `platform.tours.bookdex.cc` |
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

### 1. Cloudflare

1. **DNS**：新增 `A` 紀錄，名稱 `*.tours`，內容＝主機固定 IP，已代理（橘色雲）。`tours.bookdex.cc` 本身已由現有的 `*` 紀錄接住。
2. **邊緣憑證**：Cloudflare 免費的 Universal SSL 只涵蓋 `bookdex.cc` 與 `*.bookdex.cc`，**不涵蓋 `*.tours.bookdex.cc`**。要另外處理，見文末「待決定」。
3. **Origin Rule**：Rules → Origin Rules → 建立規則
   - 條件：自訂運算式 `(http.host eq "tours.bookdex.cc") or ends_with(http.host, ".tours.bookdex.cc")`
   - 目的地連接埠：改寫為 `8443`
4. **Origin 憑證**：SSL/TLS → 原始伺服器 → 建立憑證，主機名稱填 `tours.bookdex.cc` 與 `*.tours.bookdex.cc`，有效期 15 年。存成本機的 `deploy/lightsail/certs/origin.pem`（原始憑證）與 `origin.key`（私密金鑰）；此目錄不進 git，`deploy.sh` 會上傳。

SSL/TLS 加密模式沿用預約簿的 Full (strict)。

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

main 的 CI 通過後，`deploy.yml` 會建置映像檔推到 GHCR、暫時把 runner 的 IP 加到 22 埠、執行 `deploy.sh`、移除那個 IP，最後確認 `https://tours.bookdex.cc/api/v1/health` 有回應。主機用該次工作的 `GITHUB_TOKEN` 下載私有映像檔，部署完立即登出，不在主機上留下長期權杖。

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

選用的 Variable：`PLATFORM_DOMAIN`（預設 `tours.bookdex.cc`）、`LIGHTSAIL_INSTANCE`（預設 `gym-system`）、`AWS_REGION`（預設 `ap-southeast-2`）、`HEALTHCHECK_URL`。想要部署前先人工核准，在 `production` 環境勾 Required reviewers。

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

## 待決定：`*.tours.bookdex.cc` 的邊緣憑證

Cloudflare 免費憑證不涵蓋第二層子網域，旅行社網址、`demo.`、`platform.` 在瀏覽器會出現憑證錯誤（`tours.bookdex.cc` 本身沒問題）。可選：

1. **Advanced Certificate Manager**：在 Cloudflare 購買後開啟 Total TLS，所有代理中的子網域自動有憑證，最省事（月費以 Cloudflare 頁面為準）。
2. **改用獨立網域**：例如另買一個網域給大團報名，旅行社網址變成 `<代號>.新網域`，免費憑證即可涵蓋；程式只要改 `PLATFORM_DOMAIN`。
