import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authConfigFromEnv,
  clientIp,
  isTrustedProxy,
  requestOrigin,
  type AuthConfig
} from "../src/rest/auth.js";
import { buildServer } from "../src/rest/server.js";
import { EmbeddingService } from "../src/service/embedding.js";
import { createToken } from "../src/service/tokens.js";
import { DEFAULT_SCOPE as S } from "../src/service/scope.js";
import { createTestDb } from "./test_db.js";

const { db, pool } = createTestDb();
const embedding = new EmbeddingService(db);

const LAN_PEER = "192.168.1.20";
const PUBLIC_CLIENT = "203.0.113.9";
const PASSWORD = "auth-test-password";

const enforcing: AuthConfig = { required: true, trustLocalhost: true, trustedProxies: ["loopback"] };

let server: FastifyInstance;
let bearer: string;
let bearerTokenId: string;

function fakeReq(remoteAddress: string, headers: Record<string, string> = {}) {
  return { headers, socket: { remoteAddress }, ip: remoteAddress };
}

beforeAll(async () => {
  await db.execute(sql`TRUNCATE tokens, sessions RESTART IDENTITY CASCADE`);
  process.env.BOTNOTE_PASSWORD = PASSWORD;
  server = await buildServer({ db, embedding, logLevel: "silent", auth: enforcing });
  await server.ready();
  const created = await createToken(S, db, { name: "auth-test" });
  bearer = created.plaintext;
  bearerTokenId = created.token.id;
});

afterAll(async () => {
  delete process.env.BOTNOTE_PASSWORD;
  await server?.close();
  await pool.end();
});

describe("auth config from environment", () => {
  it("defaults to enforcing when a password is configured and the flag is unset", () => {
    expect(authConfigFromEnv({ BOTNOTE_PASSWORD: "x" }).required).toBe(true);
    expect(authConfigFromEnv({}).required).toBe(false);
    expect(authConfigFromEnv({ BOTNOTE_PASSWORD: "x", BOTNOTE_REQUIRE_AUTH: "0" }).required).toBe(false);
    expect(authConfigFromEnv({ BOTNOTE_REQUIRE_AUTH: "1" }).required).toBe(true);
  });

  it("trusts loopback by default and honours overrides", () => {
    const cfg = authConfigFromEnv({});
    expect(cfg.trustLocalhost).toBe(true);
    expect(cfg.trustedProxies).toEqual(["loopback"]);
    const custom = authConfigFromEnv({
      BOTNOTE_TRUST_LOCALHOST: "0",
      BOTNOTE_TRUST_PROXY: "loopback, 10.0.0.5, 172.16.0.0/12"
    });
    expect(custom.trustLocalhost).toBe(false);
    expect(custom.trustedProxies).toEqual(["loopback", "10.0.0.5", "172.16.0.0/12"]);
  });
});

describe("peer classification", () => {
  it("matches loopback in IPv4, IPv6 and v4-mapped forms", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(isTrustedProxy(a, ["loopback"])).toBe(true);
    }
    expect(isTrustedProxy(LAN_PEER, ["loopback"])).toBe(false);
  });

  it("matches exact addresses and IPv4 CIDRs", () => {
    expect(isTrustedProxy("10.0.0.5", ["10.0.0.5"])).toBe(true);
    expect(isTrustedProxy("172.20.3.4", ["172.16.0.0/12"])).toBe(true);
    expect(isTrustedProxy("172.32.0.1", ["172.16.0.0/12"])).toBe(false);
    expect(isTrustedProxy("::ffff:10.0.0.5", ["10.0.0.5"])).toBe(true);
  });

  it("only believes forwarded headers from a trusted proxy", () => {
    expect(clientIp(fakeReq("127.0.0.1", { "cf-connecting-ip": PUBLIC_CLIENT }), enforcing)).toBe(PUBLIC_CLIENT);
    expect(clientIp(fakeReq("127.0.0.1", { "x-forwarded-for": `${PUBLIC_CLIENT}, 10.0.0.1` }), enforcing)).toBe(PUBLIC_CLIENT);
    expect(clientIp(fakeReq(LAN_PEER, { "x-forwarded-for": "127.0.0.1" }), enforcing)).toBe(LAN_PEER);
    expect(clientIp(fakeReq(LAN_PEER, { "cf-connecting-ip": "127.0.0.1" }), enforcing)).toBe(LAN_PEER);
    expect(clientIp(fakeReq("127.0.0.1"), enforcing)).toBe("127.0.0.1");
  });

  it("classifies local, proxied and direct origins", () => {
    expect(requestOrigin(fakeReq("127.0.0.1"), enforcing)).toBe("local");
    expect(requestOrigin(fakeReq("127.0.0.1", { "x-forwarded-for": PUBLIC_CLIENT }), enforcing)).toBe("proxied");
    expect(requestOrigin(fakeReq(LAN_PEER), enforcing)).toBe("direct");
    expect(requestOrigin(fakeReq(LAN_PEER, { "x-forwarded-for": "127.0.0.1" }), enforcing)).toBe("direct");
  });
});

describe("auth gate on /v1 (enforcing, loopback trusted)", () => {
  it("lets a direct loopback request through without a credential", async () => {
    const res = await server.inject({ method: "GET", url: "/v1/projects", remoteAddress: "127.0.0.1" });
    expect(res.statusCode).toBe(200);
    const who = await server.inject({ method: "GET", url: "/v1/auth/whoami", remoteAddress: "127.0.0.1" });
    expect(who.json()).toMatchObject({ authenticated: true, via: "trusted_origin", origin: "local" });
  });

  it("rejects a direct LAN request without a credential", async () => {
    const res = await server.inject({ method: "GET", url: "/v1/projects", remoteAddress: LAN_PEER });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthenticated" });
  });

  it("does not let a LAN client forge loopback through x-forwarded-for", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/v1/projects",
      remoteAddress: LAN_PEER,
      headers: { "x-forwarded-for": "127.0.0.1", "cf-connecting-ip": "127.0.0.1" }
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a proxied request without a credential", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/v1/projects",
      remoteAddress: "127.0.0.1",
      headers: { "cf-connecting-ip": PUBLIC_CLIENT, "x-forwarded-for": PUBLIC_CLIENT }
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a bearer token from LAN and from behind the proxy", async () => {
    for (const remoteAddress of [LAN_PEER, "127.0.0.1"]) {
      const res = await server.inject({
        method: "GET",
        url: "/v1/auth/whoami",
        remoteAddress,
        headers: { authorization: `Bearer ${bearer}`, "x-forwarded-for": PUBLIC_CLIENT }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ authenticated: true, via: "bearer" });
    }
    const bad = await server.inject({
      method: "GET",
      url: "/v1/projects",
      remoteAddress: LAN_PEER,
      headers: { authorization: "Bearer bn_not_a_real_token" }
    });
    expect(bad.statusCode).toBe(401);
  });

  it("accepts a session cookie obtained from the master-password login", async () => {
    const login = await server.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: LAN_PEER,
      payload: { password: PASSWORD }
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === "botnote_session");
    expect(cookie).toBeDefined();

    const res = await server.inject({
      method: "GET",
      url: "/v1/auth/whoami",
      remoteAddress: LAN_PEER,
      cookies: { botnote_session: cookie!.value }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ authenticated: true, via: "cookie", origin: "direct" });

    const wrong = await server.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: LAN_PEER,
      payload: { password: "nope" }
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("leaves /health and the web root open", async () => {
    const res = await server.inject({ method: "GET", url: "/health", remoteAddress: LAN_PEER });
    expect(res.statusCode).toBe(200);
  });
});

describe("auth gate variants", () => {
  it("requires a credential from loopback when BOTNOTE_TRUST_LOCALHOST=0", async () => {
    const strict = await buildServer({
      db,
      embedding,
      logLevel: "silent",
      auth: { required: true, trustLocalhost: false, trustedProxies: ["loopback"] }
    });
    try {
      const anon = await strict.inject({ method: "GET", url: "/v1/projects", remoteAddress: "127.0.0.1" });
      expect(anon.statusCode).toBe(401);
      const withToken = await strict.inject({
        method: "GET",
        url: "/v1/projects",
        remoteAddress: "127.0.0.1",
        headers: { authorization: `Bearer ${bearer}` }
      });
      expect(withToken.statusCode).toBe(200);
    } finally {
      await strict.close();
    }
  });

  it("reports auth_disabled and lets everything through when not required", async () => {
    const open = await buildServer({
      db,
      embedding,
      logLevel: "silent",
      auth: { required: false, trustLocalhost: true, trustedProxies: ["loopback"] }
    });
    try {
      const res = await open.inject({ method: "GET", url: "/v1/auth/whoami", remoteAddress: LAN_PEER });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ authenticated: true, via: "auth_disabled", origin: "direct" });

      // Attribution does not depend on enforcement: a presented token still names the author.
      const task = await open.inject({
        method: "POST",
        url: "/v1/tasks",
        remoteAddress: LAN_PEER,
        headers: { authorization: `Bearer ${bearer}` },
        payload: { title: "written with auth off", actorKind: "agent" }
      });
      expect(task.statusCode).toBe(200);
      expect(task.json()).toMatchObject({
        actorTokenId: bearerTokenId,
        actor: { kind: "agent", label: "auth-test" }
      });
    } finally {
      await open.close();
    }
  });
});

describe("write attribution", () => {
  it("records the bearer token on tasks, worklog entries and feedback and labels them by token name", async () => {
    const headers = { authorization: `Bearer ${bearer}` };
    const task = await server.inject({
      method: "POST",
      url: "/v1/tasks",
      remoteAddress: "127.0.0.1",
      headers,
      payload: { title: "attributed via loopback + token", actorKind: "agent" }
    });
    expect(task.statusCode).toBe(200);
    expect(task.json()).toMatchObject({
      actorKind: "agent",
      actorTokenId: bearerTokenId,
      actor: { kind: "agent", label: "auth-test" }
    });
    const taskId = task.json().id as string;

    const entry = await server.inject({
      method: "POST",
      url: `/v1/entities/${taskId}/worklog`,
      remoteAddress: LAN_PEER,
      headers,
      payload: { body: "progress", actorKind: "agent" }
    });
    expect(entry.statusCode).toBe(200);
    expect(entry.json()).toMatchObject({
      actorTokenId: bearerTokenId,
      actor: { kind: "agent", label: "auth-test" }
    });

    const feedback = await server.inject({
      method: "POST",
      url: "/v1/feedback",
      remoteAddress: LAN_PEER,
      headers,
      payload: { category: "friction", title: "attributed feedback" }
    });
    expect(feedback.statusCode).toBe(200);
    expect(feedback.json()).toMatchObject({
      actorTokenId: bearerTokenId,
      actor: { label: "auth-test" }
    });

    // Reads resolve the same label, including nested entities.
    const listed = await server.inject({
      method: "GET",
      url: `/v1/entities/${taskId}/worklog`,
      remoteAddress: "127.0.0.1"
    });
    expect(listed.json()[0]).toMatchObject({ actor: { label: "auth-test" } });
    const fetched = await server.inject({
      method: "GET",
      url: `/v1/entities/${taskId}`,
      remoteAddress: "127.0.0.1"
    });
    expect(fetched.json()).toMatchObject({ actor: { kind: "agent", label: "auth-test" } });
  });

  it("attributes revisions to the bearer token and serves them with labels", async () => {
    const headers = { authorization: `Bearer ${bearer}` };
    const created = await server.inject({
      method: "POST",
      url: "/v1/tasks",
      remoteAddress: "127.0.0.1",
      payload: { title: "before edit", body: "v1" }
    });
    const taskId = created.json().id as string;

    const patched = await server.inject({
      method: "PATCH",
      url: `/v1/entities/${taskId}`,
      remoteAddress: LAN_PEER,
      headers,
      payload: { title: "after edit", body: "v2" }
    });
    expect(patched.statusCode).toBe(200);

    const revisions = await server.inject({
      method: "GET",
      url: `/v1/entities/${taskId}/revisions`,
      remoteAddress: "127.0.0.1"
    });
    expect(revisions.statusCode).toBe(200);
    expect(revisions.json()).toHaveLength(1);
    expect(revisions.json()[0]).toMatchObject({
      revision: 1,
      title: "before edit",
      body: "v1",
      actorKind: "agent",
      actorTokenId: bearerTokenId,
      actor: { kind: "agent", label: "auth-test" }
    });

    const missing = await server.inject({
      method: "GET",
      url: "/v1/entities/00000000-0000-0000-0000-000000000000/revisions",
      remoteAddress: "127.0.0.1"
    });
    expect(missing.statusCode).toBe(404);
  });

  it("falls back to the actor kind for session and trusted-loopback writes and ignores a spoofed actorTokenId", async () => {
    const loopback = await server.inject({
      method: "POST",
      url: "/v1/tasks",
      remoteAddress: "127.0.0.1",
      payload: { title: "no credential", actorKind: "human", actorTokenId: bearerTokenId }
    });
    expect(loopback.statusCode).toBe(200);
    expect(loopback.json()).toMatchObject({
      actorTokenId: null,
      actor: { kind: "human", label: "human" }
    });

    const login = await server.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: LAN_PEER,
      payload: { password: PASSWORD }
    });
    const cookie = login.cookies.find((c) => c.name === "botnote_session");
    const viaSession = await server.inject({
      method: "POST",
      url: "/v1/tasks",
      remoteAddress: LAN_PEER,
      cookies: { botnote_session: cookie!.value },
      payload: { title: "from the browser", actorKind: "human" }
    });
    expect(viaSession.statusCode).toBe(200);
    expect(viaSession.json()).toMatchObject({ actorTokenId: null, actor: { label: "human" } });
  });

  it("shows the token name on the opening brief worklog line", async () => {
    const headers = { authorization: `Bearer ${bearer}` };
    const task = await server.inject({
      method: "POST",
      url: "/v1/tasks",
      remoteAddress: LAN_PEER,
      headers,
      payload: { title: "brief attribution", status: "in_progress", actorKind: "agent" }
    });
    const taskId = task.json().id as string;
    await server.inject({
      method: "POST",
      url: `/v1/entities/${taskId}/worklog`,
      remoteAddress: LAN_PEER,
      headers,
      payload: { body: "stopped at the migration", actorKind: "agent" }
    });
    const brief = await server.inject({
      method: "POST",
      url: "/v1/opening-brief",
      remoteAddress: LAN_PEER,
      headers,
      payload: {}
    });
    expect(brief.statusCode).toBe(200);
    expect(brief.json().markdown).toContain("by auth-test: stopped at the migration");
    expect(brief.json().latestWorklog[0]).toMatchObject({ actor: { label: "auth-test" } });
  });
});
