#!/usr/bin/env bash
set -euo pipefail

# Run on the Linux host as root. It creates an isolated runtime directory and
# updates only the marked XHS section in the existing private bot env file.
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
ENV_FILE="${CODEX_BOT_HOST_ENV:-/etc/codex-feishu/.env.real}"
NETWORK="${XHS_MCP_NETWORK:-codex-feishu-xhs}"
DATA_DIR="${XHS_MCP_DATA_DIR:-/var/lib/codex-feishu/xiaohongshu-mcp/data}"
IMAGES_DIR="${XHS_MCP_IMAGES_DIR:-/var/lib/codex-feishu/xiaohongshu-mcp/images}"
MARKER_START='# >>> codex-feishu-xhs >>>'
MARKER_END='# <<< codex-feishu-xhs <<<'

if [[ "${EUID}" -ne 0 ]]; then
  echo "run this installer as root" >&2
  exit 1
fi
[[ -f "$ENV_FILE" ]] || { echo "missing bot env file: $ENV_FILE" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

mkdir -p "$DATA_DIR" "$IMAGES_DIR"
chmod 700 "$DATA_DIR" "$IMAGES_DIR"

if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  docker network create "$NETWORK" >/dev/null
fi

# Preserve an existing token on reruns so the already-running bot never loses
# access while the independent MCP container is being refreshed.
TOKEN="$(awk -v start="$MARKER_START" -v end="$MARKER_END" '
  $0 == start { inside = 1; next }
  $0 == end { inside = 0 }
  inside && /^XHS_MCP_AUTH_TOKEN=/ {
    sub(/^XHS_MCP_AUTH_TOKEN=/, "")
    print
    exit
  }
' "$ENV_FILE")"

if [[ -z "$TOKEN" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    TOKEN="$(openssl rand -hex 32)"
  else
    TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  fi
fi

TEMP_FILE="$(mktemp "${ENV_FILE}.XXXXXX")"
trap 'rm -f "$TEMP_FILE"' EXIT HUP INT TERM
awk -v start="$MARKER_START" -v end="$MARKER_END" '
  $0 == start { skipping = 1; next }
  $0 == end { skipping = 0; next }
  !skipping { print }
' "$ENV_FILE" > "$TEMP_FILE"

cat >> "$TEMP_FILE" <<EOF

$MARKER_START
# Private runtime settings for the separate, read-only Xiaohongshu MCP.
XHS_MCP_ENABLED=true
XHS_MCP_URL=http://xiaohongshu-mcp:18060/mcp
XHS_MCP_NETWORK=$NETWORK
XHS_MCP_AUTH_TOKEN=$TOKEN
XHS_MCP_DATA_DIR=$DATA_DIR
XHS_MCP_IMAGES_DIR=$IMAGES_DIR
$MARKER_END
EOF

chmod 600 "$TEMP_FILE"
mv "$TEMP_FILE" "$ENV_FILE"
trap - EXIT HUP INT TERM

docker compose --env-file "$ENV_FILE" \
  -f "$ROOT_DIR/deploy/xiaohongshu-mcp/docker-compose.yml" \
  -p codex-feishu-xhs up -d

echo "Xiaohongshu MCP is running on private Docker network: $NETWORK"
echo "Now redeploy the bot once so it joins that network and loads the read-only MCP config."
