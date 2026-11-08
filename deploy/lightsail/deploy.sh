#!/bin/sh
# 把指定的映像檔部署到 Lightsail 主機的 /opt/bigtours：上傳設定檔 → 檢查 .env → 下載映像檔 → 遷移資料庫並重新啟動。
# GitHub Actions 的自動部署也是跑這支。
#
# 用法：deploy/lightsail/deploy.sh [ubuntu@主機IP]
# 環境變數：
#   APP_IMAGE          必填，例如 ghcr.io/ssssuuunnnn/bigtours-saas:<commit>
#   BIGTOURS_DEPLOY_HOST   沒有用參數指定主機時使用
#   BIGTOURS_DEPLOY_KEY    SSH 金鑰，預設 ~/.ssh/gym-lightsail.pem
#   GHCR_USER、GHCR_TOKEN  映像檔是私有的時候用來登入 GHCR（只在這次部署期間登入）
set -eu
cd "$(dirname "$0")/../.."

HOST=${1:-${BIGTOURS_DEPLOY_HOST:?請提供 ubuntu@主機IP 或設定 BIGTOURS_DEPLOY_HOST}}
KEY=${BIGTOURS_DEPLOY_KEY:-$HOME/.ssh/gym-lightsail.pem}
IMAGE=${APP_IMAGE:?請設定 APP_IMAGE，例如 ghcr.io/ssssuuunnnn/bigtours-saas:<commit>}
case "$IMAGE" in *[!A-Za-z0-9._/:@-]*) echo "APP_IMAGE 格式不正確：$IMAGE" >&2; exit 1 ;; esac
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new $HOST"
DIR=/opt/bigtours
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env"

echo "==> 上傳設定檔到 $HOST:$DIR"
$SSH "sudo mkdir -p $DIR && sudo chown \$(id -u):\$(id -g) $DIR && mkdir -p $DIR/deploy/lightsail/certs && chmod 700 $DIR/deploy/lightsail/certs"
# 主機只需要 compose 檔與部署設定；程式都在映像檔裡
tar -cf - docker-compose.prod.yml deploy/lightsail/nginx.conf deploy/lightsail/init-env.sh | $SSH "tar -xf - -C $DIR"

# 本機 deploy/lightsail/certs/ 有 Origin 憑證時一併上傳（不進 git）
CERTS=deploy/lightsail/certs
if [ -f $CERTS/origin.pem ] && [ -f $CERTS/origin.key ]; then
  scp -i "$KEY" -q $CERTS/origin.pem $CERTS/origin.key "$HOST:$DIR/$CERTS/"
  $SSH "chmod 644 $DIR/$CERTS/origin.pem && chmod 600 $DIR/$CERTS/origin.key"
fi
if ! $SSH "test -f $DIR/$CERTS/origin.pem && test -f $DIR/$CERTS/origin.key"; then
  echo "主機上還沒有 Cloudflare Origin 憑證：請放到 $DIR/$CERTS/origin.pem、origin.key（見 deploy/lightsail/README.md）" >&2
  exit 1
fi

$SSH "sh $DIR/deploy/lightsail/init-env.sh"
# 記下這次的映像檔，之後在主機上手動執行 docker compose 也會用同一版
$SSH "cd $DIR && sed -i '/^APP_IMAGE=/d' .env && echo 'APP_IMAGE=$IMAGE' >> .env"

if [ -n "${GHCR_TOKEN:-}" ]; then
  printf '%s' "$GHCR_TOKEN" | $SSH "docker login ghcr.io -u '${GHCR_USER:-deploy}' --password-stdin >/dev/null"
fi
echo "==> 下載 $IMAGE"
pull_status=0
$SSH "cd $DIR && $COMPOSE pull --quiet" || pull_status=$?
if [ -n "${GHCR_TOKEN:-}" ]; then $SSH "docker logout ghcr.io >/dev/null 2>&1 || true"; fi
[ "$pull_status" -eq 0 ] || exit "$pull_status"

echo "==> 遷移資料庫並重新啟動"
$SSH "cd $DIR && $COMPOSE up -d --wait --remove-orphans && docker image prune -f >/dev/null"
$SSH "cd $DIR && $COMPOSE ps"
