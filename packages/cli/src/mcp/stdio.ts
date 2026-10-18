import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { envValue, resolveBaseUrl } from "../config.js";
import { VERSION } from "../version.js";
import { BotnoteHttpClient } from "./http-client.js";
import { buildMcpServer } from "./server.js";

/**
 * MCP stdio mode. The server is an HTTP client of the botnote daemon (no DB
 * connection here), so it can be installed via a plugin on any machine and
 * pointed at any daemon (loopback by default, a private network URL, a public
 * instance...). Every log line must go to stderr so we don't corrupt the MCP
 * framed JSON on stdout.
 */
export async function runMcpStdio(): Promise<void> {
  const { baseUrl, explicit } = resolveBaseUrl();
  const client = new BotnoteHttpClient({
    baseUrl,
    token: envValue(process.env.BOTNOTE_TOKEN),
    version: VERSION
  });
  const server = buildMcpServer({ client, version: VERSION });
  const transport = new StdioServerTransport();

  // Exit diagnostics: clients report the server "dropping mid-session" but the
  // process itself never says why it went away. Every path out of the process
  // leaves one stderr line so the harness log shows whether the host closed
  // stdin, sent a signal, or the server crashed.
  const sayExit = (reason: string) => process.stderr.write(`botnote MCP exiting: ${reason}\n`);
  process.stdin.on("end", () => sayExit("stdin closed by host"));
  process.stdin.on("close", () => sayExit("stdin stream closed"));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      sayExit(`received ${sig}`);
      process.exit(0);
    });
  }
  process.on("uncaughtException", (err) => {
    sayExit(`uncaught exception: ${err?.stack ?? err}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    sayExit(`unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });

  await server.connect(transport);
  process.stderr.write(
    `botnote MCP v${VERSION} ready (stdio) → ${baseUrl}${explicit ? "" : " (default; set BOTNOTE_URL for another daemon)"}\n`
  );
}
