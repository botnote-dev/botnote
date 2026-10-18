import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_ID } from "../src/db/schema.js";
import { buildServer } from "../src/rest/server.js";
import type { AuthConfig } from "../src/rest/auth.js";
import { EmbeddingService } from "../src/service/embedding.js";
import {
  addWorklogEntry,
  get,
  getByKey,
  link,
  listChildren,
  listWorklog,
  listTags,
  listTrash,
  recent,
  remove,
  update,
  write
} from "../src/service/entities.js";
import { openingBrief } from "../src/service/opening_brief.js";
import { createProject, getProjectByKey, listProjects } from "../src/service/projects.js";
import {
  createRecurrenceRule,
  getRecurrenceForTask,
  materializeScheduledRecurrences,
  stopRecurrence
} from "../src/service/recurrence.js";
import { DEFAULT_SCOPE, scopeFor, type Scope } from "../src/service/scope.js";
import { search } from "../src/service/search.js";
import { tasksRange } from "../src/service/tasks.js";
import { createToken, listTokens } from "../src/service/tokens.js";
import { getWorkspaceSettings, updateWorkspaceSettings } from "../src/service/workspace_settings.js";
import { createTestDb } from "./test_db.js";

const { db, pool } = createTestDb();

const OTHER_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const A: Scope = DEFAULT_SCOPE;
const B: Scope = scopeFor(OTHER_WORKSPACE_ID);

beforeAll(async () => {
  await db.execute(
    sql`INSERT INTO workspaces (id, slug, name)
        VALUES (${OTHER_WORKSPACE_ID}::uuid, 'other', 'Other workspace')
        ON CONFLICT (id) DO NOTHING`
  );
});

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE recurrence_exceptions, recurrence_rules, entities, edges, projects, tokens, sessions,
             workspace_settings, embedding_settings
    RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  await db.execute(sql`
    TRUNCATE recurrence_exceptions, recurrence_rules, entities, edges, projects, tokens, sessions,
             workspace_settings, embedding_settings
    RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`DELETE FROM workspaces WHERE id = ${OTHER_WORKSPACE_ID}::uuid`);
  await pool.end();
});

function taskInput(title: string, projectId: string | null = null, extra: Record<string, unknown> = {}) {
  return {
    kind: "task" as const,
    projectId,
    title,
    body: `${title} body`,
    tags: ["shared-tag"],
    status: "open",
    actorKind: "agent" as const,
    metadata: {},
    ...extra
  };
}

describe("workspace scope: isolation across workspaces", () => {
  it("stamps writes with the scope's workspace and hides them from the other scope", async () => {
    const a = await write(A, db, taskInput("in A"));
    const b = await write(B, db, taskInput("in B"));
    expect(a.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(b.workspaceId).toBe(OTHER_WORKSPACE_ID);

    expect(await get(A, db, b.id)).toBeNull();
    expect(await get(B, db, a.id)).toBeNull();
    expect(await get(A, db, b.id.slice(0, 8))).toBeNull();
    expect((await get(A, db, a.id))?.id).toBe(a.id);

    const recentA = await recent(A, db, { limit: 50 });
    const recentB = await recent(B, db, { limit: 50 });
    expect(recentA.map((e) => e.id)).toEqual([a.id]);
    expect(recentB.map((e) => e.id)).toEqual([b.id]);
  });

  it("keeps search, tags, trash and the opening brief inside the scope", async () => {
    const a = await write(A, db, taskInput("needle alpha"));
    const b = await write(B, db, taskInput("needle beta"));

    const hitsA = await search(A, db, { query: "needle", limit: 10, projectId: null, kind: undefined });
    const hitsB = await search(B, db, { query: "needle", limit: 10, projectId: null, kind: undefined });
    expect(hitsA.map((h) => h.entity.id)).toEqual([a.id]);
    expect(hitsB.map((h) => h.entity.id)).toEqual([b.id]);

    const tagsA = await listTags(A, db, { projectId: null });
    expect(tagsA).toEqual([{ tag: "shared-tag", count: 1 }]);

    expect(await remove(B, db, a.id)).toBe(false);
    expect(await remove(A, db, a.id)).toBe(true);
    expect((await listTrash(A, db)).map((e) => e.id)).toEqual([a.id]);
    expect(await listTrash(B, db)).toEqual([]);

    const briefB = await openingBrief(B, db, { projectId: null, recentLimit: 10 });
    expect(briefB.openTasks.map((t) => t.id)).toEqual([b.id]);
    expect(briefB.recent.map((t) => t.id)).toEqual([b.id]);
  });

  it("refuses cross-workspace updates, worklog entries, parents and links", async () => {
    const a = await write(A, db, taskInput("owner A"));
    const b = await write(B, db, taskInput("owner B"));

    await expect(update(B, db, a.id, { title: "hijacked" })).rejects.toThrow(/not found/);
    expect((await get(A, db, a.id))?.title).toBe("owner A");

    await expect(addWorklogEntry(B, db, a.id, { body: "nope", actorKind: "agent" })).rejects.toThrow(/not found/);
    expect(await listWorklog(B, db, a.id)).toEqual([]);

    await expect(write(B, db, taskInput("child of A", null, { parentId: a.id }))).rejects.toThrow(/not found/);
    await expect(update(A, db, a.id, { parentId: b.id })).rejects.toThrow(/not found/);
    expect(await listChildren(B, db, a.id)).toEqual([]);

    await expect(link(A, db, { fromId: a.id, toId: b.id, kind: "references" })).rejects.toThrow(/not found/);
    await expect(link(A, db, { fromId: a.id, toId: a.id, kind: "references" })).rejects.toThrow(/itself/);
  });

  it("lets two workspaces reuse the same project key and idempotency key", async () => {
    const pa = await createProject(A, db, { key: "DUP", name: "A's DUP" });
    const pb = await createProject(B, db, { key: "DUP", name: "B's DUP" });
    expect(pa.id).not.toBe(pb.id);
    expect((await getProjectByKey(A, db, "DUP"))?.id).toBe(pa.id);
    expect((await getProjectByKey(B, db, "DUP"))?.id).toBe(pb.id);
    expect((await listProjects(B, db, { includeArchived: true })).map((p) => p.id)).toEqual([pb.id]);

    const ea = await write(A, db, taskInput("same key", pa.id, { idempotencyKey: "idem-1" }));
    const eb = await write(B, db, taskInput("same key", pb.id, { idempotencyKey: "idem-1" }));
    expect(ea.id).not.toBe(eb.id);
    const eaAgain = await write(A, db, taskInput("same key again", pa.id, { idempotencyKey: "idem-1" }));
    expect(eaAgain.id).toBe(ea.id);

    expect(ea.sequenceId).toBe(1);
    expect(eb.sequenceId).toBe(1);
    expect((await getByKey(A, db, "DUP", 1))?.id).toBe(ea.id);
    expect((await getByKey(B, db, "DUP", 1))?.id).toBe(eb.id);
  });

  it("isolates tokens and workspace settings per workspace", async () => {
    await createToken(A, db, { name: "a-token" });
    await createToken(B, db, { name: "b-token" });
    expect((await listTokens(A, db)).map((t) => t.name)).toEqual(["a-token"]);
    expect((await listTokens(B, db)).map((t) => t.name)).toEqual(["b-token"]);

    await updateWorkspaceSettings(B, db, { timezone: "Asia/Shanghai" });
    expect((await getWorkspaceSettings(A, db)).timezone).toBe("UTC");
    expect((await getWorkspaceSettings(B, db)).timezone).toBe("Asia/Shanghai");
  });

  it("keeps recurrence rules and materialized occurrences in their own workspace", async () => {
    const due = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const seedB = await write(B, db, taskInput("daily B", null, { dueAt: due }));
    const rule = await createRecurrenceRule(B, db, seedB.id, {
      preset: "daily",
      interval: 1,
      allDay: true,
      anchor: "scheduled"
    });
    expect(rule.workspaceId).toBe(OTHER_WORKSPACE_ID);

    await expect(getRecurrenceForTask(A, db, seedB.id)).rejects.toThrow(/not found/);
    await expect(stopRecurrence(A, db, rule.id)).rejects.toThrow(/not found/);

    const created = await materializeScheduledRecurrences(db, new Date());
    expect(created.length).toBeGreaterThan(0);
    for (const occurrence of created) expect(occurrence.workspaceId).toBe(OTHER_WORKSPACE_ID);

    const rangeA = await tasksRange(A, db, { includeDone: false, includeBacklog: true });
    const rangeB = await tasksRange(B, db, { includeDone: false, includeBacklog: true });
    expect([...rangeA.scheduled, ...rangeA.overdue, ...rangeA.backlog]).toEqual([]);
    const idsB = [...rangeB.scheduled, ...rangeB.overdue, ...rangeB.backlog].map((e) => e.id);
    expect(idsB).toContain(seedB.id);
  });
});

describe("workspace scope: REST resolves it from the credential", () => {
  const enforcing: AuthConfig = { required: true, trustLocalhost: false, trustedProxies: [] };
  let server: FastifyInstance;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    server = await buildServer({ db, embedding: new EmbeddingService(db), logLevel: "silent", auth: enforcing });
    await server.ready();
  });

  beforeEach(async () => {
    tokenA = (await createToken(A, db, { name: "rest-a" })).plaintext;
    tokenB = (await createToken(B, db, { name: "rest-b" })).plaintext;
  });

  afterAll(async () => {
    await server?.close();
  });

  async function call(token: string, method: "GET" | "POST", url: string, body?: unknown) {
    return server.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      remoteAddress: "203.0.113.9",
      ...(body === undefined ? {} : { payload: body })
    });
  }

  it("routes each bearer token to its own workspace", async () => {
    const createdA = await call(tokenA, "POST", "/v1/tasks", { title: "via token A", body: "" });
    expect(createdA.statusCode).toBe(200);
    const idA = createdA.json().id as string;

    const createdB = await call(tokenB, "POST", "/v1/tasks", { title: "via token B", body: "" });
    expect(createdB.statusCode).toBe(200);
    const idB = createdB.json().id as string;

    expect((await call(tokenA, "GET", `/v1/entities/${idA}`)).statusCode).toBe(200);
    expect((await call(tokenB, "GET", `/v1/entities/${idA}`)).statusCode).toBe(404);
    expect((await call(tokenA, "GET", `/v1/entities/${idB}`)).statusCode).toBe(404);

    const recentB = await call(tokenB, "POST", "/v1/recent", { limit: 50 });
    expect(recentB.statusCode).toBe(200);
    expect(recentB.json().map((e: { id: string }) => e.id)).toEqual([idB]);

    const tokensB = await call(tokenB, "GET", "/v1/tokens");
    expect(tokensB.json().map((t: { name: string }) => t.name)).toEqual(["rest-b"]);
  });
});
