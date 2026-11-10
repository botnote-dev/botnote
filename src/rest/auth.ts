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
 */
export interface AuthConfig {
  required: boolean;
  trustLocalhost: boolean;
  trustedProxies: string[];
}

export type RequestOrigin = "local" | "proxied" | "direct";

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const flag = env.BOTNOTE_REQUIRE_AUTH;
  const required = flag === undefined ? Boolean(env.BOTNOTE_PASSWORD) : flag === "1";
  return {
    required,
    trustLocalhost: env.BOTNOTE_TRUST_LOCALHOST !== "0",
    trustedProxies: parseTrustedProxies(env.BOTNOTE_TRUST_PROXY)
  };
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
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0]!.trim();
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
  return `auth: required for /v1/* and /mcp (cookie or bearer); ${local}; trusted proxies: ${cfg.trustedProxies.join(", ") || "none"}`;
}
