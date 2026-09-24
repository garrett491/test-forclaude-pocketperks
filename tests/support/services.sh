#!/usr/bin/env bash
# Starts or stops the local Supabase stand-in and an Astro server for the
# end-to-end suite. PID files live in .supabase-local/.
#
#   bash tests/support/services.sh start [dev|preview]
#   bash tests/support/services.sh stop
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="$ROOT/.supabase-local"
mkdir -p "$STATE"
cd "$ROOT"

stop_one() {
  local file="$STATE/$1.pid"
  if [[ -f "$file" ]]; then
    # The whole process group: `npx astro dev` leaves its child running if
    # only the parent is killed, and the port stays taken.
    kill -- "-$(cat "$file")" 2>/dev/null || kill "$(cat "$file")" 2>/dev/null || true
    rm -f "$file"
  fi
}

case "${1:-}" in
  start)
    mode="${2:-dev}"
    bash "$0" stop >/dev/null
    setsid nohup node tests/support/supabase-local.mjs > "$STATE/supabase.log" 2>&1 &
    echo $! > "$STATE/supabase.pid"
    if [[ "$mode" == "preview" ]]; then
      PP_ID_CACHE_TTL_MS=0 setsid nohup node --env-file=.env tests/support/serve-build.mjs > "$STATE/web.log" 2>&1 &
    else
      PP_ID_CACHE_TTL_MS=0 setsid nohup npx astro dev --port 4321 --host 127.0.0.1 > "$STATE/web.log" 2>&1 &
    fi
    echo $! > "$STATE/web.pid"
    for _ in $(seq 1 60); do
      if curl -s -o /dev/null "http://127.0.0.1:4321/robots.txt" && curl -s -o /dev/null "http://127.0.0.1:54321/__control/reload"; then
        echo "services up ($mode)"; exit 0
      fi
      sleep 1
    done
    echo "services did not start"; tail -20 "$STATE/web.log"; exit 1
    ;;
  stop)
    stop_one web; stop_one supabase
    # Belt and braces: anything still holding the test ports.
    for port in 4321 54321; do
      pid=$(lsof -ti tcp:$port 2>/dev/null || true)
      [[ -n "$pid" ]] && kill $pid 2>/dev/null || true
    done
    echo "services stopped"
    ;;
  *)
    echo "usage: services.sh start [dev|preview] | stop"; exit 2 ;;
esac
