#!/bin/sh
# 在主機上執行：第一次部署時用隨機值產生 /opt/bigtours/.env，之後只檢查必填項目。
# 寄信設定（SMTP_URL、MAIL_FROM）沒有預設值，要自己填；沒填前不會啟動服務。
set -eu
ENV_FILE=/opt/bigtours/.env

rand_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

if [ ! -f "$ENV_FILE" ]; then
  umask 077
  cat > "$ENV_FILE" <<EOF
# 大團報名正式環境設定。資料庫密碼與金鑰在第一次部署時隨機產生。
# 不要更換 DATA_ENCRYPTION_KEY 與 TOKEN_HASH_KEY：已加密的個資會解不開，已發出的登入狀態與連結也會失效。
PLATFORM_DOMAIN=bigtour.bookdex.cc
POSTGRES_PASSWORD=$(rand_hex 24)
DB_APP_PASSWORD=$(rand_hex 24)
DATA_ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64)
TOKEN_HASH_KEY=$(rand_hex 32)

# 寄信（必填）：Amazon SES 的 SMTP 端點（見 deploy/lightsail/README.md「寄信」）
# 密碼中的 / + = 要寫成 %2F %2B %3D
# SMTP_URL=smtps://<SMTP 使用者>:<SMTP 密碼>@email-smtp.ap-southeast-2.amazonaws.com:465
# MAIL_FROM=no-reply@bookdex.cc（只填地址；寄件者名稱由每封信決定）
SMTP_URL=
MAIL_FROM=

# 官網（選填）
TRIAL_NOTIFY_EMAIL=
SITE_LINE_URL=
# Google Tag Manager 容器 ID（只載入於官網與試玩頁）
SITE_GTM_ID=
DEMO_ENABLED=true
# 試用到期提醒與到期後刪除
TRIAL_JOBS_ENABLED=true

# 對外連接埠：443 已由預約簿使用，Cloudflare Origin Rule 轉到這裡
HTTPS_PORT=8443

# 部署時自動更新
APP_IMAGE=
EOF
  echo "已產生 $ENV_FILE"
fi

missing=""
for key in SMTP_URL MAIL_FROM PLATFORM_DOMAIN POSTGRES_PASSWORD DB_APP_PASSWORD DATA_ENCRYPTION_KEY TOKEN_HASH_KEY; do
  value=$(grep -E "^$key=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-)
  [ -n "$value" ] || missing="$missing $key"
done
if [ -n "$missing" ]; then
  echo "請先在主機的 $ENV_FILE 填寫：$missing" >&2
  exit 1
fi
