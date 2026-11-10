#!/usr/bin/env bash
# Wrapper that runs the botnote CLI in MCP stdio mode.
# Used by the Codex and Cursor plugins. The Claude Code plugin does not run
# this: its .mcp.json connects straight to the daemon's /mcp endpoint.
# Resolution order:
#   1. BOTNOTE_BIN env var (manual override, e.g. for dev checkouts)
#   2. `botnote` on PATH only when it matches this plugin version
#   3. `npx -y botnote@<plugin-version>`, but only after verifying the version
#      it actually resolves — npx silently runs a stale globally-installed
#      botnote (exit 0, no error) when the pinned version can't be fetched,
#      e.g. before the release lands on the registry.
#
# There is deliberately NO version-mismatched fallback: an old CLI serves an
# old tool surface, and agents treat missing tools as "capability gone" and
# silently skip work. A loud startup failure gets reported; a downgrade never is.
#
# The MCP server itself is an HTTP client of the botnote daemon — it reads
# BOTNOTE_URL / BOTNOTE_TOKEN / BOTNOTE_CF_ACCESS_CLIENT_{ID,SECRET} from env.
# Those are populated by Claude Code from the plugin's userConfig at startup.
# When neither userConfig nor ~/.config/botnote/config.json names a URL, the
# CLI's own default applies (the daemon on this machine); this wrapper never
# picks a host itself.

set -euo pipefail

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_version="$(node -e "const fs=require('fs'); const path=require('path'); for (const rel of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) { try { const c=JSON.parse(fs.readFileSync(path.join(process.argv[1], rel), 'utf8')); if (typeof c.version === 'string') { process.stdout.write(c.version); process.exit(0); } } catch {} }" "$plugin_root" 2>/dev/null || true)"

if [[ "${BOTNOTE_URL:-}" == '${user_config.botnote_url}' || -z "${BOTNOTE_URL:-}" ]]; then
  unset BOTNOTE_URL
fi
if [[ "${BOTNOTE_TOKEN:-}" == '${user_config.botnote_token}' || -z "${BOTNOTE_TOKEN:-}" ]]; then
  unset BOTNOTE_TOKEN
fi

config_path="${XDG_CONFIG_HOME:-$HOME/.config}/botnote/config.json"
if [[ -f "$config_path" ]]; then
  if [[ -z "${BOTNOTE_URL:-}" ]]; then
    cfg_url="$(node -e "const fs=require('fs'); try { const c=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (typeof c.baseUrl === 'string') process.stdout.write(c.baseUrl); } catch {}" "$config_path" 2>/dev/null || true)"
    if [[ -n "$cfg_url" ]]; then
      export BOTNOTE_URL="$cfg_url"
    fi
  fi
  if [[ -z "${BOTNOTE_TOKEN:-}" ]]; then
    cfg_token="$(node -e "const fs=require('fs'); try { const c=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (typeof c.token === 'string') process.stdout.write(c.token); } catch {}" "$config_path" 2>/dev/null || true)"
    if [[ -n "$cfg_token" ]]; then
      export BOTNOTE_TOKEN="$cfg_token"
    fi
  fi
fi

if [[ -n "${BOTNOTE_BIN:-}" && -x "$BOTNOTE_BIN" ]]; then
  exec "$BOTNOTE_BIN" mcp
fi

cli_version=""
if command -v botnote >/dev/null 2>&1; then
  cli_version="$(botnote --version 2>/dev/null || botnote version 2>/dev/null || true)"
  if [[ -n "$plugin_version" && "$cli_version" == "$plugin_version" ]]; then
    exec botnote mcp
  fi
fi

npx_version=""
if command -v npx >/dev/null 2>&1; then
  if [[ -n "$plugin_version" ]]; then
    npx_version="$(npx -y "botnote@$plugin_version" --version 2>/dev/null || true)"
    if [[ "$npx_version" == "$plugin_version" ]]; then
      exec npx -y "botnote@$plugin_version" mcp
    fi
  else
    # Plugin version unreadable: nothing to verify against, best effort.
    exec npx -y botnote@latest mcp
  fi
fi

{
  echo "botnote plugin $plugin_version refusing to start: no CLI of that exact version is available."
  echo "  PATH botnote: ${cli_version:-not found}"
  echo "  npx botnote@$plugin_version resolved: ${npx_version:-nothing}"
  echo "A mismatched CLI would expose the wrong MCP tool surface, so this is a hard failure."
  echo "Fix: publish botnote@$plugin_version to npm, or 'npm i -g botnote@$plugin_version',"
  echo "or point BOTNOTE_BIN at a dev build of that version."
} >&2
exit 127
