#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
CONFIG_DIR="${CODEX_CLI_UPDATE_CONFIG_DIR:-/etc/codex-feishu}"
CONFIG_FILE="$CONFIG_DIR/codex-cli-update.env"
SYSTEMD_DIR="${CODEX_CLI_UPDATE_SYSTEMD_DIR:-/etc/systemd/system}"
CHAT_ID=""
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage: install-host.sh --chat-id oc_... [--dry-run]

Installs and enables the weekly Codex CLI stable-version check. The check only
notifies the configured Feishu chat and never upgrades Codex automatically.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chat-id)
      CHAT_ID="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! "$CHAT_ID" =~ ^oc_[A-Za-z0-9]+$ ]]; then
  echo "--chat-id must be a Feishu chat id beginning with oc_" >&2
  exit 2
fi
if [[ "$EUID" -ne 0 ]]; then
  echo "install-host.sh must run as root" >&2
  exit 1
fi

checker="$ROOT_DIR/scripts/check-codex-cli-update-host.sh"
service_source="$ROOT_DIR/deploy/codex-cli-update/codex-cli-update.service"
timer_source="$ROOT_DIR/deploy/codex-cli-update/codex-cli-update.timer"
test -x "$checker"
test -f "$service_source"
test -f "$timer_source"
command -v systemctl >/dev/null
command -v systemd-analyze >/dev/null
systemd-analyze verify "$service_source" "$timer_source"
systemd-analyze calendar 'Sun *-*-* 04:00:00 Asia/Shanghai' >/dev/null

if [[ "$DRY_RUN" == true ]]; then
  echo "Codex CLI update timer prerequisites are ready"
  exit 0
fi

install -d -m 0700 "$CONFIG_DIR"
config_tmp="$(mktemp "$CONFIG_DIR/.codex-cli-update.env.XXXXXX")"
trap 'rm -f "$config_tmp"' EXIT
printf 'CODEX_CLI_UPDATE_NOTIFY_CHAT_ID=%s\n' "$CHAT_ID" >"$config_tmp"
chmod 0600 "$config_tmp"
mv -f "$config_tmp" "$CONFIG_FILE"
trap - EXIT

install -m 0644 "$service_source" "$SYSTEMD_DIR/codex-cli-update.service"
install -m 0644 "$timer_source" "$SYSTEMD_DIR/codex-cli-update.timer"
systemctl daemon-reload
systemctl enable --now codex-cli-update.timer
echo "Codex CLI update timer installed for Feishu chat $CHAT_ID"
