#!/bin/bash
# Deploy a released tag to the production daemon on this Mac.
#
#   scripts/deploy.sh v0.1.52          deploy that tag
#   scripts/deploy.sh --rollback       redeploy the tag that was live before the last deploy
#   scripts/deploy.sh --status         show live version, checked-out ref, pending migrations
#
# Rules this script enforces:
#   - only annotated/lightweight tags are deployed, never a branch or a dirty tree
#   - when the tag ships new migration files, a pg_dump is taken first
#     (migrations are expand-only, so a rollback does not need to undo them,
#     but the dump is the last line of defence)
#   - the daemon must answer /health with the deployed version before we exit 0
#   - a global `botnote` CLI linked into this checkout follows the deployed tag
#
# Environment overrides (defaults match docs/deployment.md):
#   BOTNOTE_PROD_DIR   checkout launchd runs from     (/Users/jianhua/botnote)
#   BOTNOTE_PG_DOCKER  postgres container name        (botnote-postgres)
#   BOTNOTE_PG_DB      production database name       (botnote)
#   BOTNOTE_BACKUP_DIR where pre-deploy dumps go      (~/botnote-backups/recovery)
#   BOTNOTE_HEALTH_URL health endpoint                (http://127.0.0.1:4280/health)
#   BOTNOTE_LAUNCHD    launchd label                  (com.botnote.daemon)
set -euo pipefail

PROD_DIR="${BOTNOTE_PROD_DIR:-/Users/jianhua/botnote}"
PG_DOCKER="${BOTNOTE_PG_DOCKER:-botnote-postgres}"
PG_DB="${BOTNOTE_PG_DB:-botnote}"
BACKUP_DIR="${BOTNOTE_BACKUP_DIR:-$HOME/botnote-backups/recovery}"
HEALTH_URL="${BOTNOTE_HEALTH_URL:-http://127.0.0.1:4280/health}"
LAUNCHD_LABEL="${BOTNOTE_LAUNCHD:-com.botnote.daemon}"
STATE_DIR="$HOME/.botnote"
HISTORY_FILE="$STATE_DIR/deploy-history"

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[deploy] %s\033[0m\n' "$*" >&2; exit 1; }

docker_bin() {
  if command -v docker >/dev/null 2>&1; then command -v docker; else echo /usr/local/bin/docker; fi
}
DOCKER="$(docker_bin)"

live_version() {
  curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null | sed -nE 's/.*"version":"([^"]+)".*/\1/p'
}

checked_out_ref() {
  git -C "$PROD_DIR" describe --tags --exact-match 2>/dev/null \
    || git -C "$PROD_DIR" rev-parse --short HEAD
}

pending_migrations() {
  # Migration files in the given ref that are not yet recorded in _migrations.
  local ref="$1"
  local applied
  applied="$("$DOCKER" exec "$PG_DOCKER" psql -U botnote -d "$PG_DB" -Atc "SELECT name FROM _migrations" 2>/dev/null || true)"
  git -C "$PROD_DIR" ls-tree --name-only "$ref" -- src/db/migrations/ \
    | sed 's#.*/##' | grep '\.sql$' | sort | while read -r f; do
      grep -qx "$f" <<<"$applied" || echo "$f"
    done
}

cmd_status() {
  log "live version:     $(live_version || echo unreachable)"
  log "checked out:      $(checked_out_ref)"
  log "latest tag:       $(git -C "$PROD_DIR" tag --sort=-v:refname | head -1)"
  local pending
  pending="$(pending_migrations HEAD)"
  if [ -n "$pending" ]; then log "pending migrations at HEAD:"; printf '    %s\n' $pending; else log "pending migrations: none"; fi
  if [ -f "$HISTORY_FILE" ]; then log "deploy history (last 5):"; tail -5 "$HISTORY_FILE" | sed 's/^/    /'; fi
}

take_dump() {
  local tag="$1"
  mkdir -p "$BACKUP_DIR"
  local out="$BACKUP_DIR/pre-deploy-${tag}-$(date +%Y%m%d-%H%M%S).sql.gz"
  log "pre-deploy dump -> $out"
  "$DOCKER" exec "$PG_DOCKER" pg_dump -U botnote -d "$PG_DB" --clean --if-exists --no-owner --no-privileges \
    | gzip > "$out" || { rm -f "$out"; die "pg_dump failed; aborting deploy"; }
  log "dump size: $(stat -f %z "$out") bytes"
}

wait_healthy() {
  local want="$1" tries=0 got=""
  until [ "$tries" -ge 40 ]; do
    got="$(live_version || true)"
    [ "$got" = "$want" ] && return 0
    tries=$((tries + 1)); sleep 1
  done
  die "daemon did not report version $want within 40s (got '${got:-unreachable}'). Check ~/Library/Logs/botnote-daemon.err.log"
}

link_cli() {
  # `npm link` left $(npm root -g)/botnote pointing at this checkout. From v0.2.17
  # the CLI is packages/cli; older tags (rollbacks) still ship it at the root.
  local global_root link current prod want
  global_root="$(npm root -g 2>/dev/null)" || return 0
  link="$global_root/botnote"
  [ -L "$link" ] || return 0
  current="$(cd "$global_root" && cd "$(readlink "$link")" 2>/dev/null && pwd -P)" || return 0
  prod="$(cd "$PROD_DIR" && pwd -P)"
  [ "$current" = "$prod" ] || [ "$current" = "$prod/packages/cli" ] || return 0
  if [ -f "$prod/packages/cli/package.json" ]; then want="$prod/packages/cli"; else want="$prod"; fi
  [ "$current" = "$want" ] && return 0
  ln -sfn "$want" "$link"
  log "global botnote CLI now links to $want"
}

deploy_tag() {
  local tag="$1"
  [ -d "$PROD_DIR/.git" ] || die "$PROD_DIR is not a git checkout"
  cd "$PROD_DIR"

  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    die "working tree at $PROD_DIR has local modifications; production must track a tag exactly. Move the work to the dev worktree first."
  fi

  git fetch --tags --quiet origin
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "tag $tag not found (after git fetch --tags)"

  local pkg_version
  pkg_version="$(git show "$tag:package.json" | sed -nE 's/^  "version": "([^"]+)".*/\1/p')"
  [ "v$pkg_version" = "$tag" ] || die "tag $tag does not match package.json version $pkg_version"

  local previous
  previous="$(checked_out_ref)"
  local before_version
  before_version="$(live_version || echo unknown)"
  log "deploying $tag (currently checked out: $previous, live: $before_version)"

  local pending
  pending="$(pending_migrations "$tag")"
  if [ -n "$pending" ]; then
    log "tag ships migrations not yet applied:"; printf '    %s\n' $pending
    take_dump "$tag"
  else
    log "no new migrations in $tag"
  fi

  git checkout --quiet --detach "$tag"

  if ! git diff --quiet "$previous" "$tag" -- pnpm-lock.yaml web/pnpm-lock.yaml 2>/dev/null; then
    log "lockfile changed; installing dependencies"
    pnpm install --frozen-lockfile
    pnpm --dir web install --frozen-lockfile
  fi

  log "building"
  pnpm build
  link_cli

  log "restarting $LAUNCHD_LABEL"
  launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"
  wait_healthy "$pkg_version"

  mkdir -p "$STATE_DIR"
  printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$previous" "$tag" >> "$HISTORY_FILE"
  log "live: $(curl -fsS "$HEALTH_URL")"
  log "done: $previous -> $tag"
}

cmd_rollback() {
  [ -f "$HISTORY_FILE" ] || die "no deploy history at $HISTORY_FILE"
  local previous
  previous="$(tail -1 "$HISTORY_FILE" | cut -f2)"
  [ -n "$previous" ] || die "could not read previous ref from $HISTORY_FILE"
  git -C "$PROD_DIR" rev-parse -q --verify "refs/tags/$previous" >/dev/null \
    || die "previous ref '$previous' is not a tag; roll back by hand (git checkout <ref> && pnpm build && launchctl kickstart)"
  log "rolling back to $previous (schema stays at the newer migration level; migrations are expand-only)"
  deploy_tag "$previous"
}

case "${1:-}" in
  --status) cmd_status ;;
  --rollback) cmd_rollback ;;
  v[0-9]*) deploy_tag "$1" ;;
  *) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
