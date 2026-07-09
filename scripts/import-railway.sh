#!/usr/bin/env bash
# scripts/import-railway.sh
# ----------------------------------------------------------------
# Import a .sql dump into a Postgres target (Railway). Pair with
# scripts/export-supabase.sh.
#
# Usage:
#   TARGET_DATABASE_URL="postgresql://postgres:PW@HOST.railway.app:5432/railway" \
#     ./scripts/import-railway.sh <input-file.sql>
#
# Optional env:
#   DROP_AND_RECREATE=1   # drop all user tables first (clean slate import)
# ----------------------------------------------------------------
set -euo pipefail

: "${TARGET_DATABASE_URL:?Set TARGET_DATABASE_URL to your Railway Postgres URL}"
: "${1:?Usage: TARGET_DATABASE_URL=... $0 <input.sql>}"

IN="$1"
if [ ! -f "$IN" ]; then echo "[error] file not found: $IN"; exit 1; fi

echo "[import] target : $(echo "$TARGET_DATABASE_URL" | sed -E 's#://[^:]+:[^@]+@#://***:***@#')"
echo "[import] input  : $IN ($(wc -l < "$IN") lines, $(du -h "$IN" | cut -f1))"

if [ "${DROP_AND_RECREATE:-0}" = "1" ]; then
  echo "[import] DROP_AND_RECREATE=1 -> dropping all user tables first ..."
  psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r record;
BEGIN
  FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
    EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
  END LOOP;
END $$;
SQL
fi

echo "[import] running psql ..."
# -v ON_ERROR_STOP=1 -> abort on first error so we don't half-import
# -f  -> read SQL from file
# -q  -> quiet (show only errors + final summary)
psql "$TARGET_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -q \
  -f "$IN"

echo "[import] done. Verify:"
echo "  psql \"\$TARGET_DATABASE_URL\" -c '\\dt'         # list tables"
echo "  psql \"\$TARGET_DATABASE_URL\" -c 'SELECT COUNT(*) FROM daily;'"