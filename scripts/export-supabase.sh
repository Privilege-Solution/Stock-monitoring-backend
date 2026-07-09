#!/usr/bin/env bash
# scripts/export-supabase.sh
# ----------------------------------------------------------------
# Export full schema + data from a Postgres source (Supabase) to
# a local .sql file. The file can then be reviewed and imported
# into Railway Postgres using scripts/import-railway.sh.
#
# Usage:
#   SOURCE_DATABASE_URL="postgresql://postgres.REF:PW@aws-0-REGION.pooler.supabase.com:6543/postgres" \
#     ./scripts/export-supabase.sh [output-file.sql]
#
# If output-file is omitted, defaults to ./supabase-dump-<timestamp>.sql
#
# Flags explained:
#   --no-owner          Don't emit ALTER OWNER statements (target role may differ)
#   --no-acl            Don't emit GRANT/REVOKE (we set perms ourselves)
#   --clean             Emit DROP ... IF EXISTS before CREATE (idempotent re-import)
#   --if-exists         Pair with --clean so drops don't error on missing objects
#   --quote-all-identifiers  Safer for mixed-case identifiers
# ----------------------------------------------------------------
set -euo pipefail

: "${SOURCE_DATABASE_URL:?Set SOURCE_DATABASE_URL to your Supabase (or other source) Postgres URL}"

OUT="${1:-supabase-dump-$(date +%Y%m%d-%H%M%S).sql}"

echo "[export] source : $(echo "$SOURCE_DATABASE_URL" | sed -E 's#://[^:]+:[^@]+@#://***:***@#')"
echo "[export] output : $OUT"
echo "[export] running pg_dump ..."

pg_dump "$SOURCE_DATABASE_URL" \
  --no-owner \
  --no-acl \
  --clean \
  --if-exists \
  --quote-all-identifiers \
  -f "$OUT"

LINES=$(wc -l < "$OUT")
SIZE=$(du -h "$OUT" | cut -f1)
echo "[export] done. $LINES lines, $SIZE"
echo
echo "Verify before importing:"
echo "  head -50  \"$OUT\"                              # peek schema"
echo "  grep -c '^COPY ' \"$OUT\"                       # count COPY blocks (data)"
echo "  grep '^CREATE TABLE' \"$OUT\"                   # list tables"