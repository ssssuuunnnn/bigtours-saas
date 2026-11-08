#!/bin/sh
# 在 Lightsail 防火牆的 22 埠加上或移除一個 IP（只動這一個 IP，其他規則原樣保留）。
# 主機與 Bookdex 預約簿共用，兩邊的部署可能同時進行，所以不整份備份還原。
# 用法：firewall.sh add|remove <IP/32>；需要 aws CLI、jq，以及 LIGHTSAIL_INSTANCE（預設 gym-system）。
set -eu
ACTION=${1:?用法：firewall.sh add|remove <IP/32>}
CIDR=${2:?用法：firewall.sh add|remove <IP/32>}
INSTANCE=${LIGHTSAIL_INSTANCE:-gym-system}
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

aws lightsail get-instance-port-states --instance-name "$INSTANCE" \
  | jq '[.portStates[] | {fromPort, toPort, protocol, cidrs, ipv6Cidrs, cidrListAliases} | with_entries(select(.value != null))]' > "$TMP"

if [ "$ACTION" = add ]; then
  jq --arg cidr "$CIDR" '
    if any(.[]; .fromPort == 22 and .toPort == 22 and .protocol == "tcp")
    then map(if .fromPort == 22 and .toPort == 22 and .protocol == "tcp" then .cidrs = ((.cidrs // []) + [$cidr] | unique) else . end)
    else . + [{fromPort: 22, toPort: 22, protocol: "tcp", cidrs: [$cidr]}]
    end' "$TMP" > "$TMP.new"
elif [ "$ACTION" = remove ]; then
  # 移除後 22 埠沒有任何來源時整條規則拿掉（不能留下空的 cidrs，否則等於全開）
  jq --arg cidr "$CIDR" '
    map(if .fromPort == 22 and .toPort == 22 and .protocol == "tcp" then .cidrs = ((.cidrs // []) - [$cidr]) else . end)
    | map(select(.fromPort != 22 or .toPort != 22 or .protocol != "tcp" or ((.cidrs // []) | length) > 0 or ((.cidrListAliases // []) | length) > 0 or ((.ipv6Cidrs // []) | length) > 0))' "$TMP" > "$TMP.new"
else
  echo "未知的動作：$ACTION" >&2
  exit 1
fi

aws lightsail put-instance-public-ports --instance-name "$INSTANCE" --port-infos "file://$TMP.new" > /dev/null
rm -f "$TMP.new"
if [ "$ACTION" = add ]; then echo "22 埠已加入 $CIDR"; else echo "22 埠已移除 $CIDR"; fi
