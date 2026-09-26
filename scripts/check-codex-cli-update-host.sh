#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${CODEX_BOT_ROOT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
ENV_FILE="${CODEX_BOT_HOST_ENV:-/etc/codex-feishu/.env.real}"
CONFIG_FILE="${CODEX_CLI_UPDATE_CONFIG:-/etc/codex-feishu/codex-cli-update.env}"
PROJECT_NAME="${CODEX_BOT_COMPOSE_PROJECT:-codex-feishu-bot-real}"
STATE_DIR="${CODEX_CLI_UPDATE_STATE_DIR:-/var/lib/codex-feishu-bot/cli-update}"
LOCK_FILE="${CODEX_CLI_UPDATE_LOCK_FILE:-/run/lock/codex-feishu-cli-update.lock}"
REGISTRY_URL="${CODEX_CLI_REGISTRY_URL:-https://registry.npmjs.org/%40openai%2Fcodex/latest}"
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage: check-codex-cli-update-host.sh [--dry-run]

Checks the running Codex CLI against npm's stable latest release. A normal
run sends one Feishu notification per newer version; --dry-run never sends a
message or changes notification state.
EOF
}

case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=true ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

for command_name in curl docker flock python3 sort; do
  command -v "$command_name" >/dev/null || {
    echo "required command is missing: $command_name" >&2
    exit 1
  }
done
test -d "$ROOT_DIR"
test -f "$ENV_FILE"

compose() {
  docker compose --project-directory "$ROOT_DIR" --env-file "$ENV_FILE" -p "$PROJECT_NAME" "$@"
}

read_config_value() {
  local key="$1"
  local value

  value="$(sed -n "s/^${key}=//p" "$CONFIG_FILE" | tail -n 1)"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "a Codex CLI update check is already running" >&2
  exit 75
fi

container_id="$(compose ps -q app)"
if [[ -z "$container_id" ]]; then
  echo "the production app container is not running" >&2
  exit 1
fi

current_output="$(docker exec "$container_id" codex --version)"
current_version="$(sed -n 's/^codex-cli \([0-9][0-9.]*\).*/\1/p' <<<"$current_output")"
if [[ ! "$current_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "could not parse the running Codex CLI version" >&2
  exit 1
fi

latest_version="$(
  curl --fail --silent --show-error --location --max-time 30 "$REGISTRY_URL" |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["version"])'
)"
if [[ ! "$latest_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "npm latest did not return a stable semantic version" >&2
  exit 1
fi

highest_version="$(printf '%s\n%s\n' "$current_version" "$latest_version" | sort -V | tail -n 1)"
if [[ "$current_version" == "$latest_version" || "$highest_version" == "$current_version" ]]; then
  echo "Codex CLI is current: running=$current_version stable=$latest_version"
  if [[ "$DRY_RUN" == false && -d "$STATE_DIR" ]]; then
    rm -f "$STATE_DIR/last-notified-version"
  fi
  exit 0
fi

echo "Codex CLI update available: running=$current_version stable=$latest_version"
if [[ "$DRY_RUN" == true ]]; then
  echo "dry run: no Feishu notification was sent"
  exit 0
fi

test -f "$CONFIG_FILE" || {
  echo "update notification config is missing: $CONFIG_FILE" >&2
  exit 1
}
chat_id="$(read_config_value CODEX_CLI_UPDATE_NOTIFY_CHAT_ID)"
if [[ ! "$chat_id" =~ ^oc_[A-Za-z0-9]+$ ]]; then
  echo "CODEX_CLI_UPDATE_NOTIFY_CHAT_ID is missing or invalid" >&2
  exit 1
fi

install -d -m 0700 "$STATE_DIR"
last_notified=""
if [[ -f "$STATE_DIR/last-notified-version" ]]; then
  last_notified="$(tr -d '\r\n' <"$STATE_DIR/last-notified-version")"
fi
if [[ "$last_notified" == "$latest_version" ]]; then
  echo "Feishu notification already sent for Codex CLI $latest_version"
  exit 0
fi

message="发现 Codex CLI 稳定版更新：当前 ${current_version}，新版 ${latest_version}。机器人不会自动升级或重启；需要时回复「确认升级」，由你决定是否更新。"
docker exec "$container_id" node /opt/codex-tools/feishu-bridge.mjs \
  send-text --chat-id "$chat_id" --text "$message"

state_tmp="$(mktemp "$STATE_DIR/.last-notified-version.XXXXXX")"
trap 'rm -f "$state_tmp"' EXIT
printf '%s\n' "$latest_version" >"$state_tmp"
chmod 0600 "$state_tmp"
mv -f "$state_tmp" "$STATE_DIR/last-notified-version"
trap - EXIT
echo "Feishu notification sent for Codex CLI $latest_version"
