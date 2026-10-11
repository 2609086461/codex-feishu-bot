#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.portable"
COMPOSE_FILE="$ROOT_DIR/docker-compose.portable.yml"

usage() {
  echo "usage: $0 {init|check|login|up|status|smoke|logs|down}" >&2
  exit 2
}

require_env() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "missing .env.portable; run $0 init first" >&2
    exit 1
  fi
}

compose() {
  require_env
  docker compose --project-directory "$ROOT_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

case "${1:-}" in
  init)
    mkdir -p "$ROOT_DIR/.portable-data/workspace" \
      "$ROOT_DIR/.portable-data/codex-home" \
      "$ROOT_DIR/.portable-data/ssh" \
      "$ROOT_DIR/.portable-data/mail" \
      "$ROOT_DIR/.portable-data/speech"
    chmod 700 "$ROOT_DIR/.portable-data" "$ROOT_DIR/.portable-data/workspace" \
      "$ROOT_DIR/.portable-data/codex-home" \
      "$ROOT_DIR/.portable-data/ssh" "$ROOT_DIR/.portable-data/mail" \
      "$ROOT_DIR/.portable-data/speech"
    if [ ! -e "$ENV_FILE" ]; then
      cp "$ROOT_DIR/.env.portable.example" "$ENV_FILE"
      chmod 600 "$ENV_FILE"
      echo "created .env.portable; fill in the Feishu credentials and allowed Open IDs"
    else
      echo ".env.portable already exists; left it unchanged"
    fi
    ;;
  check)
    compose config --quiet
    echo "portable Compose configuration is valid"
    ;;
  login)
    compose run --rm --entrypoint codex app login --device-auth
    ;;
  up)
    compose up --build -d
    ;;
  status)
    compose ps
    ;;
  smoke)
    compose ps
    compose exec -T app wget -qO- http://127.0.0.1:3000/health
    echo
    ;;
  logs)
    compose logs -f app
    ;;
  down)
    compose down
    ;;
  *) usage ;;
esac
