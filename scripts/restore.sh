#!/usr/bin/env bash
# Restore a dump written by scripts/backup.sh into a Compose deployment.
# This REPLACES everything in the target database. Run from the directory that
# holds docker-compose.yml:
#
#   scripts/restore.sh backups/botnote-20270101T030000Z.sql.gz
#   scripts/restore.sh --yes <file>      # no confirmation prompt
#
#   BOTNOTE_COMPOSE  compose command (default "docker compose")
set -euo pipefail

read -r -a COMPOSE <<<"${BOTNOTE_COMPOSE:-docker compose}"

yes=0
if [ "${1:-}" = "--yes" ]; then
  yes=1
  shift
fi
file="${1:-}"
if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "usage: scripts/restore.sh [--yes] <dump.sql.gz>" >&2
  exit 2
fi
gzip -t "$file"

if [ "$yes" -ne 1 ]; then
  read -r -p "Replace ALL data in this botnote database with $file? Type 'restore' to continue: " answer
  [ "$answer" = "restore" ] || { echo "aborted"; exit 1; }
fi

"${COMPOSE[@]}" up -d --wait postgres
"${COMPOSE[@]}" stop botnote
gzip -dc "$file" | "${COMPOSE[@]}" exec -T postgres \
  psql -U botnote -d botnote -v ON_ERROR_STOP=1 --quiet --single-transaction >/dev/null
"${COMPOSE[@]}" up -d botnote
echo "restored $file; the daemon applies any newer migrations as it starts"
