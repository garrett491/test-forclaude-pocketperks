#!/usr/bin/env bash
# Rebuild a scratch database from scratch, apply every migration, seed it,
# then assert the guarantees. Local only — never point this at Supabase.
set -euo pipefail

PGHOST=${PGHOST:-/tmp}
PGPORT=${PGPORT:-5433}
DB=${DB:-pptest}
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

psql -h "$PGHOST" -p "$PGPORT" -q -c "drop database if exists $DB;" -c "create database $DB;"

for f in \
  tests/00_supabase_stub.sql \
  migrations/0001_foundation.sql \
  migrations/0002_tables.sql \
  migrations/0003_rls.sql \
  migrations/0004_analytics.sql \
  migrations/0005_storage.sql \
  seed.sql \
  migrations/0006_fixes.sql \
  migrations/0007_gallery_theme_branding.sql \
  migrations/0008_location_carousel.sql \
  migrations/0008_location_carousel.sql \
  seed.sql
do
  psql -h "$PGHOST" -p "$PGPORT" -d "$DB" -v ON_ERROR_STOP=1 -q -f "$DIR/$f"
done
echo "migrations applied (seed run twice to prove idempotency)"

psql -h "$PGHOST" -p "$PGPORT" -d "$DB" -v ON_ERROR_STOP=1 -f "$DIR/tests/01_guarantees.sql" 2>&1 \
  | grep -E 'PASS|FAIL|ERROR|all guarantees' | sed 's/.*NOTICE:  //; s/.*ERROR:  //'
