import type { FastifyInstance, FastifyRequest } from "fastify";
import { handleMcpHttpRequest } from "botnote/mcp";

export const MCP_PATH = "/mcp";

export function isMcpPath(url: string): boolean {
  return url === MCP_PATH || url.startsWith(`${MCP_PATH}?`) || url.startsWith(`${MCP_PATH}/`);
}

// What the auth hook reads to decide who is calling. Replayed on every REST
// call a tool makes, together with the caller's TCP peer address, so those
// calls are trusted exactly as much as the /mcp request that caused them.
const IDENTITY_HEADERS = ["authorization", "cookie", "x-forwarded-for", "cf-connecting-ip"] as const;

/**
 * fetch() that dispatches into this Fastify instance instead of the network.
 * MCP tools stay ordinary REST clients (same routes, validation, auth and
 * attribution as any other caller) without a loopback socket, which the
 * daemon would otherwise mistake for a trusted local client.
 */
function inProcessFetch(app: FastifyInstance, caller: FastifyRequest): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    for (const name of IDENTITY_HEADERS) {
      const value = caller.headers[name];
      if (typeof value === "string") headers[name] = value;
      else delete headers[name];
    }
    const res = await app.inject({
      method: (init?.method ?? "GET") as "GET",
      url: url.pathname + url.search,
      headers,
      payload: typeof init?.body === "string" ? init.body : undefined,
      remoteAddress: caller.socket.remoteAddress
    });
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(res.headers)) {
      if (value === undefined) continue;
      responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : String(value));
    }
    const bodiless = res.statusCode === 204 || res.statusCode === 304;
    return new Response(bodiless ? null : res.rawPayload, {
      status: res.statusCode,
      statusText: res.statusMessage,
      headers: responseHeaders
    });
  };
}

/** MCP over Streamable HTTP, served by the daemon itself. Auth is the same
 *  onRequest gate as /v1; see buildServer. */
export function registerMcpRoute(app: FastifyInstance): void {
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: MCP_PATH,
    handler: async (req, reply) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const hasBody = req.method === "POST" && req.body !== undefined;
      const request = new Request(`http://botnote.internal${MCP_PATH}`, {
        method: req.method,
        headers,
        body: hasBody ? JSON.stringify(req.body) : undefined
      });
      const { response, close } = await handleMcpHttpRequest(request, hasBody ? req.body : undefined, {
        baseUrl: "http://botnote.internal",
        fetch: inProcessFetch(app, req)
      });
      reply.raw.on("close", () => {
        close().catch((err: unknown) => req.log.warn({ err }, "mcp server close failed"));
      });
      return reply.send(response);
    }
  });
}
