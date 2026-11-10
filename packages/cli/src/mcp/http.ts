import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { VERSION } from "../version.js";
import { BotnoteHttpClient } from "./http-client.js";
import { buildMcpServer } from "./server.js";

export interface McpHttpOptions {
  /** Base URL of the daemon REST API the tools call. */
  baseUrl: string;
  token?: string;
  /** Transport for those REST calls; defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface McpHttpResult {
  response: Response;
  /** Release the per-request server. Call once the response has been sent. */
  close: () => Promise<void>;
}

/**
 * Serve one MCP Streamable HTTP request. Stateless: every request gets a fresh
 * server and transport, so nothing is shared between callers and any daemon
 * process can answer any request. Replies are plain JSON rather than an SSE
 * stream, which a stateless server has no use for and which proxies buffer.
 * `parsedBody` is the JSON body when the host framework already consumed it.
 */
export async function handleMcpHttpRequest(
  request: Request,
  parsedBody: unknown,
  opts: McpHttpOptions
): Promise<McpHttpResult> {
  if (request.method !== "POST") {
    // No sessions means no server-initiated stream to open (GET) and nothing
    // to terminate (DELETE).
    return {
      response: Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed. This MCP endpoint is stateless; use POST." },
          id: null
        },
        { status: 405, headers: { allow: "POST" } }
      ),
      close: async () => {}
    };
  }

  const client = new BotnoteHttpClient({
    baseUrl: opts.baseUrl,
    token: opts.token,
    version: VERSION,
    fetch: opts.fetch
  });
  const server = buildMcpServer({ client, version: VERSION });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  await server.connect(transport);
  const response = await transport.handleRequest(request, { parsedBody });
  return { response, close: () => server.close() };
}
