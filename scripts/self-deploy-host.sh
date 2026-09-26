#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="${CODEX_BOT_HOST_ENV:-/etc/codex-feishu/.env.real}"
PROJECT_NAME="${CODEX_BOT_COMPOSE_PROJECT:-codex-feishu-bot-real}"
IMAGE_NAME="${CODEX_BOT_IMAGE:-codex-feishu-bot-real-app:latest}"
LOCK_FILE="${CODEX_BOT_DEPLOY_LOCK:-/run/lock/codex-feishu-bot-deploy.lock}"

compose() {
  docker compose --env-file "$ENV_FILE" -p "$PROJECT_NAME" "$@"
}

read_env_value() {
  local key="$1"
  local value

  value="$(sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1)"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

test -f "$ENV_FILE"
codex_cli_version="$(read_env_value CODEX_CLI_VERSION)"
if [[ -z "$codex_cli_version" ]]; then
  echo "CODEX_CLI_VERSION is not set in $ENV_FILE" >&2
  exit 1
fi
if [[ ! "$codex_cli_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "CODEX_CLI_VERSION must be a stable semantic version" >&2
  exit 1
fi

if [[ "${1:-}" == "--dry-run" ]]; then
  test -f "$ROOT_DIR/Dockerfile"
  test -f "$ROOT_DIR/docker-compose.yml"
  command -v docker >/dev/null
  command -v flock >/dev/null
  docker info >/dev/null
  docker compose version >/dev/null
  echo "self-deploy prerequisites are ready (Codex CLI $codex_cli_version)"
  exit 0
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "another codex-feishu-bot deployment is already running" >&2
  exit 75
fi

cd "$ROOT_DIR"
echo "building $IMAGE_NAME from $ROOT_DIR with Codex CLI $codex_cli_version"
docker build --build-arg "CODEX_CLI_VERSION=$codex_cli_version" -t "$IMAGE_NAME" .

echo "recreating $PROJECT_NAME app"
compose up -d --no-build --force-recreate app

container_id="$(compose ps -q app)"
if [[ -z "$container_id" ]]; then
  echo "compose did not return an app container id" >&2
  exit 1
fi

for _ in $(seq 1 90); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
  if [[ "$health" == "healthy" ]]; then
    echo "deployment completed: container $container_id is healthy"
    exit 0
  fi
  if [[ "$health" == "unhealthy" || "$health" == "exited" || "$health" == "dead" ]]; then
    break
  fi
  sleep 2
done

echo "deployment failed health verification" >&2
compose ps >&2 || true
docker logs --tail 100 "$container_id" >&2 || true
exit 1
