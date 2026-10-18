/**
 * Single source of truth for where a botnote daemon lives by default.
 *
 * Every client surface (CLI, MCP stdio server, plugin wrapper) falls back to
 * the local daemon. A remote instance is always an explicit choice: config.json
 * written by `botnote login`, BOTNOTE_URL, or the plugin's userConfig.
 */

export const DEFAULT_PORT = 4280;
export const DEFAULT_BASE_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

/** Env lookup that treats an empty string the same as unset. Plugin hosts
 *  substitute `${user_config.x}` with "" when the user left it blank. */
export function envValue(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v ? v : undefined;
}

export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): {
  baseUrl: string;
  explicit: boolean;
} {
  const fromEnv = envValue(env.BOTNOTE_URL);
  return fromEnv ? { baseUrl: fromEnv, explicit: true } : { baseUrl: DEFAULT_BASE_URL, explicit: false };
}

function causeMessage(err: unknown): string {
  if (err instanceof Error) {
    const inner = (err as Error & { cause?: unknown }).cause;
    if (inner instanceof Error && inner.message) return inner.message;
    return err.message;
  }
  return String(err);
}

/** One-paragraph explanation for a TCP-level failure talking to the daemon.
 *  Names the URL that was tried and how to point somewhere else, so a fresh
 *  install never silently talks to the wrong host and never fails mutely. */
export function unreachableHint(baseUrl: string, cause: unknown): string {
  const head = `cannot reach botnote at ${baseUrl} (${causeMessage(cause)}).`;
  if (baseUrl === DEFAULT_BASE_URL) {
    return (
      `${head} No daemon URL is configured, so the local default was used. ` +
      "Start a daemon on this machine with `botnote serve`, or point at a remote one: " +
      "run `botnote login`, or set BOTNOTE_URL (plus BOTNOTE_TOKEN for a token-gated instance)."
    );
  }
  return `${head} Check that the daemon is running and reachable, or change the URL with \`botnote login\` / BOTNOTE_URL.`;
}

export class BotnoteUnreachableError extends Error {
  constructor(
    public baseUrl: string,
    cause: unknown
  ) {
    super(unreachableHint(baseUrl, cause), { cause });
    this.name = "BotnoteUnreachableError";
  }
}
