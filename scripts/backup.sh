#!/usr/bin/env bash
# Dump the bundled Postgres of a Compose deployment to a gzipped SQL file.
# Run from the directory that holds docker-compose.yml:
#
#   scripts/backup.sh                 # writes ./backups/botnote-<utc time>.sql.gz
#
#   BACKUP_DIR       where dumps go (default ./backups)
#   BACKUP_KEEP      how many local dumps to keep (default 14)
#   BACKUP_S3_URI    also copy the dump there with the aws CLI, for example
#                    s3://my-bucket/botnote. For Cloudflare R2 and other
#                    S3-compatible stores set AWS_ENDPOINT_URL as well.
#   BOTNOTE_COMPOSE  compose command (default "docker compose")
set -euo pipefail

read -r -a COMPOSE <<<"${BOTNOTE_COMPOSE:-docker compose}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"

mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/botnote-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
tmp="$file.partial"
trap 'rm -f "$tmp"' EXIT

"${COMPOSE[@]}" exec -T postgres \
  pg_dump -U botnote -d botnote --clean --if-exists --no-owner --no-privileges \
  | gzip >"$tmp"
gzip -t "$tmp"
if [ "$(gzip -dc "$tmp" | head -c 2048 | grep -c 'PostgreSQL database dump')" -eq 0 ]; then
  echo "backup failed: $tmp is not a Postgres dump" >&2
  exit 1
fi
mv "$tmp" "$file"
echo "wrote $file ($(wc -c <"$file" | tr -d ' ') bytes)"

if [ -n "${BACKUP_S3_URI:-}" ]; then
  aws s3 cp --only-show-errors "$file" "${BACKUP_S3_URI%/}/$(basename "$file")"
  echo "uploaded to ${BACKUP_S3_URI%/}/$(basename "$file")"
fi

ls -1t "$BACKUP_DIR"/botnote-*.sql.gz 2>/dev/null | tail -n "+$((BACKUP_KEEP + 1))" | while read -r old; do
  rm -f "$old"
  echo "pruned $old"
done
