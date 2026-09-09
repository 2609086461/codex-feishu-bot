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

if [[ "${1:-}" == "--dry-run" ]]; then
  test -f "$ROOT_DIR/Dockerfile"
  test -f "$ROOT_DIR/docker-compose.yml"
  test -f "$ENV_FILE"
  command -v docker >/dev/null
  command -v flock >/dev/null
  docker info >/dev/null
  docker compose version >/dev/null
  echo "self-deploy prerequisites are ready"
  exit 0
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "another codex-feishu-bot deployment is already running" >&2
  exit 75
fi

cd "$ROOT_DIR"
echo "building $IMAGE_NAME from $ROOT_DIR"
docker build -t "$IMAGE_NAME" .

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
