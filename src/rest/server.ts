import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider
} from "fastify-type-provider-zod";
import { corsOrigins, DEFAULT_PORT, envValue } from "../config.js";
import type { Database } from "../db/client.js";
import type { EmbeddingService } from "../service/embedding.js";
import { DEFAULT_SCOPE, scopeFor, type Scope } from "../service/scope.js";
import { consumeSession } from "../service/sessions.js";
import { consumeToken } from "../service/tokens.js";
import { VERSION } from "../version.js";
import {
  authConfigFromEnv,
  clientIp,
  describeAuthConfig,
  isTrustedProxy,
  isTrustedWithoutCredential,
  type AuthConfig
} from "./auth.js";
import { isMcpPath, registerMcpRoute } from "./mcp.js";
import { registerRoutes } from "./routes.js";

export interface ServerContext {
  db: Database["db"];
  embedding: EmbeddingService;
  auth: AuthConfig;
  /** Scope for requests that carry no credential (single-workspace mode). */
  defaultScope: Scope;
}

export interface BuildServerOpts extends Omit<ServerContext, "auth" | "defaultScope"> {
  logLevel?: string;
  webDist?: string;
  auth?: AuthConfig;
  defaultScope?: Scope;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Workspace the request is allowed to touch. Set by onRequest, never by a route. */
    scope: Scope;
    /** API token that authenticated this request, for write attribution.
     *  null for session-cookie and trusted-loopback requests. */
    actorTokenId: string | null;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveWebDist(explicit?: string): string | null {
  const envPath = process.env.BOTNOTE_WEB_DIST;
  const candidates = [
    explicit,
    envPath,
    path.resolve(__dirname, "../../web/dist"),
    path.resolve(__dirname, "../../../web/dist")
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(path.join(c, "index.html"))) return c;
  }
  return null;
}

export async function buildServer(opts: BuildServerOpts): Promise<FastifyInstance> {
  const isProduction = process.env.NODE_ENV === "production";
  const auth = opts.auth ?? authConfigFromEnv();
  const defaultScope = opts.defaultScope ?? DEFAULT_SCOPE;

  const app = Fastify({
    logger: { level: opts.logLevel ?? "info" },
    // Only peers listed in BOTNOTE_TRUST_PROXY may rewrite req.ip through
    // x-forwarded-for. cf-connecting-ip is handled by clientIp() with the
    // same peer check, because Cloudflare's tunnel connects from loopback and
    // without it the whole internet would share one rate-limit bucket.
    trustProxy: (address: string) => isTrustedProxy(address, auth.trustedProxies)
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie, {
    // No global secret/sign — session cookies carry an opaque random token
    // that maps to a row in `sessions`; tamper-detection isn't useful since
    // we already validate every value against the DB.
    hook: "onRequest"
  });

  await app.register(cors, {
    origin: corsOrigins(),
    // credentials: true so cookies can be sent across origins (browser will
    // refuse to attach cookies on a fetch to a different origin otherwise).
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization"],
    maxAge: 86400
  });

  await app.register(rateLimit, {
    // 1000 req/min per IP — generous enough that a Claude Code session burst
    // and the Web UI's 30s polling combined don't trip it; tight enough that a
    // leaked token can't quietly exfil thousands of entities per second.
    max: 1000,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => clientIp(req, auth),
    // /health is a probe; /assets/* are dozens of static files per page load.
    // Counting them would cap real API headroom for no benefit.
    allowList: (req: FastifyRequest) => {
      const u = req.url;
      return u === "/health" || u.startsWith("/health?") || u.startsWith("/assets/");
    },
    errorResponseBuilder: (_req, ctx) => ({
      error: "rate_limited",
      message: `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)}s.`,
      retryAfter: Math.ceil(ctx.ttl / 1000)
    })
  });

  if (!isProduction) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: "botnote",
          version: VERSION,
          description:
            "Notion for bots. A lightweight, agent-first project + notes + memory store."
        },
        servers: [
          {
            url: `http://localhost:${envValue(process.env.BOTNOTE_PORT) ?? DEFAULT_PORT}`,
            description: "local"
          }
        ],
        tags: [
          { name: "projects", description: "Project lifecycle and AGENTS.md." },
          { name: "entities", description: "Tasks and notes." },
          { name: "tasks", description: "Task calendar queries (range + backlog)." },
          { name: "search", description: "Hybrid retrieval." },
          { name: "brief", description: "Opening brief — agent context bundle." },
          { name: "tokens", description: "API token management." },
          { name: "settings", description: "Daemon runtime settings." }
        ]
      },
      transform: jsonSchemaTransform
    });

    await app.register(swaggerUi, {
      routePrefix: "/docs",
      uiConfig: {
        docExpansion: "list",
        deepLinking: false
      }
    });
    app.log.info("swagger UI mounted at /docs (dev mode)");
  } else {
    app.log.info("swagger UI disabled (production)");
  }

  // ----- error handler -----
  // Strip Node stack traces from all responses. Zod validation errors return
  // field-level info but no schema dump; Fastify's own errors get a safe
  // summary.
  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & {
      statusCode?: number;
      code?: string;
      validation?: Array<{ instancePath?: string; schemaPath?: string; message?: string }>;
    };
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: "validation_error",
        message: "Request body or params failed validation.",
        details: err.validation!.map((v) => ({
          path: v.instancePath || v.schemaPath || "",
          message: v.message ?? ""
        }))
      });
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err }, "response serialization failed");
      return reply.code(500).send({ error: "server_error" });
    }
    // fastify-rate-limit's errorResponseBuilder result lands here without a
    // statusCode prop, so it would otherwise fall through to the 500 bucket
    // and lose the retryAfter signal. Surface it explicitly.
    const errAny = err as Error & { error?: string; retryAfter?: number };
    if (errAny.error === "rate_limited") {
      return reply.code(429).send({
        error: "rate_limited",
        message: err.message,
        retryAfter: errAny.retryAfter
      });
    }
    const sc = err.statusCode;
    if (typeof sc === "number" && sc >= 400 && sc < 500) {
      return reply.code(sc).send({ error: err.code ?? "client_error", message: err.message });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "server_error" });
  });

  // ----- scope -----
  // Every request starts in the default workspace. The auth hook below
  // narrows it to the credential's workspace when one is presented, so a
  // route handler can always pass req.scope straight into the service layer.
  // null (not an object literal) so every request shares one hidden-class
  // shape; the hook right below assigns the real value before any handler.
  app.decorateRequest("scope", null as unknown as Scope);
  app.decorateRequest("actorTokenId", null);
  app.addHook("onRequest", async (req) => {
    req.scope = defaultScope;
    req.actorTokenId = null;
  });

  // ----- auth -----
  // Every /v1 and /mcp request needs a session cookie or bearer token, except a direct
  // loopback connection when BOTNOTE_TRUST_LOCALHOST is on. Whether a request
  // is "loopback" is decided by the TCP peer address, never by headers: a LAN
  // client hitting a 0.0.0.0 bind gets the same gate as the public internet,
  // and forged x-forwarded-for from an untrusted peer changes nothing.
  // IMPORTANT: register at onRequest, not preHandler. fastify-type-provider-zod
  // runs schema validation at preValidation, which is BEFORE preHandler — so
  // a preHandler auth gate lets an unauthenticated POST get a 400 zod error
  // back, leaking the request schema. onRequest fires first; no body has been
  // parsed yet, but headers and cookies are all we need.
  //
  // A presented bearer token is always resolved, even on a trusted loopback
  // connection or when auth is off: that is what attributes the write to a
  // named token ("Claude Code @ MacBook"). Only the 401 depends on auth.required.
  app.addHook("onRequest", async (req, reply) => {
    const mcp = isMcpPath(req.url);
    if (!mcp && !req.url.startsWith("/v1/")) return;
    // The login endpoint is the entry point — gating it would be a
    // chicken-and-egg loop. Logout is fine to leave open too (it's a noop
    // when no cookie is present).
    if (
      req.url.startsWith("/v1/auth/login") ||
      req.url.startsWith("/v1/auth/logout")
    ) {
      return;
    }

    // CLI / MCP path: bearer token.
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const plaintext = authHeader.slice("Bearer ".length).trim();
      const tok = await consumeToken(opts.db, plaintext);
      if (tok) {
        req.scope = scopeFor(tok.workspaceId);
        req.actorTokenId = tok.id;
        return;
      }
    }

    if (!auth.required) return;
    if (isTrustedWithoutCredential(req, auth)) return;

    // Browser path: session cookie set by /v1/auth/login.
    const cookieToken = req.cookies?.botnote_session;
    if (cookieToken) {
      const session = await consumeSession(opts.db, cookieToken);
      if (session) {
        req.scope = scopeFor(session.workspaceId);
        return;
      }
    }

    if (mcp) {
      return reply.code(401).send({
        error: "unauthenticated",
        message:
          "Send a botnote API token as 'Authorization: Bearer <token>'. Create one in Settings -> API tokens."
      });
    }
    return reply.code(401).send({ error: "unauthenticated" });
  });
  app.log.info(describeAuthConfig(auth));

  await registerRoutes(app, { db: opts.db, embedding: opts.embedding, auth, defaultScope });
  registerMcpRoute(app);

  const webDist = resolveWebDist(opts.webDist);
  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      // wildcard: true lets fastify-static answer for every file under root
      // (notably /assets/<hash>.js / .css). Without it, those paths fall
      // through to the not-found handler and the SPA fallback sends back
      // index.html — the browser then tries to parse HTML as a JS module and
      // the page renders blank.
      wildcard: true,
      decorateReply: true,
      cacheControl: true,
      maxAge: "1d",
      immutable: false
    });

    const indexHtmlPath = path.join(webDist, "index.html");
    // Re-read on each request. The file is ~700 bytes so the cost is trivial,
    // and this guarantees we never serve a stale HTML that points to an old
    // asset hash after `pnpm build` overwrites the bundle — that's how the
    // page goes blank when the daemon outlives the previous build.
    const readIndex = () => readFileSync(indexHtmlPath, "utf8");

    // Explicit `/` route wins over fastify-static's wildcard so the homepage
    // always serves fresh HTML with no-cache, sidestepping the long max-age
    // applied to /assets/*.
    app.get("/", async (_req, reply) => {
      reply.type("text/html; charset=utf-8");
      reply.header("cache-control", "no-cache");
      return readIndex();
    });
    app.setNotFoundHandler(async (req, reply) => {
      const url = req.url;
      if (
        url.startsWith("/v1") ||
        url.startsWith("/docs") ||
        isMcpPath(url) ||
        // MCP clients probe here for OAuth metadata. Answering with the SPA's
        // index.html (200, text/html) makes them fail on a JSON parse instead
        // of concluding there is no OAuth and using the bearer token.
        url.startsWith("/.well-known/") ||
        url === "/health" ||
        url.startsWith("/health?") ||
        url.startsWith("/assets/")
      ) {
        return reply.code(404).send({ error: "not_found", path: url });
      }
      // SPA fallback for client-side routes (/today, /p/:key, etc.). Send the
      // file fresh from disk with no-cache so the browser never pins it to
      // an old asset hash after a redeploy.
      reply.type("text/html; charset=utf-8");
      reply.header("cache-control", "no-cache");
      return readIndex();
    });
    app.log.info(`web UI served from ${webDist}`);
  } else {
    app.log.warn("web/dist not found; UI not served (BOTNOTE_WEB_DIST or build required)");
  }

  return app;
}
