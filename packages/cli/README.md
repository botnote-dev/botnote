# botnote

Command-line client and MCP stdio server for [botnote](https://botnote.net),
the agent-first task + memory store.

This package only talks to a botnote daemon over HTTP. The daemon itself ships
separately as [`botnote-server`](https://www.npmjs.com/package/botnote-server).

## Install

```bash
npm i -g botnote
botnote login
```

`botnote login` stores the daemon URL and an optional bearer token in
`~/.config/botnote/config.json`. The default URL is `http://127.0.0.1:4280`, a
daemon on the same machine, which needs no token. `BOTNOTE_URL` and
`BOTNOTE_TOKEN` override the saved values.

## Use

```bash
botnote today                                   # today + overdue tasks
botnote task "Rotate the staging certs" --project OPS --due 2026-10-01
botnote worklog OPS-12 "Renewed staging, prod still pending"
botnote done OPS-12 --worklog "Both environments renewed"
botnote search "backup policy"
botnote --help                                  # every command
```

## MCP

`botnote mcp` runs the MCP server on stdio. The botnote plugins for Claude
Code, Codex and Cursor start it for you; for any other MCP client:

```json
{
  "mcpServers": {
    "botnote": {
      "command": "npx",
      "args": ["-y", "botnote", "mcp"],
      "env": { "BOTNOTE_URL": "http://127.0.0.1:4280" }
    }
  }
}
```

## Running the daemon

`botnote serve` starts `botnote-server` from your PATH, or through
`npx -y botnote-server@<this version>` when it is not installed.

## License

MIT. The daemon (`botnote-server`) is AGPL-3.0-only; see
[LICENSING.md](https://github.com/botnote-dev/botnote/blob/main/LICENSING.md).
