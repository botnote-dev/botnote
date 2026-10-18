# Contributing

Thanks for helping improve botnote.

## Development setup

```bash
pnpm install
docker compose up -d
DATABASE_URL=postgres://botnote:botnote@127.0.0.1:55434/botnote pnpm db:migrate
DATABASE_URL=postgres://botnote:botnote@127.0.0.1:55434/botnote pnpm dev
```

## Tests

Never run tests against a live botnote database. Tests require
`BOTNOTE_TEST_DATABASE_URL`, and the database name must contain `test`.

```bash
docker exec botnote-postgres createdb -U botnote botnote_test || true
DATABASE_URL=postgres://botnote:botnote@127.0.0.1:55434/botnote_test pnpm db:migrate
BOTNOTE_TEST_DATABASE_URL=postgres://botnote:botnote@127.0.0.1:55434/botnote_test pnpm test
```

Before opening a pull request, run:

```bash
pnpm typecheck
pnpm --dir web typecheck
pnpm build
```

## Code style

- Keep REST and MCP transports thin; shared behavior belongs in `src/service/`.
- Keep the two packages apart: `packages/cli/` (MIT) never imports from `src/`
  (AGPL), and `src/` never imports from `packages/cli/`. They meet only at the
  HTTP API.
- Use idempotent migrations. Prefer `IF NOT EXISTS` and `CREATE OR REPLACE`
  where applicable.
- Do not commit `.env`, database URLs with real credentials, API keys, or
  generated local build output.
- Keep docs and code in English.

## Licensing of contributions

botnote is licensed per directory (see [LICENSING.md](LICENSING.md)): the daemon
is AGPL-3.0-only, while `packages/cli/`, `plugins/` and the marketplace
manifests are MIT. By opening a pull request you agree that your contribution
is licensed under the license of the directory it changes.
