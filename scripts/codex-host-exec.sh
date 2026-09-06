#!/usr/bin/env bash
set -euo pipefail

if [[ ! -e /host/etc/os-release ]]; then
  echo "host filesystem is not mounted at /host" >&2
  exit 1
fi

exec nsenter --target 1 --mount --uts --ipc --net --pid -- "$@"
