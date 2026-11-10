#!/bin/sh
set -eu

case "${1:-start}" in
  start) entry=dist/src/server/main.js ;;
  db:migrate) entry=dist/scripts/migrate.js ;;
  configure:llm) entry=dist/scripts/configure-llm.js ;;
  check:llm) entry=dist/scripts/live-model.js ;;
  *)
    printf '%s\n' '用法: Start LoopLab.command [start|db:migrate|configure:llm|check:llm]'
    exit 1
    ;;
esac
if [ "$#" -gt 0 ]; then shift; fi

: "${LOOPLAB_DATA_DIR:=$HOME/Library/Application Support/LoopLab}"
case "$LOOPLAB_DATA_DIR" in
  /*) ;;
  *) LOOPLAB_DATA_DIR="$PWD/$LOOPLAB_DATA_DIR" ;;
esac
cd "$(/usr/bin/dirname "$0")"
root="$PWD"
umask 077
/bin/mkdir -p "$LOOPLAB_DATA_DIR"
settings="$LOOPLAB_DATA_DIR/.env.local"
if [ ! -f "$settings" ]; then
  if [ -f .env.local ]; then
    /bin/cp .env.local "$settings"
    /bin/chmod 600 "$settings"
  elif [ -z "${DATABASE_URL:-}" ]; then
    /bin/cp .env.example "$settings"
    printf '请在以下文件中配置 DATABASE_URL 后重新启动\n%s\n' "$settings"
    exit 1
  fi
fi

export LOOPLAB_DATA_DIR
export LOOPLAB_GIT_EXECUTABLE="$root/runtime/git/bin/git"
export PLAYWRIGHT_BROWSERS_PATH="$root/runtime/browsers"
export LOOPLAB_OPEN_BROWSER="${LOOPLAB_OPEN_BROWSER:-1}"
exec "$root/runtime/node/bin/node" "$entry" "$@"
