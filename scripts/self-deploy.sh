#!/usr/bin/env bash
set -euo pipefail

HOST_REPO="${CODEX_BOT_HOST_REPO:-/opt/codex-feishu-bot}"
HOST_SCRIPT="$HOST_REPO/scripts/self-deploy-host.sh"
HOST_EXEC="${CODEX_HOST_EXEC:-/usr/local/bin/codex-host-exec}"

if [[ ! -x "$HOST_EXEC" ]]; then
  echo "missing host executor: $HOST_EXEC" >&2
  exit 1
fi

if [[ "${1:-}" == "--dry-run" ]]; then
  exec "$HOST_EXEC" "$HOST_SCRIPT" --dry-run
fi

"$HOST_EXEC" test -x "$HOST_SCRIPT"
"$HOST_EXEC" test -x /usr/bin/systemd-run

unit="codex-feishu-bot-deploy-$(date +%Y%m%d-%H%M%S)-${RANDOM}"
"$HOST_EXEC" /usr/bin/systemd-run \
  --unit="$unit" \
  --description="Codex Feishu bot self deployment" \
  --collect \
  --no-block \
  --property=Type=oneshot \
  --property=TimeoutStartSec=20min \
  "$HOST_SCRIPT"

echo "deployment handed off to host unit: $unit"
echo "status: codex-host-exec systemctl status $unit"
echo "logs: codex-host-exec journalctl -u $unit -f"
