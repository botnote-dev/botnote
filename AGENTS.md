# AGENTS.md — botnote codebase

Imperative conventions for any agent working on the botnote codebase itself.
(This is NOT the per-project AGENTS.md that botnote stores for users — that
lives in the `projects.agents_md` column.)

## Critical

- NEVER commit `.env` or any file containing `OPENAI_API_KEY` or
  `DATABASE_URL` with real credentials.
- NEVER skip git hooks (`--no-verify`).
- ALWAYS run `pnpm typecheck` before committing.
- ALWAYS write idempotent migrations — `IF NOT EXISTS` on indexes,
  `CREATE OR REPLACE` on functions.

## Stack

- Node 20+, TypeScript ESM, pnpm
- Postgres 16+ + pgvector + tsvector, accessed via drizzle-orm + node-postgres
- Fastify 5 for REST, `@modelcontextprotocol/sdk` for MCP
- zod for runtime validation
- vitest for tests

## Layout

One repo, two npm packages (see `LICENSING.md`):

```
src/                # npm `botnote-server` (repo root package), AGPL-3.0-only
  db/               # drizzle schema + migrations + connection
  service/          # business logic — no transport, no IO besides db + openai
  rest/             # fastify routes — thin wrappers over service/
  cli.ts            # daemon entry point (bin `botnote-server`): REST + web + jobs
web/                # web UI served by the daemon, AGPL-3.0-only, own lockfile
packages/cli/       # npm `botnote`, MIT
  src/bin.ts        # `botnote` CLI; `serve` launches botnote-server
  src/mcp/          # MCP stdio server — an HTTP client of the REST API
plugins/botnote/    # Claude Code / Codex / Cursor plugin + skills, MIT
```

REST and MCP MUST share the service layer: MCP tools call the REST API, which
calls `src/service/`. Do not duplicate business logic in either transport.

NEVER import across the package boundary. `packages/cli/` must not import from
`src/` and `src/` must not import from `packages/cli/`; MIT code that pulls in
AGPL code stops being MIT-distributable. Shared constants (for example the
default port) are duplicated on purpose and pinned equal by a test.

## Schema rules

- `entities` is the single multi-kind table. Do not split per kind.
- Every write MUST set `actorKind` (agent | human | system).
- Every write MUST accept `idempotencyKey`. Re-writes with the same key
  return the existing record unchanged.
- `body_tsv` is a generated column from `body`. Do not write it directly.
- `body_vec` is populated async via the embedding worker. NULL is a valid
  intermediate state.

## Search rules

- Hybrid retrieval default: RRF over BM25 + cosine + time decay.
- Single-query latency target: < 50ms at 10k entities.
- If `OPENAI_API_KEY` missing, fall back to BM25-only. Log a warning.
  Never throw on missing embedding.

## MCP rules

- All tools MUST set MCP 2025-03-26 annotations
  (`readOnlyHint`, `idempotentHint`, `destructiveHint`, `openWorldHint`).
- Tool descriptions are agent-facing. Keep them imperative, < 3 sentences.
- Expose `opening_brief` as both a tool AND a resource. The resource is
  what gets auto-injected when an MCP client opens a session.

## Testing

- Every service operation needs a unit test for happy path + idempotency.
- Tests MUST use `BOTNOTE_TEST_DATABASE_URL`. Never run tests against a live
  database. The helper refuses database names that do not contain `test`.
- E2E smoke lives in `tests/e2e.test.ts`. Spawn the daemon against a throwaway
  Postgres database, exercise both REST and MCP transports, assert behavior
  matches.

## Releasing

Releases publish from CI, never from a developer machine.

```bash
pnpm version patch -m "Release %s"   # bumps both packages + all plugin manifests, commits, tags
git push --follow-tags               # the v* tag triggers the publish
```

Pushing a `v*` tag runs `.github/workflows/publish-npm.yml`, which typechecks,
runs the full test suite against a throwaway Postgres, builds, and publishes
`botnote` (packages/cli) and then `botnote-server` (repo root) to npm via
**OIDC trusted publishing** — no npm token anywhere in the pipeline. A package
whose version is already on npm is skipped, so a failed run can be re-run.

- NEVER run `npm publish` locally. Dev machines hold no npm publish credential
  and must not acquire one.
- A local publish failure is expected and means nothing. npm masks "not
  authorized to write this package" as `404 Not Found - PUT`, which reads like
  a missing package and invites a long wrong-way debugging detour into tokens,
  2FA, and package access policy. Do not take that bait.
- To check whether a release shipped, look at CI, not at local npm auth:

```bash
gh run list --workflow=publish-npm.yml --limit 5
npm view botnote version
npm view botnote-server version
```

- The registry manifest updates before the tarball finishes propagating to the
  CDN, so `npx botnote@<version>` can 404 for a few minutes after a successful
  publish. That is not a failed release.
- Deploying the daemon on the host is a separate step from releasing:
  `scripts/deploy.sh vX.Y.Z` (see `docs/deployment.md`).

## Style

- No comments unless WHY is non-obvious. Names carry meaning.
- No commented-out code. Delete or commit.
- No `console.log` outside the entry points (`src/cli.ts`, `packages/cli/src/bin.ts`).
  Use the fastify logger, or stderr in the MCP server.
- Errors: throw typed errors from service/, transports translate to
  HTTP status / MCP error codes.
