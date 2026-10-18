# botnote

Notion for bots. A single binary that stores projects, tasks, notes, and agent memory — and exposes them to AI agents via MCP and REST.

## Why

Agents work best with one stable, queryable, write-friendly source of truth — not a stack of Notion + Jira + Slack + scratch files. botnote is that source of truth, scoped to one user, deployable in 60 seconds.

Three things only:

1. **Project management** — projects and tasks with status, priority, due dates, and stable identifiers.
2. **Note-taking** — free-form Markdown notes, tagged, searchable, and optionally pinned.
3. **Memory for agents** — hybrid retrieval (BM25 + vector + time decay), opening brief auto-bundles AGENTS.md + recent context.

## Design

- Storage: Postgres + pgvector + tsvector. Single dedicated docker container.
- Single multi-kind entity table — `task / note` discriminated by `kind` column.
- Search: hybrid retrieval — tsvector BM25 + pgvector cosine + time decay, merged via Reciprocal Rank Fusion (k=60).
- Embeddings: OpenAI `text-embedding-3-small` at 384 dimensions, written asynchronously. Falls back to BM25-only if no API key.
- API: MCP server (stdio) + REST API (Fastify on `:4280`) over a shared service layer.
- Every write records `actorKind` (human / agent / system); `idempotencyKey` is supported on writes.
- All MCP tools carry `2025-03-26` annotations: `readOnlyHint`, `idempotentHint`, `destructiveHint`, `openWorldHint`.

## Quick start

Requires: Node 20+, pnpm, Docker.

### CLI install

On client machines, install the portable CLI from npm:

```bash
npm i -g botnote
botnote login
```

`botnote login` stores the daemon URL and bearer token in
`~/.config/botnote/config.json`. The default URL is `http://127.0.0.1:4280`, the
daemon on the same machine, which needs no token. From another machine enter
your instance's URL (for example `https://botnote.example.com`) plus a token
from Settings -> API tokens. Every client surface (CLI, MCP server, plugins)
shares that one default; nothing ever falls back to a third-party host. New API tokens remain copyable from Settings; tokens
created before recoverable storage was added only show their prefix and should
be regenerated if the full value was lost.

Security note: newly-created API tokens are stored recoverably in the database
so Settings can copy them later. Treat the database and backups as
secret-bearing material, and revoke tokens if either is exposed.

### Authentication

Auth is enforced when `BOTNOTE_REQUIRE_AUTH=1`, or when `BOTNOTE_PASSWORD` is
set and the flag is left unset. Every `/v1/*` request then needs a bearer token
(`Authorization: Bearer bn_...`) or the session cookie from the web login. The
one exception is a direct connection from the daemon host itself: loopback
callers need no token, so the local CLI and plugins keep working with zero
config. The decision is made on the TCP peer address, never on headers, so
binding `BOTNOTE_HOST=0.0.0.0` on a LAN or VPS does not open the API.

| Var | Default | Meaning |
|-----|---------|---------|
| `BOTNOTE_REQUIRE_AUTH` | `1` if `BOTNOTE_PASSWORD` is set, else `0` | Enforce cookie/bearer on `/v1/*` |
| `BOTNOTE_TRUST_LOCALHOST` | `1` | `0` makes loopback callers present a credential too |
| `BOTNOTE_TRUST_PROXY` | `loopback` | Peers whose `x-forwarded-for` / `cf-connecting-ip` are believed: `loopback`, an IP, or an IPv4 CIDR, comma-separated |

Behind Cloudflare Tunnel, nginx or Caddy on the same host the defaults are
right. If the proxy runs on another machine, list its address in
`BOTNOTE_TRUST_PROXY`; otherwise its forwarded headers are ignored and rate
limiting keys on the proxy itself.

The Claude Code, Codex, and Cursor plugins call `botnote mcp`, so installing
the npm package is enough for plugin runtime on machines that do not have a
botnote source checkout.

### CLI commands

Read:

```bash
botnote projects            # all projects
botnote today               # today + overdue
botnote tasks --status open
botnote search "backup policy"
```

Write — every command takes a `KEY-SEQ` identifier (`OPS-12`, case-insensitive)
or a UUID:

```bash
botnote task "Rotate the staging certs" --project OPS --due 2026-10-01
botnote note "Staging certs expire yearly on Oct 1" --project OPS --pin

botnote update OPS-12 --status in_progress --priority high
botnote update OPS-12 --due 2026-10-08     # or --due none to clear it
botnote update OPS-12 --title "..." --project INFRA --tags certs,staging

botnote worklog OPS-12 "Renewed staging, prod still pending"
botnote done OPS-12 --worklog "Both environments renewed"
```

`--status` accepts `open`, `in_progress`, `done`, `rejected`; `--priority`
accepts `urgent`, `high`, `medium`, `low`, `none`. A date-only `--due` is
stored at noon UTC so it reads as the same day in every timezone.

### Local daemon development

```bash
# 1. Spin up postgres (port 55434, pgvector extension)
docker compose up -d

# 2. Install deps
pnpm install

# 3. Apply schema
DATABASE_URL=postgres://botnote:botnote@127.0.0.1:55434/botnote pnpm db:migrate

# 4. Boot REST + Swagger UI
DATABASE_URL=postgres://botnote:botnote@127.0.0.1:55434/botnote pnpm dev
```

Then:

- REST API: <http://localhost:4280>
- Swagger UI: <http://localhost:4280/docs>
- OpenAPI JSON: <http://localhost:4280/docs/json>

Embeddings are optional. Set `OPENAI_API_KEY` to enable hybrid (BM25 + cosine) search; without it, search is BM25-only.

### Tests

Tests must run against a disposable database whose name contains `test`. The
helper refuses any other database name so local test runs do not touch a live
botnote instance.

```bash
docker compose up -d
docker exec botnote-postgres createdb -U botnote botnote_test || true

DATABASE_URL=postgres://botnote:botnote@127.0.0.1:55434/botnote_test pnpm db:migrate
BOTNOTE_TEST_DATABASE_URL=postgres://botnote:botnote@127.0.0.1:55434/botnote_test pnpm test
```

### Releasing

Releases publish from CI. Bump the version and push the tag:

```bash
pnpm version patch -m "Release %s"   # bumps package.json + every plugin manifest, commits, tags
git push --follow-tags
```

The `v*` tag triggers `.github/workflows/publish-npm.yml`, which typechecks,
runs the full test suite, builds, and publishes to npm through OIDC trusted
publishing. No npm token is involved, and `npm publish` should never be run
from a developer machine — a local publish will fail, and npm reports that
failure as a misleading `404 Not Found - PUT`.

Check a release with `gh run list --workflow=publish-npm.yml` and
`npm view botnote version`. The registry manifest updates a few minutes before
the tarball finishes reaching the CDN, so a brief `npx botnote@<version>` 404
right after a successful publish is expected.

Updating the daemon on a host is separate from releasing:

```bash
pnpm build && launchctl kickstart -k gui/$(id -u)/com.botnote.daemon
```

## REST endpoints

Project status values are `planned`, `active`, `watching`, `paused`, and
`archived`. `archivedAt` records when a project entered the archived status.

| method | path | summary |
|---|---|---|
| `POST` | `/v1/projects` | Create project |
| `GET` | `/v1/projects` | List non-archived projects (`?includeArchived=true` includes archived) |
| `GET` | `/v1/projects/:id` | Fetch project |
| `PATCH` | `/v1/projects/:id` | Update project status or metadata |
| `GET` | `/v1/projects/by-key/:key` | Fetch by key |
| `POST` | `/v1/projects/:id/opening-brief` | Opening brief |
| `POST` | `/v1/opening-brief` | Workspace or project opening brief |
| `POST` | `/v1/tasks` | Create task |
| `POST` | `/v1/tasks/:id/recurrence` | Configure task recurrence |
| `GET` | `/v1/tasks/:id/recurrence` | Fetch task recurrence |
| `PATCH` | `/v1/recurrences/:id` | Update recurrence rule |
| `POST` | `/v1/tasks/:id/skip-occurrence` | Skip current recurring occurrence |
| `POST` | `/v1/recurrences/:id/stop` | Stop recurrence series |
| `POST` | `/v1/notes` | Create note |
| `GET` | `/v1/entities/:id` | Fetch entity |
| `GET` | `/v1/projects/by-key/:key/entities/by-seq/:seq` | Fetch entity by identifier (e.g. `DEMO-12`) |
| `PATCH` | `/v1/entities/:id` | Update entity |
| `DELETE` | `/v1/entities/:id` | Delete entity |
| `GET` | `/v1/entities/:id/related` | List related entities |
| `POST` | `/v1/entities/:id/links` | Link entity to another |
| `POST` | `/v1/recent` | Recent activity |
| `POST` | `/v1/search` | Hybrid search |
| `POST` | `/v1/tasks/range` | Scheduled, overdue, and backlog tasks |
| `GET` | `/v1/settings/embedding` | Embedding provider/model/key status + vector coverage |
| `PATCH` | `/v1/settings/embedding` | Update embedding provider/model/key settings |
| `POST` | `/v1/settings/embedding/backfill` | Queue missing embeddings for existing rows |
| `GET` | `/v1/tokens` | List API tokens |
| `POST` | `/v1/tokens` | Create API token |
| `DELETE` | `/v1/tokens/:id` | Revoke API token |
| `GET` | `/v1/export` | Stream the workspace as JSON Lines (`?vectors=1` includes embeddings) |
| `POST` | `/v1/import` | Load a JSON Lines dump (`content-type: application/x-ndjson`); returns an import report |
| `POST` | `/v1/auth/login` | Master-password login; sets httpOnly session cookie |
| `POST` | `/v1/auth/logout` | Clear session cookie and revoke the session |
| `GET` | `/v1/auth/whoami` | Confirm auth state and how the caller authenticated |
| `GET` | `/health` | Health check |

Schemas: see `/docs` (Swagger UI) or `/docs/json` (OpenAPI 3).

### Example: create a project + write a task + search

```bash
A=http://localhost:4280

PID=$(curl -s -X POST $A/v1/projects \
  -H 'content-type: application/json' \
  -d '{"key":"DEMO","name":"Demo","agentsMd":"ALWAYS run tests"}' \
  | jq -r .id)

curl -s -X POST $A/v1/tasks \
  -H 'content-type: application/json' \
  -d "{\"projectId\":\"$PID\",\"title\":\"Ship botnote v1\",\"actorKind\":\"human\"}"

curl -s -X POST $A/v1/search \
  -H 'content-type: application/json' \
  -d "{\"query\":\"ship\",\"projectId\":\"$PID\"}"
```

### Recurring tasks

Recurring tasks are normal task rows plus a recurrence rule. Configure a first
dated task, then attach a rule. Completing the current occurrence generates the
next occurrence idempotently.

Scheduled recurrences are also materialized by the REST daemon through the end
of the current day at startup and on a short background interval, so daily
tasks and fixed meetings appear even when nobody opens the calendar first.
Future occurrences beyond today are not pre-created; calendar previews should
stay virtual so sequence numbers are only assigned to real task rows.

```bash
botnote task "Attend weekly lab meeting" \
  --project LAB \
  --due 2026-06-26 \
  --repeat weekly \
  --on FR \
  --anchor scheduled

botnote task "Review backups" \
  --project OPS \
  --due 2026-06-26 \
  --repeat monthly \
  --anchor completion

botnote recurrence OPS-12
botnote skip OPS-12 --reason "holiday"
botnote stop-recurrence OPS-12
```

Use `scheduled` for calendar-like events, meetings, and fixed routines. Use
`completion` for maintenance work where the next due date should be calculated
from when the previous occurrence was actually completed.

## Your data

Everything in a workspace can leave as one JSON Lines file and come back
without loss: UUIDs, `KEY-SEQ` numbers, timestamps, who wrote what, links
between items, recurrence rules, edit history and the trash.

```bash
botnote export --out backup.jsonl        # projects, entities, edges, rules, history, settings
botnote export --vectors --out full.jsonl  # also the embeddings (large; skipped by default)
botnote import backup.jsonl              # into the daemon that `botnote whoami` points at
```

The first line is a header (`formatVersion`, `botnoteVersion`, `exportedAt`,
source workspace); every other line is one record whose `type` names its
table. Records are written in dependency order, so both commands stream and
never hold the whole dump in memory.

Importing is idempotent: a record whose id already exists is skipped, so a
partial import can be re-run. Rows owned by another workspace, projects whose
key is already taken, or children whose parent is missing are reported as
conflicts and left out instead of aborting the import (the CLI exits 3 when
there were any). Entities that arrive without a vector are re-embedded in the
background. API tokens and the embedding API key are never exported.

## Plugin

The plugin bundles the MCP server, workflow skills/commands, and a curator
subagent. All workflows route through MCP, so no separate task or memory MCP
setup is required.

Prefer the plugin installs below: they bundle MCP wiring (URL/token prompts)
and skills in one step. The skills CLI at the end of this section is a
skills-only fallback for agents without a plugin system.

### Claude Code

```text
# In Claude Code
/plugin marketplace add botnote-dev/botnote
/plugin install botnote@botnote

# Claude Code will prompt for:
#   botnote_url    -> leave empty on the daemon host (http://127.0.0.1:4280);
#                     elsewhere your instance URL, e.g. https://botnote.example.com
#   botnote_token  -> bearer from Settings -> API tokens; skip on loopback
```

Slash commands:

```text
/botnote:today              # today + overdue
/botnote:remember "..."     # capture a note via MCP
/botnote:recall "..."       # hybrid search
/botnote:start-work DEMO-12 # pick up a task with project context
/botnote:done               # mark current focus done
/botnote:add-task "..."     # capture a task without starting it
/botnote:show-todo          # workspace task/context summary
```

Plugin distribution lives at
[botnote-dev/botnote](https://github.com/botnote-dev/botnote). The MCP server
inside the plugin uses the URL + token from the install prompt. A global
`botnote` CLI install is optional: the plugin runs `npx -y botnote@<plugin-version> mcp`
when no matching local CLI is available.

### Codex

Add the plugin through `/settings -> plugin` in Codex, or add this marketplace
from the public repository without a full source checkout:

```bash
codex plugin marketplace add https://github.com/botnote-dev/botnote.git \
  --sparse .agents/plugins \
  --sparse plugins/botnote

codex plugin add botnote@botnote-plugins
```

The sparse checkout must include `.agents/plugins`, because Codex discovers the
marketplace manifest from `.agents/plugins/marketplace.json`.

For local plugin development, add this marketplace entry to
`.agents/plugins/marketplace.json` in the repo:

```json
{
  "name": "botnote-plugins",
  "interface": { "displayName": "botnote Plugins" },
  "plugins": [
    {
      "name": "botnote",
      "source": { "source": "local", "path": "./plugins/botnote" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

Then install/enable from the Codex plugin UI, or use:

```bash
codex plugin marketplace add .
codex plugin add botnote@botnote-plugins
```

For synced Codex settings, include this in `~/.codex/config.toml` or the
rendered config template:

```toml
[plugins."botnote@botnote-plugins"]
enabled = true

[marketplaces.botnote-plugins]
source_type = "local"
source = "/absolute/path/to/botnote"
```

The Codex plugin starts `./scripts/run-mcp.sh`. It reads
`~/.config/botnote/config.json` when available, otherwise leaves the URL to the
CLI default (`http://127.0.0.1:4280`), uses a matching `botnote` CLI from PATH
when present, and otherwise runs the exact plugin version with
`npx -y botnote@<plugin-version> mcp`. Set `BOTNOTE_URL` and `BOTNOTE_TOKEN`
when the daemon runs on another machine.

### Cursor

Cursor-compatible plugin metadata lives in `.cursor-plugin/marketplace.json`.
The marketplace points at the same `plugins/botnote` bundle, so Cursor gets the
same MCP server and workflow skills without a second plugin implementation.

```bash
# Marketplace root for Cursor plugin clients:
https://github.com/botnote-dev/botnote
```

The Cursor plugin manifest is `plugins/botnote/.cursor-plugin/plugin.json` and
uses the same `botnote_url` / `botnote_token` settings as the Claude Code
plugin.

### Skills-only fallback: skills CLI

For agents without a plugin system, the
[skills CLI](https://github.com/vercel-labs/skills) can install the workflow
skills into 70+ agents:

```bash
npx skills add botnote-dev/botnote   # install all 7 skills
npx skills update                     # refresh to the latest version later
npx skills list                       # see what is installed where
```

The skills CLI installs `SKILL.md` files only — it does not set up the botnote
MCP server the skills depend on.
Wire up the MCP server once per machine:

```bash
# Claude Code
claude mcp add botnote \
  -e BOTNOTE_URL=https://botnote.example.com \
  -e BOTNOTE_TOKEN=<token from Settings -> API tokens> \
  -- npx -y botnote mcp

# Codex
codex mcp add botnote \
  --env BOTNOTE_URL=https://botnote.example.com \
  --env BOTNOTE_TOKEN=<token> \
  -- npx -y botnote mcp
```

On the daemon host drop both env vars: the default is `http://127.0.0.1:4280`
and loopback needs no token.

### Known limitation: restart sessions after a plugin update

Plugin clients (Claude Code, Codex, Cursor) cache the plugin under a
version-numbered directory and delete the old one on update. A session that
was already running keeps pointing at the old paths, so its skills fail to
load and its MCP launcher may refuse to start until the session is restarted.
This is client cache behavior, not something the plugin can compensate for —
after updating the plugin, start a fresh session.

## MCP tools

botnote exposes the following tools + resources over stdio.

### Tools

| tool | annotations | what it does |
|---|---|---|
| `opening_brief` | `readOnly` | Project or workspace context bundle (AGENTS.md + pinned notes + open tasks + recent) |
| `search` | `readOnly` | Hybrid retrieval over tasks and notes |
| `recent` | `readOnly` | Recent activity, filterable |
| `list_projects` | `readOnly` | List non-archived projects (`includeArchived` includes archived) |
| `get_project` | `readOnly` | Fetch a project by UUID or key, including AGENTS.md |
| `create_project` | — | Create a project |
| `update_project` | `destructive idempotent` | Update project status, name, color, icon, or AGENTS.md |
| `get_entity` | `readOnly` | Fetch one task or note by UUID |
| `get_entity_by_key` | `readOnly` | Fetch one task or note by human-readable identifier, e.g. `DEMO-12` |
| `create_task` | `idempotent` | Create a structured task |
| `configure_recurrence` | `idempotent` | Attach or update a recurrence rule for a dated task |
| `get_recurrence` | `readOnly` | Read a task's recurrence rule and current series state |
| `skip_occurrence` | `destructive` | Skip the current recurring occurrence and advance the series |
| `stop_recurrence` | `destructive` | Disable future occurrences for a recurrence series |
| `remember` | `idempotent` | Create a free-form note |
| `update_entity` | `destructive` | Mutate task or note fields |
| `related` | `readOnly` | List child notes/tasks for an entity |
| `link` | `idempotent` | Create typed edge between entities |

### Resource

- `botnote://workspace` — workspace overview: project index + most recent activity (text/markdown).

### Direct MCP fallback

Plugin install is preferred. For a raw MCP client, build/install the CLI and
run:

```json
{
  "mcpServers": {
    "botnote": {
      "command": "botnote",
      "args": ["mcp"],
      "env": {
        "BOTNOTE_URL": "http://127.0.0.1:4280"
      }
    }
  }
}
```

## Per-project AGENTS.md

The whole point of botnote's `agents_md` field is to push project-level conventions into agents' working context without per-session prompt engineering.

Recommended structure (< 200 lines, imperative tone):

```markdown
## Critical
- NEVER commit .env or credentials.
- ALWAYS run `pnpm typecheck` before commit.

## Stack
- Node 20 + TypeScript ESM, pnpm.
- Postgres + drizzle ORM.

## Layout
- src/db/, src/service/, src/rest/, src/mcp/

## Rules
- Idempotent writes via `idempotency_key`.
- No console.log outside cli.ts.
```

Each MCP tool call inside a project should be preceded by `opening_brief({ projectId })` so the agent has AGENTS.md + recent context loaded.

## Status

Actively developed and self-hosted at <https://botnote.net>. The shipped
surface covers projects, tasks, and notes with hybrid search (BM25 + optional
vector embeddings), recurring tasks, a web UI (list / board / calendar views),
the REST API and MCP server documented above, and the editor plugin for Claude
Code, Codex, and Cursor. See `AGENTS.md` for codebase conventions and the `BOT`
project in botnote for ongoing work.

## License

MIT.
