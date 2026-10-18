# Deployment — botnote.net

How the public site at <https://botnote.net> is served, and how to ship new
code to it. The whole stack runs on this Mac (macOS / launchd); there is no
remote server.

> Secrets (daemon password, database URL) live **only** in the launchd plist
> `~/Library/LaunchAgents/com.botnote.daemon.plist`. Never copy their real
> values into this repo.

## Architecture

```
Internet
   │  https://botnote.net
   ▼
Cloudflare Tunnel  (cloudflared, tunnel "botnote" = 8e0fbf02-7774-428c-8bcf-806faac8c385)
   │  ingress: botnote.net → http://localhost:4280
   ▼
botnote daemon  (npm botnote-server: node dist/cli.js, port 4280)
   ├─ REST API           (Fastify)
   ├─ static web UI      (@fastify/static, served from web/dist)
   └─ migrations on boot (src/cli.ts → migrate())
   │
   ▼
Postgres  (127.0.0.1:55434, database "botnote")
```

The tunnel config is `~/.cloudflared/config.yml`. It also maps
`finance.botnote.net → localhost:8080`, which is a **separate** app (not
botnote). Anything else returns 404.

## Processes (launchd user agents)

All four are in `~/Library/LaunchAgents/`. Check state with
`launchctl list | grep -iE 'botnote|cloudflared'`.

| Label | What it runs | When |
|-------|--------------|------|
| `com.botnote.daemon` | `node /Users/jianhua/botnote/dist/cli.js` (port 4280) | RunAtLoad + KeepAlive |
| `com.cloudflared.botnote` | `cloudflared tunnel --config ~/.cloudflared/config.yml run botnote` | RunAtLoad + KeepAlive |
| `com.botnote.backup` | `/Users/jianhua/botnote-backups/backup.sh` | daily 03:00 |
| `com.botnote.logrotate` | `~/.cloudflared/rotate-logs.sh` | daily 03:05 |

### Daemon config (set as env in `com.botnote.daemon.plist`)

| Var | Value |
|-----|-------|
| `BOTNOTE_HOST` | `0.0.0.0` |
| `BOTNOTE_PORT` | `4280` |
| `BOTNOTE_REQUIRE_AUTH` | `1` |
| `BOTNOTE_PASSWORD` | *(secret — in plist)* |
| `BOTNOTE_TRUST_PROXY` | unset = `loopback` (cloudflared connects from 127.0.0.1) |
| `BOTNOTE_TRUST_LOCALHOST` | unset = `1` (local CLI needs no token) |
| `BOTNOTE_PUBLIC_URL` | `https://botnote.net` (adds the public origin to the CORS allowlist; loopback is always allowed) |
| `DATABASE_URL` | `postgres://botnote:***@127.0.0.1:55434/botnote` *(password in plist)* |
| `NODE_ENV` | `production` |
| `WorkingDirectory` | `/Users/jianhua/botnote` |

Node binary: `/opt/homebrew/bin/node` (Homebrew symlink, so `brew upgrade node`
keeps it valid). If `launchctl list` shows exit code `78` for the daemon, the
node path in `ProgramArguments` no longer exists — fix it, then reload the plist
(see Operations).
Daemon logs: `~/Library/Logs/botnote-daemon.log` (+ `.err.log`).
Tunnel logs: `~/.cloudflared/stderr.log`.

## Two checkouts: production and dev

`/Users/jianhua/botnote` is what launchd runs. It must always sit on a released
tag with a clean tree, because `pnpm build` there is the deploy. Development
happens in a separate git worktree so half-written code never ends up in the
directory the daemon serves from:

```bash
git -C /Users/jianhua/botnote worktree add ../botnote-dev -b <branch> main
cd /Users/jianhua/botnote-dev && pnpm install && pnpm --dir web install
```

Cycle for every change: branch in `botnote-dev` → PR → CI green → merge →
`pnpm version patch` + `git push --follow-tags` (see docs/releasing.md) →
deploy the tag with the script below. This instance is the only test
environment, so keep changes small and ship them the day they merge.

## Deploy a new version

```bash
scripts/deploy.sh --status      # live version, checked-out ref, pending migrations
scripts/deploy.sh v0.1.52       # deploy a tag
scripts/deploy.sh --rollback    # redeploy the tag that was live before
```

`scripts/deploy.sh <tag>` works on `/Users/jianhua/botnote` and:

1. refuses if the tree has local modifications or the tag's `package.json`
   version does not match the tag;
2. lists migration files in the tag that are not yet in `_migrations`, and if
   there are any takes a `pg_dump` into `~/botnote-backups/recovery/` first;
3. checks out the tag (detached), runs `pnpm install --frozen-lockfile` only
   when a lockfile changed, runs `pnpm build`;
4. if the global `botnote` CLI (`$(npm root -g)/botnote`) is a link into this
   checkout, points it at `packages/cli/` (or at the root for tags before the
   v0.2.17 package split), so the `botnote` command on this Mac always runs the
   deployed version;
5. `launchctl kickstart -k` the daemon and waits until `/health` reports the
   new version (40 s budget), then appends a line to `~/.botnote/deploy-history`.

`--rollback` redeploys the previous tag from that history. Schema is not
rolled back: migrations are expand-only (new columns with defaults, new
indexes, `IF NOT EXISTS`), so the previous release keeps working on the newer
schema. That is the rule that makes rollback safe; do not write a migration
that breaks it.

`pnpm build` = `pnpm clean && pnpm --dir web build && pnpm build:server && pnpm build:cli`.
The web build runs `tsc -b`, so it fails on type errors anywhere in `web/`.

The production checkout serves the daemon from the repo root
(`dist/cli.js`); the `botnote` CLI on this Mac runs from
`packages/cli/dist/bin.js` through the global link above. Set it up once with
`npm link` inside `/Users/jianhua/botnote/packages/cli` if it is missing.

The Cloudflare tunnel does **not** need restarting for a code deploy; it only
proxies to port 4280.

## Rehearse a migration before deploying it

Any release that adds a file under `src/db/migrations/` gets rehearsed on a
copy of production first. From the dev worktree:

```bash
scripts/verify-migration.sh            # dump prod → restore into botnote_staging → migrate → diff
scripts/verify-migration.sh --serve    # also boot dist/cli.js on :4281 against staging and hit /health
scripts/verify-migration.sh ~/botnote-backups/daily/botnote-2026-10-13.sql.gz   # from an existing dump
```

The script snapshots `scripts/invariants.sql` (row counts per table, counts
per kind/status, max KEY-SEQ per project, duplicate sequence ids, edges per
kind, recurrence totals, body bytes) before and after running the migrations
of the current checkout, and fails on any difference. A data-repair migration
that is supposed to change a metric declares it:

```bash
ALLOW_CHANGED="entities_self_parent edges_self" scripts/verify-migration.sh
```

It only ever passes the staging URL to the migration runner; the production
database is read with `pg_dump` and nothing else. The staging daemon inherits
the embedding settings stored in the database copy, so keep that smoke test
read-only.

## Operations

```bash
# Status
launchctl list | grep -iE 'botnote|cloudflared'

# Restart daemon / tunnel
launchctl kickstart -k gui/$(id -u)/com.botnote.daemon
launchctl kickstart -k gui/$(id -u)/com.cloudflared.botnote

# Stop / start the daemon
launchctl bootout   gui/$(id -u)/com.botnote.daemon
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.botnote.daemon.plist

# Tail logs
tail -f ~/Library/Logs/botnote-daemon.log
tail -f ~/.cloudflared/stderr.log

# Reload after editing a plist
launchctl bootout   gui/$(id -u)/com.botnote.daemon
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.botnote.daemon.plist
```

## Database & backups

- Postgres listens on `127.0.0.1:55434`, database `botnote`.
- Schema is applied by the migration runner on every daemon start
  (`src/db/migrate.ts`, tracked in the `_migrations` table). Manual run:
  `pnpm db:migrate`.
- Nightly dump via `com.botnote.backup` → `/Users/jianhua/botnote-backups/`
  (logs: `launchd.out` / `launchd.err` there).
