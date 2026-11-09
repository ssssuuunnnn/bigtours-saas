#!/usr/bin/env bash
# 一次性上線設定＋第一次部署（在本機 Mac 執行，見 deploy/lightsail/README.md「用 setup.sh 一次設定」）。
#
# 用法：deploy/lightsail/setup.sh <步驟>...
#   check          檢查本機工具、AWS、GitHub、Cloudflare 權杖與主機（不會改任何東西）
#   ses            SES 驗證寄件網域（DKIM CNAME、DMARC 加到 Cloudflare）、申請 production access
#   smtp           建立寄信用的 IAM 使用者，換算成 SMTP_URL 存在本機
#   cloudflare     確認 DNS、建立 Origin Rule（→ 8443）、產生 Origin 憑證
#   firewall       Lightsail 防火牆開放 8443，來源限 Cloudflare IP
#   host           上傳 Origin 憑證，在主機產生並填好 /opt/bigtours/.env，備份到本機
#   github         部署用 SSH 金鑰與 IAM 使用者，設定 GitHub production 環境的 Secrets
#   deploy         執行 GitHub Actions 的 Deploy 並等到完成，確認網站有回應
#   ses-feedback   SES 退信與客訴通知：建立 SNS Topic、更新主機 .env、訂閱通知端點（要先部署含此功能的版本）
#   platform-user  建立第一個平台人員帳號（需要 PLATFORM_ADMIN_EMAIL）
#   status         顯示目前各項的狀態
#   all            依序執行 check ses smtp cloudflare firewall host github deploy ses-feedback（有設 PLATFORM_ADMIN_EMAIL 時再加 platform-user）
#
# 每一步都會先查現況，已完成就跳過，可以重複執行。
# 密碼、金鑰只寫進本機檔案（權限 600），不會印在畫面上：
#   ~/.bigtours-deploy/          SMTP_URL、部署用 AWS 金鑰、主機 .env 備份、平台帳號密碼
#   deploy/lightsail/certs/      Origin 憑證（不進 git）
#   ~/.ssh/bigtours-github-deploy  GitHub Actions 用的 SSH 金鑰
#
# 需要：aws（已登入、有 IAM／SES／Lightsail 權限）、gh（已登入）、jq、curl、ssh、openssl、node，
# 以及 Cloudflare API 權杖：環境變數 CF_API_TOKEN，或存成 ~/.bigtours-deploy/cloudflare-token。
set -euo pipefail
cd "$(dirname "$0")/../.."

# ---- 設定（都可以用環境變數覆寫） ----
REGION=${AWS_REGION:-ap-southeast-2}
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER=""
INSTANCE=${LIGHTSAIL_INSTANCE:-gym-system}
export LIGHTSAIL_INSTANCE=$INSTANCE
CF_ZONE=${CF_ZONE:-bookdex.cc}
DOMAIN=${PLATFORM_DOMAIN:-bigtour.bookdex.cc}
MAIL_FROM=${MAIL_FROM:-no-reply@bookdex.cc}
MAIL_DOMAIN=${MAIL_FROM#*@}
TRIAL_NOTIFY_EMAIL=${TRIAL_NOTIFY_EMAIL:-service@bookdex.cc}
DMARC_RUA=${DMARC_RUA:-service@bookdex.cc}
SITE_LINE_URL=${SITE_LINE_URL:-https://line.me/R/ti/p/@184nyral}
REPO=${GITHUB_REPO:-ssssuuunnnn/bigtours-saas}
ADMIN_KEY=${BIGTOURS_ADMIN_KEY:-$HOME/.ssh/gym-lightsail.pem}
DEPLOY_KEY=${BIGTOURS_GITHUB_DEPLOY_KEY:-$HOME/.ssh/bigtours-github-deploy}
SECRETS=${BIGTOURS_SECRETS_DIR:-$HOME/.bigtours-deploy}
SMTP_IAM_USER=${SMTP_IAM_USER:-bigtours-ses-smtp}
DEPLOY_IAM_USER=${DEPLOY_IAM_USER:-bigtours-github-deploy}
SES_TOPIC_NAME=${SES_TOPIC_NAME:-bigtours-ses-feedback}
PLATFORM_ADMIN_EMAIL=${PLATFORM_ADMIN_EMAIL:-}
PLATFORM_ADMIN_NAME=${PLATFORM_ADMIN_NAME:-平台管理員}
HOST_DIR=/opt/bigtours
CERTS=deploy/lightsail/certs

SES_USE_CASE="Bookdex Group Tour Registration (https://$DOMAIN) is a B2B SaaS for travel agencies to run employee group-tour sign-ups for their corporate clients. We send only transactional email: account activation and password-setup links, registration confirmations and changes, room-assignment notices, and trial-account notices. Recipients are employees on lists provided by the travel agency or corporate client, plus agency staff; there is no marketing email and no purchased list. Expected volume is under 5,000 emails per day at peak. Send-time rejections are shown in the app so staff can fix addresses, and we will process SES bounce and complaint notifications. Self-service trial accounts are capped at 100 emails in total and 40 per day."

# ---- 共用 ----
say()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die()  { printf '  ✗ %s\n' "$*" >&2; exit 1; }

TMPDIR_SETUP=$(mktemp -d)
SSH_OPENED_CIDR=""
cleanup() {
  if [ -n "$SSH_OPENED_CIDR" ]; then
    sh deploy/lightsail/firewall.sh remove "$SSH_OPENED_CIDR" >/dev/null 2>&1 \
      && printf '  · 已移除這次開放的 SSH 來源 %s\n' "$SSH_OPENED_CIDR" \
      || printf '  ! 無法移除 SSH 來源 %s，請執行：sh deploy/lightsail/firewall.sh remove %s\n' "$SSH_OPENED_CIDR" "$SSH_OPENED_CIDR" >&2
  fi
  rm -rf "$TMPDIR_SETUP"
}
trap cleanup EXIT

secret_dir() { umask 077; mkdir -p "$SECRETS"; chmod 700 "$SECRETS"; }

INSTANCE_IP=""
instance_ip() {
  if [ -z "$INSTANCE_IP" ]; then
    INSTANCE_IP=$(aws lightsail get-instance --instance-name "$INSTANCE" --query 'instance.publicIpAddress' --output text) \
      || die "找不到 Lightsail 主機 $INSTANCE（區域 $REGION）"
  fi
  printf '%s' "$INSTANCE_IP"
}

ACCOUNT_ID=""
account_id() {
  [ -n "$ACCOUNT_ID" ] || ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  printf '%s' "$ACCOUNT_ID"
}

# ---- Cloudflare API（權杖放在暫存的 header 檔，不出現在指令列） ----
CF_HDR=""
CF_ZONE_ID=""
cf_init() {
  [ -n "$CF_HDR" ] && return 0
  local token=${CF_API_TOKEN:-}
  if [ -z "$token" ] && [ -f "$SECRETS/cloudflare-token" ]; then token=$(tr -d '[:space:]' < "$SECRETS/cloudflare-token"); fi
  [ -n "$token" ] || die "需要 Cloudflare API 權杖：設定 CF_API_TOKEN，或存成 $SECRETS/cloudflare-token（見 README）"
  CF_HDR="$TMPDIR_SETUP/cf-header"
  (umask 077; printf 'Authorization: Bearer %s\n' "$token" > "$CF_HDR")
  local status
  status=$(cf_req GET /user/tokens/verify)
  [ "$status" = 200 ] || die "Cloudflare 權杖無效（HTTP $status）"
  status=$(cf_req GET "/zones?name=$CF_ZONE")
  CF_ZONE_ID=$(jq -r '.result[0].id // empty' "$TMPDIR_SETUP/cf-body")
  [ -n "$CF_ZONE_ID" ] || die "Cloudflare 權杖看不到網域 $CF_ZONE（權杖要包含 區域 → 區域 → 讀取）"
}
# cf_req 方法 路徑 [JSON]：回應寫到 $TMPDIR_SETUP/cf-body，印出 HTTP 狀態碼
cf_req() {
  local args=(-sS -o "$TMPDIR_SETUP/cf-body" -w '%{http_code}' -X "$1" -H "@$CF_HDR" -H 'Content-Type: application/json')
  [ $# -ge 3 ] && args+=(--data "$3")
  curl "${args[@]}" "https://api.cloudflare.com/client/v4$2"
}
# cf 方法 路徑 [JSON]：失敗時顯示 Cloudflare 的錯誤並停止；成功時印出回應
cf() {
  local status
  status=$(cf_req "$@")
  if [ "$(jq -r '.success // false' "$TMPDIR_SETUP/cf-body" 2>/dev/null)" != true ]; then
    warn "Cloudflare API 失敗：$1 $2（HTTP $status）"
    jq -c '.errors // .' "$TMPDIR_SETUP/cf-body" >&2 2>/dev/null || true
    [ "$status" = 403 ] && warn "權杖權限不足，請在 Cloudflare 權杖加上對應權限（見 README）"
    exit 1
  fi
  cat "$TMPDIR_SETUP/cf-body"
}

# dns_ensure 類型 名稱 內容 proxied(true/false)：沒有就建立；已有同名但內容不同時只警告、不覆蓋
dns_ensure() {
  local type=$1 name=$2 content=$3 proxied=$4 recs
  recs=$(cf GET "/zones/$CF_ZONE_ID/dns_records?type=$type&name=$name")
  if [ "$(jq '.result | length' <<<"$recs")" = 0 ]; then
    cf POST "/zones/$CF_ZONE_ID/dns_records" "$(jq -nc --arg t "$type" --arg n "$name" --arg c "$content" --argjson p "$proxied" \
      '{type:$t, name:$n, content:$c, proxied:$p, ttl:1, comment:"bigtours setup.sh"}')" >/dev/null
    ok "已新增 DNS $type $name"
  elif jq -e --arg c "$content" 'any(.result[]; (.content | ltrimstr("\"") | rtrimstr("\"")) == $c)' <<<"$recs" >/dev/null; then
    ok "DNS $type $name 已存在"
  else
    warn "DNS $type $name 已存在但內容不同，沒有更動，請到 Cloudflare 確認（應為 $content）"
  fi
}

# ---- SSH：本機 IP 不在 22 埠允許清單時暫時加入，結束時移除 ----
hssh() { ssh -i "$ADMIN_KEY" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new "ubuntu@$(instance_ip)" "$@"; }
ensure_ssh() {
  [ -f "$ADMIN_KEY" ] || die "找不到主機 SSH 金鑰 $ADMIN_KEY（可用 BIGTOURS_ADMIN_KEY 指定）"
  if hssh true 2>/dev/null; then return 0; fi
  local ip cidr
  ip=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')
  cidr="$ip/32"
  if aws lightsail get-instance-port-states --instance-name "$INSTANCE" \
      | jq -e --arg c "$cidr" 'any(.portStates[]; .fromPort <= 22 and .toPort >= 22 and ((.cidrs // []) | index($c) or index("0.0.0.0/0")))' >/dev/null; then
    die "22 埠已允許 $cidr，但還是連不上主機，請檢查金鑰 $ADMIN_KEY"
  fi
  sh deploy/lightsail/firewall.sh add "$cidr" >/dev/null
  SSH_OPENED_CIDR=$cidr
  info "暫時開放 SSH 給本機 $cidr（結束時移除）"
  local i
  for i in 1 2 3 4 5 6; do sleep 5; hssh true 2>/dev/null && return 0; done
  die "開放 22 埠後仍連不上主機 $(instance_ip)"
}

# ---- 步驟 ----
step_check() {
  say "檢查本機工具與登入狀態"
  local missing="" c
  for c in aws jq curl gh ssh ssh-keygen ssh-keyscan openssl node; do command -v "$c" >/dev/null || missing="$missing $c"; done
  [ -z "$missing" ] || die "缺少指令：$missing（macOS 可用 brew install 安裝）"
  ok "工具齊全"
  local arn
  arn=$(aws sts get-caller-identity --query Arn --output text) || die "aws CLI 尚未登入"
  ok "AWS：$arn（區域 $REGION）"
  gh auth status >/dev/null 2>&1 || die "gh 尚未登入：執行 gh auth login"
  gh repo view "$REPO" --json name >/dev/null || die "gh 看不到 $REPO"
  ok "GitHub：$REPO"
  ok "Lightsail 主機 $INSTANCE：$(instance_ip)"
  [ -f "$ADMIN_KEY" ] && ok "主機 SSH 金鑰：$ADMIN_KEY" || warn "找不到主機 SSH 金鑰 $ADMIN_KEY（host、github、platform-user 會用到）"
  if [ -n "${CF_API_TOKEN:-}" ] || [ -f "$SECRETS/cloudflare-token" ]; then
    cf_init; ok "Cloudflare 權杖可用，網域 $CF_ZONE"
  else
    warn "還沒有 Cloudflare 權杖（ses、cloudflare 會用到）：存成 $SECRETS/cloudflare-token"
  fi
}

step_ses() {
  say "SES：驗證寄件網域 $MAIL_DOMAIN"
  cf_init
  local identity
  if ! identity=$(aws sesv2 get-email-identity --email-identity "$MAIL_DOMAIN" 2>/dev/null); then
    aws sesv2 create-email-identity --email-identity "$MAIL_DOMAIN" --dkim-signing-attributes NextSigningKeyLength=RSA_2048 >/dev/null
    ok "已建立 SES 網域 $MAIL_DOMAIN"
    identity=$(aws sesv2 get-email-identity --email-identity "$MAIL_DOMAIN")
  else
    ok "SES 已有網域 $MAIL_DOMAIN"
  fi
  if [ "$(jq -r '.DkimAttributes.SigningAttributesOrigin' <<<"$identity")" = AWS_SES ]; then
    local t
    for t in $(jq -r '.DkimAttributes.Tokens[]?' <<<"$identity"); do
      dns_ensure CNAME "$t._domainkey.$MAIL_DOMAIN" "$t.dkim.amazonses.com" false
    done
  else
    info "DKIM 不是 Easy DKIM，略過 CNAME"
  fi

  say "DMARC"
  local recs
  recs=$(cf GET "/zones/$CF_ZONE_ID/dns_records?type=TXT&name=_dmarc.$MAIL_DOMAIN")
  if jq -e 'any(.result[]; .content | test("v=DMARC1"))' <<<"$recs" >/dev/null; then
    ok "_dmarc.$MAIL_DOMAIN 已有 DMARC，沿用：$(jq -r '[.result[] | select(.content | test("v=DMARC1"))][0].content' <<<"$recs")"
  else
    dns_ensure TXT "_dmarc.$MAIL_DOMAIN" "v=DMARC1; p=none; rua=mailto:$DMARC_RUA" false
  fi

  identity=$(aws sesv2 get-email-identity --email-identity "$MAIL_DOMAIN")
  info "DKIM 狀態：$(jq -r '.DkimAttributes.Status' <<<"$identity")；可寄信：$(jq -r '.VerifiedForSendingStatus' <<<"$identity")（新加的 DNS 通常幾分鐘到一小時內生效）"

  say "SES production access"
  local acct review
  acct=$(aws sesv2 get-account)
  review=$(jq -r '.Details.ReviewDetails.Status // empty' <<<"$acct")
  if [ "$(jq -r '.ProductionAccessEnabled' <<<"$acct")" = true ]; then
    ok "已解除 sandbox"
  elif [ "$review" = PENDING ]; then
    info "申請審核中（約一天）。核准前只能寄給 SES 已驗證的信箱"
  elif [ "$review" = DENIED ] || [ "$review" = FAILED ]; then
    warn "申請狀態 $review，請到 SES → Account dashboard 查看原因並回覆 AWS"
  else
    aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL \
      --website-url "https://$DOMAIN" --contact-language EN \
      --use-case-description "$SES_USE_CASE" \
      --additional-contact-email-addresses "$DMARC_RUA" >/dev/null
    ok "已送出 production access 申請（約一天，結果寄到 AWS 帳號信箱與 $DMARC_RUA）"
  fi
}

step_smtp() {
  say "SES SMTP 帳密"
  secret_dir
  if [ -s "$SECRETS/ses-smtp-url" ]; then ok "已有 $SECRETS/ses-smtp-url"; return 0; fi
  if ! aws iam get-user --user-name "$SMTP_IAM_USER" >/dev/null 2>&1; then
    aws iam create-user --user-name "$SMTP_IAM_USER" --tags Key=app,Value=bigtours >/dev/null
    ok "已建立 IAM 使用者 $SMTP_IAM_USER"
  fi
  aws iam put-user-policy --user-name "$SMTP_IAM_USER" --policy-name ses-send-raw-email --policy-document \
    "$(jq -nc --arg r "arn:aws:ses:$REGION:$(account_id):identity/*" '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:"ses:SendRawEmail",Resource:$r}]}')"
  local n
  n=$(aws iam list-access-keys --user-name "$SMTP_IAM_USER" --query 'length(AccessKeyMetadata)' --output text)
  [ "$n" -lt 2 ] || die "$SMTP_IAM_USER 已有 2 把存取金鑰，請先到 IAM 刪掉不用的再執行"
  [ "$n" = 0 ] || warn "$SMTP_IAM_USER 已有 $n 把金鑰，但本機沒有對應的 SMTP_URL，會再建一把新的（舊的確認不用後可到 IAM 刪除）"
  local keyfile="$TMPDIR_SETUP/smtp-key.json"
  (umask 077; aws iam create-access-key --user-name "$SMTP_IAM_USER" > "$keyfile")
  # SES SMTP 密碼由 IAM 秘密金鑰換算（AWS 公布的 SigV4 算法，版本 0x04）
  (umask 077; KEYFILE="$keyfile" SES_REGION="$REGION" node -e '
    const c = require("crypto");
    const k = JSON.parse(require("fs").readFileSync(process.env.KEYFILE, "utf8")).AccessKey;
    const h = (key, msg) => c.createHmac("sha256", key).update(msg).digest();
    let s = h("AWS4" + k.SecretAccessKey, "11111111");
    for (const m of [process.env.SES_REGION, "ses", "aws4_request", "SendRawEmail"]) s = h(s, m);
    const pass = Buffer.concat([Buffer.from([4]), s]).toString("base64");
    process.stdout.write(`smtps://${k.AccessKeyId}:${encodeURIComponent(pass)}@email-smtp.${process.env.SES_REGION}.amazonaws.com:465\n`);
  ' > "$SECRETS/ses-smtp-url")
  rm -f "$keyfile"
  ok "已存到 $SECRETS/ses-smtp-url（新金鑰約幾分鐘後才能寄信）"
}

step_cloudflare() {
  cf_init
  say "Cloudflare DNS：$DOMAIN"
  local recs ip
  ip=$(instance_ip)
  recs=$(cf GET "/zones/$CF_ZONE_ID/dns_records?name=$DOMAIN")
  if [ "$(jq '.result | length' <<<"$recs")" != 0 ]; then
    ok "已有 $DOMAIN 的紀錄（$(jq -r '[.result[] | "\(.type) \(.content) proxied=\(.proxied)"] | join(", ")' <<<"$recs")）"
  else
    recs=$(cf GET "/zones/$CF_ZONE_ID/dns_records?name=%2A.$CF_ZONE")
    if jq -e 'any(.result[]; .proxied == true)' <<<"$recs" >/dev/null; then
      ok "由 *.$CF_ZONE（已代理）涵蓋"
    else
      dns_ensure A "$DOMAIN" "$ip" true
    fi
  fi

  say "Cloudflare Origin Rule：$DOMAIN → 8443"
  local rule status rid
  rule=$(jq -nc --arg d "$DOMAIN" '{description:"bigtours: \($d) -> 8443", expression:"(http.host eq \"\($d)\")", action:"route", action_parameters:{origin:{port:8443}}, enabled:true}')
  status=$(cf_req GET "/zones/$CF_ZONE_ID/rulesets/phases/http_request_origin/entrypoint")
  if [ "$status" = 404 ]; then
    cf PUT "/zones/$CF_ZONE_ID/rulesets/phases/http_request_origin/entrypoint" "$(jq -nc --argjson r "$rule" '{rules:[$r]}')" >/dev/null
    ok "已建立 Origin Rule"
  elif [ "$status" = 200 ]; then
    if jq -e --arg d "$DOMAIN" 'any(.result.rules[]?; (.expression | contains($d)) and .action == "route" and .action_parameters.origin.port == 8443)' "$TMPDIR_SETUP/cf-body" >/dev/null; then
      ok "Origin Rule 已存在"
    else
      rid=$(jq -r '.result.id' "$TMPDIR_SETUP/cf-body")
      cf POST "/zones/$CF_ZONE_ID/rulesets/$rid/rules" "$rule" >/dev/null
      ok "已新增 Origin Rule（其他規則不變）"
    fi
  else
    warn "讀取 Origin Rules 失敗（HTTP $status）"; jq -c '.errors' "$TMPDIR_SETUP/cf-body" >&2 || true
    die "請確認權杖有 區域 → Origin Rules → 編輯（見 README）"
  fi

  say "Cloudflare Origin 憑證"
  if [ -s "$CERTS/origin.pem" ] && [ -s "$CERTS/origin.key" ]; then
    ok "本機已有 $CERTS/origin.pem、origin.key"
  else
    mkdir -p "$CERTS"; chmod 700 "$CERTS"
    # 私密金鑰在本機產生，只把 CSR 送給 Cloudflare
    (umask 077; openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$DOMAIN" \
      -keyout "$TMPDIR_SETUP/origin.key" -out "$TMPDIR_SETUP/origin.csr" 2>/dev/null)
    cf POST /certificates "$(jq -nc --arg d "$DOMAIN" --rawfile csr "$TMPDIR_SETUP/origin.csr" \
      '{hostnames:[$d], requested_validity:5475, request_type:"origin-rsa", csr:$csr}')" \
      | jq -r '.result.certificate' > "$TMPDIR_SETUP/origin.pem"
    grep -q 'BEGIN CERTIFICATE' "$TMPDIR_SETUP/origin.pem" || die "Cloudflare 沒有回傳憑證"
    install -m 600 "$TMPDIR_SETUP/origin.key" "$CERTS/origin.key"
    install -m 644 "$TMPDIR_SETUP/origin.pem" "$CERTS/origin.pem"
    ok "已產生 Origin 憑證（15 年）：$CERTS/origin.pem、origin.key"
  fi

  local mode
  if [ "$(cf_req GET "/zones/$CF_ZONE_ID/settings/ssl")" = 200 ]; then
    mode=$(jq -r '.result.value' "$TMPDIR_SETUP/cf-body")
    [ "$mode" = strict ] && ok "SSL/TLS 模式：Full (strict)" || warn "SSL/TLS 模式是 $mode，建議 Full (strict)"
  fi
}

step_firewall() {
  say "Lightsail 防火牆：8443 只開放給 Cloudflare"
  local ips states port_info
  ips=$(curl -fsS https://api.cloudflare.com/client/v4/ips)
  states=$(aws lightsail get-instance-port-states --instance-name "$INSTANCE")
  if jq -e 'any(.portStates[]; .fromPort == 8443 and .toPort == 8443 and .protocol == "tcp")' <<<"$states" >/dev/null; then
    local lacking
    lacking=$(jq -r --argjson ips "$ips" '[.portStates[] | select(.fromPort == 8443 and .protocol == "tcp")][0] as $p
      | ($ips.result.ipv4_cidrs - ($p.cidrs // [])) | join(" ")' <<<"$states")
    if jq -e 'any(.portStates[]; .fromPort == 8443 and ((.cidrs // []) | index("0.0.0.0/0")))' <<<"$states" >/dev/null; then
      warn "8443 目前對所有來源開放，建議改成只允許 Cloudflare IP"
    fi
    [ -z "$lacking" ] && ok "8443 規則已存在，已包含所有 Cloudflare IP" || warn "8443 規則已存在，但缺少這些 Cloudflare IP：$lacking"
  else
    # DNS 只有 A 紀錄，Cloudflare 以 IPv4 連回主機，所以只開 IPv4（與預約簿 443 相同）
    port_info=$(jq -c '{fromPort:8443, toPort:8443, protocol:"tcp", cidrs:.result.ipv4_cidrs}' <<<"$ips")
    aws lightsail open-instance-public-ports --instance-name "$INSTANCE" --port-info "$port_info" >/dev/null
    ok "已開放 8443 給 Cloudflare 的 IPv4（其他規則不變）"
  fi
}

step_host() {
  say "主機：Origin 憑證與 .env"
  [ -s "$CERTS/origin.pem" ] && [ -s "$CERTS/origin.key" ] || die "本機沒有 Origin 憑證，請先執行 cloudflare 步驟"
  secret_dir
  ensure_ssh
  hssh "sudo mkdir -p $HOST_DIR && sudo chown \$(id -u):\$(id -g) $HOST_DIR && mkdir -p $HOST_DIR/$CERTS && chmod 700 $HOST_DIR/$CERTS"
  tar -cf - docker-compose.prod.yml deploy/lightsail/nginx.conf deploy/lightsail/init-env.sh | hssh "tar -xf - -C $HOST_DIR"
  hssh "cat > $HOST_DIR/$CERTS/origin.pem && chmod 644 $HOST_DIR/$CERTS/origin.pem" < "$CERTS/origin.pem"
  hssh "umask 077 && cat > $HOST_DIR/$CERTS/origin.key && chmod 600 $HOST_DIR/$CERTS/origin.key" < "$CERTS/origin.key"
  ok "已上傳 Origin 憑證"

  # 第一次會產生 .env（隨機的資料庫密碼與金鑰）並因為寄信設定未填而回報缺項，這裡先忽略
  hssh "sh $HOST_DIR/deploy/lightsail/init-env.sh" >/dev/null 2>&1 || true
  hssh "test -f $HOST_DIR/.env" || die "主機上沒有產生 $HOST_DIR/.env"

  local updates="$TMPDIR_SETUP/env-updates"
  (umask 077
   printf 'MAIL_FROM=%s\nTRIAL_NOTIFY_EMAIL=%s\nSITE_LINE_URL=%s\n' "$MAIL_FROM" "$TRIAL_NOTIFY_EMAIL" "$SITE_LINE_URL" > "$updates"
   if [ -s "$SECRETS/ses-smtp-url" ]; then printf 'SMTP_URL=%s\n' "$(tr -d '\n' < "$SECRETS/ses-smtp-url")" >> "$updates"; fi)
  [ -s "$SECRETS/ses-smtp-url" ] || warn "本機沒有 SMTP_URL（smtp 步驟），主機 .env 的 SMTP_URL 不更動"
  # 只改這幾個鍵，其他（含 DATA_ENCRYPTION_KEY、TOKEN_HASH_KEY）原樣保留
  hssh "umask 077; f=$HOST_DIR/.env; u=\$(mktemp); cat > \$u; awk -F= 'NR==FNR { v[\$1] = \$0; next } (\$1 in v) { print v[\$1]; done[\$1] = 1; next } { print } END { for (k in v) if (!(k in done)) print v[k] }' \$u \$f > \$f.new && mv \$f.new \$f; rm -f \$u" < "$updates"
  if hssh "sh $HOST_DIR/deploy/lightsail/init-env.sh"; then ok "主機 .env 已填好"; else die "主機 .env 還有缺項（見上方訊息）"; fi

  (umask 077; hssh "cat $HOST_DIR/.env" > "$SECRETS/host.env")
  ok "已備份主機 .env 到 $SECRETS/host.env（內含金鑰，請另外存到密碼管理器；不要更換 DATA_ENCRYPTION_KEY、TOKEN_HASH_KEY）"
}

step_github() {
  say "GitHub 自動部署：SSH 金鑰"
  secret_dir
  if [ ! -f "$DEPLOY_KEY" ]; then
    ssh-keygen -q -t ed25519 -N "" -C bigtours-github-deploy -f "$DEPLOY_KEY"
    ok "已產生 $DEPLOY_KEY"
  else
    ok "已有 $DEPLOY_KEY"
  fi
  ensure_ssh
  local pub
  pub=$(cat "$DEPLOY_KEY.pub")
  hssh "mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qxF '$pub' ~/.ssh/authorized_keys || echo '$pub' >> ~/.ssh/authorized_keys)"
  ok "主機已授權部署金鑰"
  local known
  known=$(ssh-keyscan -t ed25519 "$(instance_ip)" 2>/dev/null | grep -v '^#' | head -n 1 || true)
  [ -n "$known" ] || die "ssh-keyscan 取不到主機金鑰"

  say "GitHub 自動部署：IAM 使用者 $DEPLOY_IAM_USER（只能改這台主機的防火牆）"
  if ! aws iam get-user --user-name "$DEPLOY_IAM_USER" >/dev/null 2>&1; then
    aws iam create-user --user-name "$DEPLOY_IAM_USER" --tags Key=app,Value=bigtours >/dev/null
    ok "已建立 IAM 使用者"
  fi
  aws iam put-user-policy --user-name "$DEPLOY_IAM_USER" --policy-name lightsail-ssh-port --policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["lightsail:GetInstancePortStates","lightsail:PutInstancePublicPorts"],"Resource":"*"}]}'
  if [ ! -s "$SECRETS/deploy-aws-key.json" ]; then
    local n
    n=$(aws iam list-access-keys --user-name "$DEPLOY_IAM_USER" --query 'length(AccessKeyMetadata)' --output text)
    [ "$n" -lt 2 ] || die "$DEPLOY_IAM_USER 已有 2 把存取金鑰，請先到 IAM 刪掉不用的再執行"
    (umask 077; aws iam create-access-key --user-name "$DEPLOY_IAM_USER" > "$SECRETS/deploy-aws-key.json")
    ok "已建立存取金鑰（存在 $SECRETS/deploy-aws-key.json）"
  else
    ok "已有存取金鑰"
  fi

  say "GitHub production 環境 Secrets"
  gh api -X PUT "repos/$REPO/environments/production" >/dev/null
  gh secret set DEPLOY_HOST --repo "$REPO" --env production --body "ubuntu@$(instance_ip)"
  gh secret set DEPLOY_SSH_KEY --repo "$REPO" --env production < "$DEPLOY_KEY"
  gh secret set DEPLOY_KNOWN_HOSTS --repo "$REPO" --env production --body "$known"
  jq -r '.AccessKey.AccessKeyId' "$SECRETS/deploy-aws-key.json" | gh secret set AWS_ACCESS_KEY_ID --repo "$REPO" --env production
  jq -r '.AccessKey.SecretAccessKey' "$SECRETS/deploy-aws-key.json" | gh secret set AWS_SECRET_ACCESS_KEY --repo "$REPO" --env production
  ok "已設定 DEPLOY_HOST、DEPLOY_SSH_KEY、DEPLOY_KNOWN_HOSTS、AWS_ACCESS_KEY_ID、AWS_SECRET_ACCESS_KEY"
}

health_check() {
  local url="https://$DOMAIN/api/v1/health" i
  for i in $(seq 1 10); do
    if curl -fsS -o /dev/null "$url"; then ok "網站正常：$url"; return 0; fi
    sleep 6
  done
  warn "$url 沒有正常回應"; return 1
}

step_deploy() {
  say "執行 GitHub Actions：Deploy（main）"
  local since run_id i
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh workflow run deploy.yml --repo "$REPO" --ref main
  for i in $(seq 1 12); do
    sleep 5
    run_id=$(gh run list --repo "$REPO" --workflow deploy.yml --event workflow_dispatch -L 5 --json databaseId,createdAt \
      --jq "[.[] | select(.createdAt >= \"$since\")][0].databaseId // empty")
    [ -n "$run_id" ] && break
  done
  [ -n "${run_id:-}" ] || die "找不到剛啟動的 Deploy，請到 GitHub Actions 查看"
  info "https://github.com/$REPO/actions/runs/$run_id（建置映像檔約 5～10 分鐘）"
  if ! gh run watch "$run_id" --repo "$REPO" --exit-status --interval 20 >/dev/null; then
    gh run view "$run_id" --repo "$REPO" --log-failed | tail -n 40 >&2 || true
    die "Deploy 失敗，錯誤訊息如上"
  fi
  ok "Deploy 完成"
  health_check
}

step_ses_feedback() {
  say "SES 退信與客訴通知：SNS Topic ${SES_TOPIC_NAME}"
  local topic identity_arn policy endpoint status updates i sub
  topic=$(aws sns create-topic --name "$SES_TOPIC_NAME" --tags Key=app,Value=bigtours --query TopicArn --output text)
  identity_arn="arn:aws:ses:${REGION}:$(account_id):identity/${MAIL_DOMAIN}"
  # 只允許這個 SES 網域發布到這個 Topic
  policy=$(jq -nc --arg t "$topic" --arg a "$(account_id)" --arg s "$identity_arn" '{Version:"2012-10-17",Statement:[{Sid:"AllowSesPublish",Effect:"Allow",Principal:{Service:"ses.amazonaws.com"},Action:"sns:Publish",Resource:$t,Condition:{StringEquals:{"AWS:SourceAccount":$a,"AWS:SourceArn":$s}}}]}')
  aws sns set-topic-attributes --topic-arn "$topic" --attribute-name Policy --attribute-value "$policy"
  ok "Topic 與存取政策已設定"

  say "主機 .env：SES_SNS_TOPIC_ARN"
  secret_dir
  ensure_ssh
  updates="$TMPDIR_SETUP/env-updates"
  printf 'SES_SNS_TOPIC_ARN=%s\n' "$topic" > "$updates"
  # 只改這個鍵，其他原樣保留
  hssh "umask 077; f=$HOST_DIR/.env; u=\$(mktemp); cat > \$u; awk -F= 'NR==FNR { v[\$1] = \$0; next } (\$1 in v) { print v[\$1]; done[\$1] = 1; next } { print } END { for (k in v) if (!(k in done)) print v[k] }' \$u \$f > \$f.new && mv \$f.new \$f; rm -f \$u" < "$updates"
  # 容器重建後 IP 會變，nginx 要重新啟動才連得到
  hssh "cd $HOST_DIR && docker compose -f docker-compose.prod.yml --env-file .env up -d --wait && docker compose -f docker-compose.prod.yml --env-file .env restart nginx" >/dev/null
  (umask 077; hssh "cat $HOST_DIR/.env" > "$SECRETS/host.env")
  ok "主機已更新，並重新備份 .env"

  endpoint="https://${DOMAIN}/api/v1/webhooks/ses"
  for i in $(seq 1 10); do
    status=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: text/plain' -d '{}' "$endpoint" || true)
    [ "$status" = 403 ] && break
    sleep 6
  done
  [ "$status" = 403 ] || die "通知端點回應 HTTP ${status}（應為 403）。回 404 表示主機上的版本還沒有這個功能，請先合併並部署；5xx 請看 docker compose logs api"

  say "訂閱通知端點"
  aws sns subscribe --topic-arn "$topic" --protocol https --notification-endpoint "$endpoint" >/dev/null
  for i in $(seq 1 20); do
    sub=$(aws sns list-subscriptions-by-topic --topic-arn "$topic" --query "Subscriptions[?Endpoint=='${endpoint}'].SubscriptionArn | [0]" --output text)
    case "$sub" in arn:*) break ;; esac
    sleep 3
  done
  case "$sub" in arn:*) ok "訂閱已確認" ;; *) die "訂閱還沒確認（${sub}），請看 docker compose logs api，或檢查 Cloudflare 是否擋下 SNS 的請求" ;; esac

  say "SES 網域 ${MAIL_DOMAIN}：把退信與客訴送到 Topic"
  aws ses set-identity-notification-topic --identity "$MAIL_DOMAIN" --notification-type Bounce --sns-topic "$topic" \
    && aws ses set-identity-notification-topic --identity "$MAIL_DOMAIN" --notification-type Complaint --sns-topic "$topic" \
    || die "無法設定 SES 通知；網域要先驗證通過（DKIM SUCCESS），之後重跑這一步"
  ok "已設定。可以用 SES 信箱模擬器 bounce@simulator.amazonses.com 測試"
}

step_platform_user() {
  say "平台人員帳號"
  [ -n "$PLATFORM_ADMIN_EMAIL" ] || die "請設定 PLATFORM_ADMIN_EMAIL（以及選填的 PLATFORM_ADMIN_NAME）"
  case "$PLATFORM_ADMIN_EMAIL$PLATFORM_ADMIN_NAME" in *[\'\"\`\$\\]*) die "Email 或姓名含有不允許的字元";; esac
  secret_dir
  local out="$SECRETS/platform-user.txt"
  if [ -s "$out" ]; then ok "已建立過，帳密在 $out（重跑會重設密碼，所以略過；要重設請先刪掉這個檔案）"; return 0; fi
  ensure_ssh
  (umask 077; hssh "cd $HOST_DIR && docker compose -f docker-compose.prod.yml --env-file .env run --rm -T migrate node_modules/.bin/tsx db/create-platform-user.ts '$PLATFORM_ADMIN_EMAIL' '$PLATFORM_ADMIN_NAME'" > "$out") \
    || { rm -f "$out"; die "建立平台帳號失敗"; }
  ok "已建立 $PLATFORM_ADMIN_EMAIL，帳密存在 $out（請自己開啟，登入 https://$DOMAIN/platform 後改存到密碼管理器）"
}

step_status() {
  say "狀態"
  local identity acct
  if identity=$(aws sesv2 get-email-identity --email-identity "$MAIL_DOMAIN" 2>/dev/null); then
    info "SES $MAIL_DOMAIN：DKIM $(jq -r '.DkimAttributes.Status' <<<"$identity")，可寄信 $(jq -r '.VerifiedForSendingStatus' <<<"$identity")"
  else
    info "SES $MAIL_DOMAIN：尚未建立"
  fi
  acct=$(aws sesv2 get-account)
  info "SES production access：$(jq -r 'if .ProductionAccessEnabled then "已開通" else "sandbox（審核：\(.Details.ReviewDetails.Status // "未申請")）" end' <<<"$acct")"
  info "SES 退信通知：$(aws ses get-identity-notification-attributes --identities "$MAIL_DOMAIN" --query "NotificationAttributes.\"${MAIL_DOMAIN}\".BounceTopic" --output text 2>/dev/null || echo 未知)"
  [ -s "$SECRETS/ses-smtp-url" ] && info "SMTP_URL：已存在本機" || info "SMTP_URL：尚未建立"
  [ -s "$CERTS/origin.pem" ] && info "Origin 憑證：本機已有" || info "Origin 憑證：尚未產生"
  aws lightsail get-instance-port-states --instance-name "$INSTANCE" \
    | jq -r '"Lightsail 防火牆：" + ([.portStates[] | "\(.fromPort)/\(.protocol)"] | join(" "))' | sed 's/^/  · /'
  info "GitHub production Secrets：$(gh secret list --repo "$REPO" --env production --json name --jq '[.[].name] | join(" ")' 2>/dev/null || echo 無)"
  curl -fsS -o /dev/null "https://$DOMAIN/api/v1/health" 2>/dev/null && info "網站：正常" || info "網站：沒有回應"
}

[ $# -gt 0 ] || { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
for s in "$@"; do
  case "$s" in
    check) step_check ;;
    ses) step_ses ;;
    smtp) step_smtp ;;
    cloudflare) step_cloudflare ;;
    firewall) step_firewall ;;
    host) step_host ;;
    github) step_github ;;
    deploy) step_deploy ;;
    ses-feedback) step_ses_feedback ;;
    platform-user) step_platform_user ;;
    status) step_status ;;
    all)
      step_check; step_ses; step_smtp; step_cloudflare; step_firewall; step_host; step_github; step_deploy; step_ses_feedback
      if [ -n "$PLATFORM_ADMIN_EMAIL" ]; then step_platform_user; fi
      step_status ;;
    *) die "未知的步驟：$s" ;;
  esac
done
