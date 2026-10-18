# Release — botnote (npm + plugins)

How to cut a new botnote release. Publishing is **CI-driven**: pushing a `v*`
tag makes GitHub Actions test, build, and publish to npm. You do the version
bump and push locally; CI does the publish.

One release publishes two npm packages from this repo, always at the same
version (see `LICENSING.md`):

| Package | Directory | License | Contents |
|---------|-----------|---------|----------|
| `botnote` | `packages/cli/` | MIT | CLI + MCP stdio server |
| `botnote-server` | repo root | AGPL-3.0-only | daemon, REST API, web UI |

> npm publish uses **OIDC trusted publishing** (`id-token: write` in
> `.github/workflows/publish-npm.yml`), so **no `NPM_TOKEN` is needed** — not in
> CI secrets, not in your `~/.npmrc`. A local `npm whoami` 401 is irrelevant.

## What a release contains

A release bumps one version number across both packages and every plugin manifest:

| File | Field(s) |
|------|----------|
| `package.json` | `version` |
| `packages/cli/package.json` | `version` |
| `.claude-plugin/marketplace.json` | `metadata.version`, `plugins[0].version` |
| `.cursor-plugin/marketplace.json` | `metadata.version`, `plugins[0].version` |
| `plugins/botnote/.claude-plugin/plugin.json` | `version` |
| `plugins/botnote/.codex-plugin/plugin.json` | `version` |
| `plugins/botnote/.cursor-plugin/plugin.json` | `version` |

`scripts/sync-plugin-versions.mjs` copies `package.json`'s version into
`packages/cli/package.json` and the five plugin manifests;
`scripts/check-plugin-versions.mjs` fails CI if any drift. Both run
automatically via the `version` lifecycle script (see below). Each package
reads its runtime `VERSION` from its own `package.json` at boot
(`src/version.ts`, `packages/cli/src/version.ts`).

## Cut a release

Working tree must be clean — `pnpm version` refuses a dirty tree. Run on `main`:

```bash
cd /Users/jianhua/botnote
git checkout main && git pull

# Bump: patch | minor | major. This runs the `version` lifecycle script
# (sync + check plugin versions, git-add them), commits "Release x.y.z",
# and creates the vx.y.z tag.
pnpm version patch -m "Release %s"

git push origin main          # → CI (ci.yml): typecheck, test, build
git push origin v0.1.28       # → publish (publish-npm.yml): same gates + npm publish
```

`pnpm bump:patch` / `bump:minor` / `bump:major` are shortcuts for
`pnpm version <level>`, but they don't set the commit message — pass
`-m "Release %s"` yourself to keep the `Release x.y.z` convention. Tags are
always `v<version>` (npm default).

## What CI does

Tag push `v*` → `.github/workflows/publish-npm.yml`:

1. spin up Postgres, install root + web deps
2. typecheck server + web
3. check plugin versions
4. migrate the test DB, run the full test suite
5. `pnpm build` (daemon, web UI and CLI)
6. publish `botnote` from `packages/cli/`, then `botnote-server` from the root
   (`npm publish --access public`, OIDC, no token)

The CLI goes first because the plugins launch it through `npx -y botnote@<version>`
as soon as the tagged manifests reach users. Each publish step skips a version
that is already on npm, so a run that failed halfway can simply be re-run
(**Actions → Publish npm → Re-run jobs**).

Branch push to `main` → `.github/workflows/ci.yml`: the same gates **minus**
publish.

Because publish runs the full test suite first, a broken commit fails CI and
**does not publish** — a release is safe to retry after a fix + new tag.

## Verify

```bash
gh run list  --repo botnote-dev/botnote --limit 5
gh run watch <run-id> --repo botnote-dev/botnote --exit-status
npm view botnote version          # should show the new version
npm view botnote-server version   # same version
```

Plugins resolve the MCP server via `npx -y botnote@<version> mcp` (or a matching
`botnote` on `PATH`), so users pick up the new version automatically once npm
shows it.

## First `botnote-server` publish (one time)

Releases up to v0.2.16 shipped the daemon inside `botnote`. `botnote-server` is
a new npm package, and npm can only attach an OIDC trusted publisher to a
package that already exists. Before the first release after the split, a
maintainer (never an agent) must:

1. create `botnote-server` on npm with a first publish of the release tag;
2. on npmjs.com → `botnote-server` → Settings → Trusted publishing, add GitHub
   Actions with repository `botnote-dev/botnote` and workflow `publish-npm.yml`,
   the same settings `botnote` uses;
3. re-run the tag's Publish npm workflow if it failed on `botnote-server`.

After that every release publishes both packages from CI with no token.

## Releasing while `main` has uncommitted WIP

`pnpm version` needs a clean tree. If `main` holds work you don't want to ship,
cut the release from a clean worktree and fast-forward `main`:

```bash
# In a clean worktree sitting at the same commit as main:
pnpm version patch -m "Release %s"                  # commit + tag here

git -C /Users/jianhua/botnote merge --ff-only <branch>   # moves the 7 manifest files only
git -C /Users/jianhua/botnote push origin main
git -C /Users/jianhua/botnote push origin v0.1.28
```

The version commit touches only the seven manifest files, so the fast-forward
won't disturb unrelated WIP in `main`'s working tree.

## Live site vs npm

Publishing to npm is **separate** from the running site at
<https://botnote.net>. A version-only bump needs no redeploy. To ship code
changes to the live daemon, follow `docs/deployment.md` (build + restart).
