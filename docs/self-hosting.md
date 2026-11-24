# Self-hosting botnote

One Compose file runs the whole thing: the daemon (REST API, MCP endpoint, web
UI) and a Postgres with pgvector. The same file covers two setups:

- **One machine.** The daemon listens on `127.0.0.1` only. No domain, no
  password, no token.
- **Networked.** The daemon sits behind HTTPS on your own domain. Other
  devices and their agents connect with the URL and an API token.

## Requirements

- Docker with Compose v2.20 or newer.
- 1 vCPU, 1 GB RAM and a few GB of disk are enough for one person or a small
  team. The daemon settles around 100 MB and Postgres around 100 MB with ten
  thousand items. On a 1 GB host add 1–2 GB of swap for migrations and dumps.
- An OpenAI API key is optional. With it search is hybrid (keyword +
  semantic); without it search is keyword-only.

## One machine

```bash
curl -fsSLO https://raw.githubusercontent.com/botnote-dev/botnote/main/docker-compose.yml
docker compose up -d
```

Open <http://127.0.0.1:4280>. Agents on this machine use the same address and
need no token:

```bash
npm i -g botnote && botnote login          # accept the default URL
claude mcp add --transport http botnote http://127.0.0.1:4280/mcp
```

The port is published on `127.0.0.1` only, so nothing outside the machine can
reach it. That, not a credential, is what protects this setup; do not change
`BOTNOTE_BIND` to `0.0.0.0` without also setting a password.

## Networked, on your own domain

1. Point a DNS record for your host name (say `notes.example.com`) at the
   server and open ports 80 and 443.
2. Put the settings next to `docker-compose.yml`:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/botnote-dev/botnote/main/.env.example -o .env
   ```

   ```dotenv
   BOTNOTE_VERSION=0.3.0
   BOTNOTE_PUBLIC_URL=https://notes.example.com
   BOTNOTE_DOMAIN=notes.example.com
   BOTNOTE_PASSWORD=<a long random password>
   POSTGRES_PASSWORD=<letters and digits>
   OPENAI_API_KEY=<optional>
   ```

3. Start it with the bundled Caddy, which obtains and renews the certificate:

   ```bash
   docker compose --profile caddy up -d
   ```

4. Open `https://notes.example.com`, log in with the password, and create one
   API token per device under Settings → API tokens.

The daemon refuses to start when `BOTNOTE_PUBLIC_URL` names a public address
and no password is set. `BOTNOTE_REQUIRE_AUTH=0` overrides that for a private
network such as a tailnet.

### Connecting agents from other devices

| Client | How |
|--------|-----|
| Claude Code plugin | `/plugin install botnote@botnote`, then `botnote_url` = `https://notes.example.com` and `botnote_token` = the token |
| Claude Code, MCP only | `claude mcp add --transport http botnote https://notes.example.com/mcp --header "Authorization: Bearer <token>"` |
| Codex, Cursor, terminal | `npm i -g botnote && botnote login`, enter the URL and token |
| claude.ai, Claude Desktop | custom connector, URL `https://notes.example.com/mcp`, the same `Authorization` header |

### Using a proxy you already run

Skip the `caddy` profile and send your proxy to the daemon instead.

- **nginx, Caddy or Cloudflare Tunnel on the same host:** forward to
  `http://127.0.0.1:4280`.
- **Traefik, Coolify, Dokploy and other Docker-network proxies:** route the
  host name to the `botnote` service, port `4280`. In Coolify, add the stack as
  a Docker Compose resource and set the domain on the `botnote` service as
  `https://notes.example.com:4280`.
- **Cloudflare in front of the proxy (orange cloud):** set
  `BOTNOTE_CLIENT_IP_HEADER=cf-connecting-ip`, so rate limiting sees visitors
  rather than Cloudflare's addresses.

Inside a container every request arrives from a private Docker address, so the
"no token on the daemon's own machine" shortcut never applies to proxied
traffic: once a password is set, every request needs the session cookie or a
token.

## Your own Postgres

Any Postgres 16+ with the `vector` extension available works, including
managed ones. Set `DATABASE_URL` in `.env` and add the override file, which
turns the bundled database off:

```bash
curl -fsSLO https://raw.githubusercontent.com/botnote-dev/botnote/main/docker-compose.external-db.yml
docker compose -f docker-compose.yml -f docker-compose.external-db.yml up -d
```

The daemon creates the extension and the schema on first start, so the
database user needs permission to run `CREATE EXTENSION vector`.

## Upgrading

Pin a version in `.env` and change it to upgrade:

```bash
# .env: BOTNOTE_VERSION=0.3.1
docker compose pull && docker compose up -d
```

Migrations run when the daemon starts. They only ever add to the schema, so
going back to the previous version (set the old `BOTNOTE_VERSION`, `up -d`)
works without touching the database. Take a backup first all the same.

### Redeploying from CI

A fork that publishes its own image can redeploy its host after every release.
The `Publish image` workflow calls a webhook with `POST` and a bearer token
when both repository secrets are set: `DEPLOY_WEBHOOK_URL` and
`DEPLOY_WEBHOOK_TOKEN`. Running the workflow by hand with `deploy` ticked calls
the same webhook without a release.

The URL has to make the host pull the image, not only restart. On Coolify the
"Deploy webhook" shown for a Compose service (`/api/v1/deploy?uuid=...`)
restarts with the image already on disk, with or without `force=true`. Use
`/api/v1/services/<uuid>/restart?latest=true` instead.

## Backup and restore

The database is the only state. Two scripts in the repository's `scripts/`
directory wrap `pg_dump` and `psql` for the bundled Postgres; run them from the
directory that holds `docker-compose.yml`.

```bash
scripts/backup.sh                                   # → backups/botnote-<utc time>.sql.gz
scripts/restore.sh backups/botnote-<utc time>.sql.gz
```

`backup.sh` keeps the newest 14 dumps (`BACKUP_KEEP`) and, when
`BACKUP_S3_URI` is set, copies each one to S3-compatible storage with the `aws`
CLI (`AWS_ENDPOINT_URL` selects Cloudflare R2 and the like). A cron line is
enough to schedule it:

```cron
0 3 * * * cd /opt/botnote && scripts/backup.sh >> backups/backup.log 2>&1
```

`restore.sh` replaces everything in the target database, which is also how
you move to another server: start the stack there, copy a dump over, restore.
Dumps contain API tokens, so store them like secrets.

For moving data between instances without database access, see `botnote
export` / `botnote import` in the README.

## Settings

| Variable | Default | Meaning |
|----------|---------|---------|
| `BOTNOTE_VERSION` | `latest` | Image tag |
| `BOTNOTE_PUBLIC_URL` | unset | Public address; requires a password |
| `BOTNOTE_PASSWORD` | unset | Web login; turns auth on |
| `BOTNOTE_DOMAIN` | unset | Host name served by the bundled Caddy |
| `POSTGRES_PASSWORD` | `botnote` | Bundled database password, set before first start |
| `DATABASE_URL` | bundled database | External Postgres |
| `OPENAI_API_KEY` | unset | Enables semantic search |
| `BOTNOTE_CLIENT_IP_HEADER` | `x-forwarded-for` | `cf-connecting-ip` behind Cloudflare |
| `BOTNOTE_BIND` / `BOTNOTE_PORT` | `127.0.0.1` / `4280` | Host address and port the daemon is published on |

## Building the image yourself

```bash
git clone https://github.com/botnote-dev/botnote && cd botnote
docker build -t ghcr.io/botnote-dev/botnote-server:local .
BOTNOTE_VERSION=local docker compose up -d
```
