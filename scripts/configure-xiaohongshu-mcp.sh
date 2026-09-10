#!/bin/sh
set -eu

# Codex reads MCP declarations from its user-level config. Keep this block
# idempotent because the Codex home is a persistent host mount.
CODEX_HOME_DIR="${CODEX_HOME_DIR:-/root/.codex}"
CONFIG_FILE="${CODEX_HOME_DIR}/config.toml"
MARKER_START='# >>> codex-feishu-xhs >>>'
MARKER_END='# <<< codex-feishu-xhs <<<'

mkdir -p "$CODEX_HOME_DIR"
TEMP_FILE="$(mktemp "${CODEX_HOME_DIR}/config.toml.XXXXXX")"
trap 'rm -f "$TEMP_FILE"' EXIT HUP INT TERM

if [ -f "$CONFIG_FILE" ]; then
  awk -v start="$MARKER_START" -v end="$MARKER_END" '
    $0 == start { skipping = 1; next }
    $0 == end { skipping = 0; next }
    !skipping { print }
  ' "$CONFIG_FILE" > "$TEMP_FILE"
fi

if [ "${XHS_MCP_ENABLED:-false}" = "true" ] && [ -n "${XHS_MCP_AUTH_TOKEN:-}" ]; then
  cat >> "$TEMP_FILE" <<EOF

$MARKER_START
# Managed by codex-feishu-bot. Only explicitly allow read/login-status tools;
# actions that publish, comment, like, favourite, reply, or delete cookies are
# intentionally not exposed to Codex.
[mcp_servers.xiaohongshu]
url = "${XHS_MCP_URL:-http://xiaohongshu-mcp:18060/mcp}"
bearer_token_env_var = "XHS_MCP_AUTH_TOKEN"
enabled_tools = [
  "check_login_status",
  "get_login_qrcode",
  "list_feeds",
  "search_feeds",
  "get_feed_detail",
  "user_profile",
  "get_my_profile",
  "get_unread_count",
  "list_notifications",
]
startup_timeout_sec = 30
tool_timeout_sec = 90
$MARKER_END
EOF
fi

chmod 600 "$TEMP_FILE"
mv "$TEMP_FILE" "$CONFIG_FILE"
trap - EXIT HUP INT TERM
