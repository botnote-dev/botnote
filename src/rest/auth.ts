import type { FastifyRequest } from "fastify";

/**
 * Who the daemon trusts without a credential, and whose forwarded headers it
 * believes. Resolved once from the environment at boot; tests pass it in.
 *
 *   BOTNOTE_REQUIRE_AUTH   "1" enforce, "0" disable. Unset: enforce when
 *                          BOTNOTE_PASSWORD is set (there is a login to protect).
 *   BOTNOTE_TRUST_LOCALHOST "0" to make loopback callers present a credential
 *                          too. Default "1": a direct connection from the daemon
 *                          host needs no token, which keeps the local install
 *                          zero-config.
 *   BOTNOTE_TRUST_PROXY    Comma list of peers whose cf-connecting-ip /
 *                          x-forwarded-for headers are honoured: "loopback",
 *                          an IPv4/IPv6 address, or an IPv4 CIDR. Default
 *                          "loopback" (cloudflared / nginx / caddy on the same
 *                          host). Headers from any other peer are ignored, so a
 *                          LAN client cannot forge its way past rate limiting.
 *   BOTNOTE_CLIENT_IP_HEADER Which header from a trusted proxy names the client:
 *                          "x-forwarded-for" (Caddy, Traefik, nginx: the
 *                          rightmost entry, the one the proxy itself wrote) or
 *                          "cf-connecting-ip" (Cloudflare in front). A proxy
 *                          that is not Cloudflare passes a client-supplied
 *                          cf-connecting-ip straight through, so naming the
 *                          header is what stops a caller from picking its own
 *                          rate-limit bucket. Unset: cf-connecting-ip, then the
 *                          first x-forwarded-for entry (cloudflared on loopback).
 */
export interface AuthConfig {
  required: boolean;
  trustLocalhost: boolean;
  trustedProxies: string[];
  clientIpHeader?: ClientIpHeader;
}

export type ClientIpHeader = "auto" | "x-forwarded-for" | "cf-connecting-ip";

const CLIENT_IP_HEADERS: ClientIpHeader[] = ["auto", "x-forwarded-for", "cf-connecting-ip"];

export type RequestOrigin = "local" | "proxied" | "direct";

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  // Compose passes unset variables through as empty strings.
  const flag = env.BOTNOTE_REQUIRE_AUTH?.trim() || undefined;
  const required = flag === undefined ? Boolean(env.BOTNOTE_PASSWORD) : flag === "1";
  return {
    required,
    trustLocalhost: env.BOTNOTE_TRUST_LOCALHOST !== "0",
    trustedProxies: parseTrustedProxies(env.BOTNOTE_TRUST_PROXY),
    clientIpHeader: parseClientIpHeader(env.BOTNOTE_CLIENT_IP_HEADER)
  };
}

export function parseClientIpHeader(raw: string | undefined): ClientIpHeader {
  const v = raw?.trim().toLowerCase();
  if (!v) return "auto";
  if (!CLIENT_IP_HEADERS.includes(v as ClientIpHeader)) {
    throw new Error(
      `BOTNOTE_CLIENT_IP_HEADER must be one of ${CLIENT_IP_HEADERS.join(", ")}: ${raw}`
    );
  }
  return v as ClientIpHeader;
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || isLoopback(h);
}

/**
 * A daemon told it is reachable at a public URL must not run with auth off:
 * that is a deployment one forgotten variable away from serving every task and
 * memory to anyone. Returns why the configuration is refused, or null.
 * BOTNOTE_REQUIRE_AUTH=0 is the explicit way to run open (VPN, tailnet).
 */
export function exposureProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const publicUrl = env.BOTNOTE_PUBLIC_URL?.trim();
  if (!publicUrl) return null;
  if (authConfigFromEnv(env).required || env.BOTNOTE_REQUIRE_AUTH?.trim() === "0") return null;
  let hostname: string;
  try {
    hostname = new URL(publicUrl).hostname;
  } catch {
    return null;
  }
  if (isLoopbackHost(hostname)) return null;
  return (
    `BOTNOTE_PUBLIC_URL is ${publicUrl} but auth is off, so anyone who can reach it could read and write everything. ` +
    "Set BOTNOTE_PASSWORD, or set BOTNOTE_REQUIRE_AUTH=0 to run without auth on purpose."
  );
}

/** The session cookie is Secure whenever the browser reaches the daemon over
 *  https: by the configured public URL, else by how this request arrived. */
export function sessionCookieSecure(
  requestProtocol: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const publicUrl = env.BOTNOTE_PUBLIC_URL?.trim();
  if (publicUrl) return publicUrl.toLowerCase().startsWith("https://");
  return requestProtocol === "https";
}

export function parseTrustedProxies(raw: string | undefined): string[] {
  if (raw === undefined) return ["loopback"];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeAddress(addr: string | undefined): string {
  if (!addr) return "";
  return addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
}

export function isLoopback(addr: string | undefined): boolean {
  const a = normalizeAddress(addr);
  return a === "::1" || a.startsWith("127.");
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function matchesCidr(addr: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const a = ipv4ToInt(addr);
  const b = ipv4ToInt(base ?? "");
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

export function isTrustedProxy(addr: string | undefined, trustedProxies: string[]): boolean {
  const a = normalizeAddress(addr);
  if (!a) return false;
  for (const rule of trustedProxies) {
    if (rule === "loopback") {
      if (isLoopback(a)) return true;
    } else if (rule.includes("/")) {
      if (matchesCidr(a, rule)) return true;
    } else if (normalizeAddress(rule) === a) {
      return true;
    }
  }
  return false;
}

type HeaderBag = Pick<FastifyRequest, "headers"> & {
  socket?: { remoteAddress?: string };
  ip?: string;
};

function socketAddress(req: HeaderBag): string {
  return normalizeAddress(req.socket?.remoteAddress ?? req.ip);
}

export function hasForwardedHeaders(req: Pick<FastifyRequest, "headers">): boolean {
  return Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
}

/** The address rate limiting keys on. Forwarded headers count only when the
 *  TCP peer is a trusted proxy; otherwise the peer itself is the client. */
export function clientIp(req: HeaderBag, cfg: AuthConfig): string {
  const peer = socketAddress(req);
  if (!isTrustedProxy(peer, cfg.trustedProxies)) return peer || "unknown";
  const mode = cfg.clientIpHeader ?? "auto";
  const cf = req.headers["cf-connecting-ip"];
  if (mode !== "x-forwarded-for" && typeof cf === "string" && cf) return cf;
  const xff = req.headers["x-forwarded-for"];
  if (mode !== "cf-connecting-ip" && typeof xff === "string" && xff) {
    const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
    const hop = mode === "auto" ? hops[0] : hops[hops.length - 1];
    if (hop) return hop;
  }
  return peer || "unknown";
}

/**
 * local   — the TCP peer is loopback and nothing says a proxy forwarded it.
 * proxied — the TCP peer is a trusted proxy and forwarded headers are present.
 * direct  — anything else: a LAN or public client talking to the port itself.
 */
export function requestOrigin(req: HeaderBag, cfg: AuthConfig): RequestOrigin {
  const peer = socketAddress(req);
  const forwarded = hasForwardedHeaders(req);
  if (forwarded && isTrustedProxy(peer, cfg.trustedProxies)) return "proxied";
  if (!forwarded && isLoopback(peer)) return "local";
  return "direct";
}

export function isTrustedWithoutCredential(req: HeaderBag, cfg: AuthConfig): boolean {
  return cfg.trustLocalhost && requestOrigin(req, cfg) === "local";
}

export function describeAuthConfig(cfg: AuthConfig): string {
  if (!cfg.required) return "auth: disabled (set BOTNOTE_REQUIRE_AUTH=1 or BOTNOTE_PASSWORD to enforce)";
  const local = cfg.trustLocalhost ? "loopback trusted without credential" : "loopback requires credential";
  return `auth: required for /v1/* and /mcp (cookie or bearer); ${local}; trusted proxies: ${cfg.trustedProxies.join(", ") || "none"}; client ip from: ${cfg.clientIpHeader ?? "auto"}`;
}
