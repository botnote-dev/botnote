import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sessions, tokens, users, workspaceMembers } from "../src/db/schema.js";
import type { AuthConfig } from "../src/rest/auth.js";
import { buildServer } from "../src/rest/server.js";
import { EmbeddingService } from "../src/service/embedding.js";
import { DEFAULT_SCOPE as S } from "../src/service/scope.js";
import { createSession } from "../src/service/sessions.js";
import { createToken } from "../src/service/tokens.js";
import {
  authenticate,
  changePassword,
  createOwner,
  hashPassword,
  hasUsers,
  resetPassword,
  verifyPassword
} from "../src/service/users.js";
import { createTestDb } from "./test_db.js";

const { db, pool } = createTestDb();
const embedding = new EmbeddingService(db);

const CLIENT = "203.0.113.9";
const OWNER = { email: "Owner@Example.com", name: "Owner", password: "correct horse battery" };

const open: AuthConfig = { required: false, trustLocalhost: true, trustedProxies: ["loopback"] };
const enforcing: AuthConfig = { ...open, required: true };

async function reset() {
  await db.execute(sql`TRUNCATE users, tokens, sessions RESTART IDENTITY CASCADE`);
}

function post(server: FastifyInstance, url: string, payload: unknown, cookie?: string) {
  return server.inject({
    method: "POST",
    url,
    remoteAddress: CLIENT,
    payload: payload as Record<string, unknown>,
    cookies: cookie ? { botnote_session: cookie } : undefined
  });
}

function get(server: FastifyInstance, url: string, cookie?: string) {
  return server.inject({
    method: "GET",
    url,
    remoteAddress: CLIENT,
    cookies: cookie ? { botnote_session: cookie } : undefined
  });
}

function sessionCookie(res: Awaited<ReturnType<typeof post>>): string {
  const cookie = res.cookies.find((c) => c.name === "botnote_session");
  expect(cookie).toBeDefined();
  return cookie!.value;
}

beforeEach(reset);

afterAll(async () => {
  await reset();
  delete process.env.BOTNOTE_PASSWORD;
  await pool.end();
});

describe("password hashing", () => {
  it("verifies the right password and nothing else", async () => {
    const hash = await hashPassword("s3cret-enough");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("s3cret-enough");
    expect(await verifyPassword("s3cret-enough", hash)).toBe(true);
    expect(await verifyPassword("s3cret-enougH", hash)).toBe(false);
    expect(await verifyPassword("s3cret-enough", null)).toBe(false);
    expect(await verifyPassword("s3cret-enough", "plain$text")).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same-password")).not.toBe(await hashPassword("same-password"));
  });
});

describe("accounts service", () => {
  it("makes the first account the owner and refuses a second setup", async () => {
    expect(await hasUsers(db)).toBe(false);
    const owner = await createOwner(S, db, OWNER);
    expect(owner).toMatchObject({ email: "owner@example.com", name: "Owner", role: "owner" });
    expect(await hasUsers(db)).toBe(true);

    const members = await db.select().from(workspaceMembers);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: owner.id, workspaceId: S.workspaceId, role: "owner" });

    await expect(
      createOwner(S, db, { email: "second@example.com", name: "Second", password: "another password" })
    ).rejects.toMatchObject({ statusCode: 409, code: "setup_done" });
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("lets only one of two simultaneous first visitors become owner", async () => {
    const results = await Promise.allSettled([
      createOwner(S, db, { email: "a@example.com", name: "A", password: "password-a-1" }),
      createOwner(S, db, { email: "b@example.com", name: "B", password: "password-b-1" })
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("hands existing tokens to the owner and drops password-mode sessions", async () => {
    const { token } = await createToken(S, db, { name: "agent" });
    await createSession(S, db, {});
    const owner = await createOwner(S, db, OWNER);

    const [row] = await db.select().from(tokens).where(eq(tokens.id, token.id));
    expect(row!.userId).toBe(owner.id);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("authenticates by email in any letter case and rejects everything else", async () => {
    const owner = await createOwner(S, db, OWNER);
    expect((await authenticate(db, "OWNER@example.com ", OWNER.password))?.id).toBe(owner.id);
    expect(await authenticate(db, "owner@example.com", "wrong password")).toBeNull();
    expect(await authenticate(db, "nobody@example.com", OWNER.password)).toBeNull();

    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, owner.id));
    expect(await authenticate(db, "owner@example.com", OWNER.password)).toBeNull();
  });

  it("changes a password, keeps the current browser and signs out the others", async () => {
    const owner = await createOwner(S, db, OWNER);
    const here = await createSession(S, db, { userId: owner.id });
    await createSession(S, db, { userId: owner.id });

    await expect(
      changePassword(db, { userId: owner.id, currentPassword: "wrong", newPassword: "brand new password" })
    ).rejects.toMatchObject({ statusCode: 403, code: "invalid_password" });

    await changePassword(db, {
      userId: owner.id,
      currentPassword: OWNER.password,
      newPassword: "brand new password",
      keepSessionId: here.session.id
    });
    expect(await authenticate(db, OWNER.email, OWNER.password)).toBeNull();
    expect(await authenticate(db, OWNER.email, "brand new password")).not.toBeNull();
    const left = await db.select().from(sessions);
    expect(left.map((s) => s.id)).toEqual([here.session.id]);
  });

  it("resets a password from the host and signs the user out", async () => {
    const owner = await createOwner(S, db, OWNER);
    await createSession(S, db, { userId: owner.id });

    expect(await resetPassword(db, "nobody@example.com")).toBeNull();
    const fresh = await resetPassword(db, "OWNER@example.com");
    expect(fresh).toBeTruthy();
    expect(await authenticate(db, OWNER.email, OWNER.password)).toBeNull();
    expect(await authenticate(db, OWNER.email, fresh!)).not.toBeNull();
    expect(await db.select().from(sessions)).toHaveLength(0);
  });
});

describe("first-run setup over REST", () => {
  let server: FastifyInstance;

  beforeAll(() => {
    delete process.env.BOTNOTE_PASSWORD;
  });

  beforeEach(async () => {
    await server?.close();
    server = await buildServer({ db, embedding, logLevel: "silent", auth: enforcing });
    await server.ready();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("offers setup to the first visitor and nothing else", async () => {
    const status = await get(server, "/v1/auth/status");
    expect(status.json()).toEqual({ setupRequired: true, setupCodeRequired: false, login: "none" });
    expect((await get(server, "/v1/projects")).statusCode).toBe(401);
  });

  it("creates the owner, signs them in, and closes setup", async () => {
    const setup = await post(server, "/v1/auth/setup", OWNER);
    expect(setup.statusCode).toBe(200);
    expect(setup.json().user).toMatchObject({ email: "owner@example.com", role: "owner" });
    const cookie = sessionCookie(setup);

    const who = await get(server, "/v1/auth/whoami", cookie);
    expect(who.json()).toMatchObject({
      authenticated: true,
      via: "cookie",
      user: { email: "owner@example.com", name: "Owner", role: "owner" }
    });
    expect((await get(server, "/v1/projects", cookie)).statusCode).toBe(200);

    expect((await get(server, "/v1/auth/status")).json()).toEqual({
      setupRequired: false,
      setupCodeRequired: false,
      login: "email"
    });
    const again = await post(server, "/v1/auth/setup", {
      email: "intruder@example.com",
      name: "Intruder",
      password: "intruder password"
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("setup_done");
  });

  it("rejects a weak password or a bad email", async () => {
    expect((await post(server, "/v1/auth/setup", { ...OWNER, password: "short" })).statusCode).toBe(400);
    expect((await post(server, "/v1/auth/setup", { ...OWNER, email: "not-an-email" })).statusCode).toBe(400);
    expect(await hasUsers(db)).toBe(false);
  });

  it("signs in with email and password, and only with both right", async () => {
    await post(server, "/v1/auth/setup", OWNER);

    const ok = await post(server, "/v1/auth/login", { email: "owner@example.com", password: OWNER.password });
    expect(ok.statusCode).toBe(200);
    expect((await get(server, "/v1/projects", sessionCookie(ok))).statusCode).toBe(200);

    for (const payload of [
      { email: "owner@example.com", password: "wrong password" },
      { email: "nobody@example.com", password: OWNER.password },
      { password: OWNER.password }
    ]) {
      const res = await post(server, "/v1/auth/login", payload);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "invalid_credentials" });
    }
  });

  it("changes the password through the API", async () => {
    const cookie = sessionCookie(await post(server, "/v1/auth/setup", OWNER));
    const bad = await post(
      server,
      "/v1/auth/password",
      { currentPassword: "wrong", newPassword: "a whole new password" },
      cookie
    );
    expect(bad.statusCode).toBe(403);

    const ok = await post(
      server,
      "/v1/auth/password",
      { currentPassword: OWNER.password, newPassword: "a whole new password" },
      cookie
    );
    expect(ok.statusCode).toBe(200);
    expect((await get(server, "/v1/auth/whoami", cookie)).statusCode).toBe(200);
    const login = await post(server, "/v1/auth/login", {
      email: OWNER.email,
      password: "a whole new password"
    });
    expect(login.statusCode).toBe(200);
  });

  it("keeps bearer tokens working after setup", async () => {
    const { plaintext } = await createToken(S, db, { name: "agent" });
    await post(server, "/v1/auth/setup", OWNER);
    const res = await server.inject({
      method: "GET",
      url: "/v1/projects",
      remoteAddress: CLIENT,
      headers: { authorization: `Bearer ${plaintext}` }
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("an instance that already runs on BOTNOTE_PASSWORD", () => {
  const PASSWORD = "instance-password";
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.BOTNOTE_PASSWORD = PASSWORD;
    await server?.close();
    server = await buildServer({ db, embedding, logLevel: "silent", auth: enforcing });
    await server.ready();
  });

  afterAll(async () => {
    await server?.close();
    delete process.env.BOTNOTE_PASSWORD;
  });

  it("still signs in with the instance password until an account exists", async () => {
    expect((await get(server, "/v1/auth/status")).json()).toEqual({
      setupRequired: true,
      setupCodeRequired: true,
      login: "password"
    });
    const login = await post(server, "/v1/auth/login", { password: PASSWORD });
    expect(login.statusCode).toBe(200);
    const who = await get(server, "/v1/auth/whoami", sessionCookie(login));
    expect(who.json()).toMatchObject({ authenticated: true, via: "cookie", user: null });
  });

  it("asks for the instance password before letting anyone claim it", async () => {
    const without = await post(server, "/v1/auth/setup", OWNER);
    expect(without.statusCode).toBe(403);
    expect(without.json().error).toBe("invalid_setup_code");
    const wrong = await post(server, "/v1/auth/setup", { ...OWNER, setupCode: "guess" });
    expect(wrong.statusCode).toBe(403);
    expect(await hasUsers(db)).toBe(false);

    const ok = await post(server, "/v1/auth/setup", { ...OWNER, setupCode: PASSWORD });
    expect(ok.statusCode).toBe(200);
  });

  it("retires the instance password and its sessions once an account exists", async () => {
    const legacy = sessionCookie(await post(server, "/v1/auth/login", { password: PASSWORD }));
    expect((await get(server, "/v1/projects", legacy)).statusCode).toBe(200);

    await post(server, "/v1/auth/setup", { ...OWNER, setupCode: PASSWORD });

    expect((await get(server, "/v1/projects", legacy)).statusCode).toBe(401);
    const login = await post(server, "/v1/auth/login", { password: PASSWORD });
    expect(login.statusCode).toBe(401);
  });
});

describe("a local install with auth not enforced", () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    delete process.env.BOTNOTE_PASSWORD;
    await server?.close();
    server = await buildServer({ db, embedding, logLevel: "silent", auth: open });
    await server.ready();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("stays open until an account is created, then asks remote callers to sign in", async () => {
    expect((await get(server, "/v1/projects")).statusCode).toBe(200);
    await post(server, "/v1/auth/setup", OWNER);
    expect((await get(server, "/v1/projects")).statusCode).toBe(401);

    const local = await server.inject({ method: "GET", url: "/v1/projects", remoteAddress: "127.0.0.1" });
    expect(local.statusCode).toBe(200);
  });
});
