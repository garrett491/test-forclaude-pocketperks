#!/usr/bin/env bash
# Rebuilds the local end-to-end database from the migrations, then loads the
# fixtures. Local only — never point this at Supabase.
#
#   PGHOST=/tmp PGPORT=5433 PGUSER=postgres bash tests/support/reset-db.sh
set -euo pipefail

PGHOST=${PGHOST:-/tmp}
PGPORT=${PGPORT:-5433}
PGUSER=${PGUSER:-postgres}
DB=${DB:-pp_e2e}
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PGHOST PGPORT PGUSER

psql -q -c "drop database if exists $DB with (force);" -c "create database $DB;" >/dev/null

run() { psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$1" >/dev/null 2>&1 || psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$1"; }

run "$ROOT/supabase/tests/00_supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/000[1-5]_*.sql; do run "$f"; done
run "$ROOT/supabase/seed.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  case "$(basename "$f")" in 000[1-5]_*) continue ;; esac
  run "$f"
done
run "$ROOT/tests/support/fixtures.sql"
echo "e2e database $DB ready"
