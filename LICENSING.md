# Licensing

botnote is one repository that ships two npm packages under different
licenses. The license of a file is set by the directory it lives in.

| Path | Ships as | License |
|------|----------|---------|
| `packages/cli/` | npm `botnote`: the CLI and the MCP server (stdio entry and the HTTP handler the daemon mounts) | MIT, see [packages/cli/LICENSE](packages/cli/LICENSE) |
| `plugins/` | Claude Code, Codex and Cursor plugin: skills, commands, agents, MCP wiring | MIT, see [plugins/botnote/LICENSE](plugins/botnote/LICENSE) |
| `.claude-plugin/`, `.cursor-plugin/`, `.agents/` | Plugin marketplace manifests | MIT |
| Everything else: `src/`, `web/`, `scripts/`, `tests/`, `docs/`, ... | npm `botnote-server`: the daemon, REST API and web UI | AGPL-3.0-only, see [LICENSE](LICENSE) |

## What this means in practice

- **Clients are unaffected.** Code that talks to a botnote daemon over its
  REST API or through MCP (agents, scripts, integrations, the `botnote` CLI
  itself) does not become a derivative of the daemon and can use any license.
- **The CLI, MCP server, plugin and skills are MIT.** Copy, embed, fork and
  redistribute them under the usual MIT terms.
- **Running the daemon unmodified** for yourself, your team or anyone else
  only asks you to keep the license notices intact.
- **If you modify the daemon** and let other people use it over a network,
  AGPL-3.0 section 13 requires you to offer those users the complete source of
  your modified version under the same license.

The boundary is one-way in code. `packages/cli/` never imports from `src/`, so
the MIT package stays free of AGPL code. The daemon depends on the MIT package
as an ordinary npm dependency (`botnote`) to serve MCP at `/mcp`; AGPL code
using MIT code changes nothing about either license.

## History

Every release up to and including v0.2.16 was published as a single `botnote`
package under MIT, daemon included. Those releases remain available under MIT.
Releases after v0.2.16 publish the daemon separately as `botnote-server` under
AGPL-3.0-only; the `botnote` package keeps its name and its MIT license.

## Contributions

Contributions are accepted under the license of the directory they change. See
[CONTRIBUTING.md](CONTRIBUTING.md).

Copyright (c) 2026 Jianhua Wang
