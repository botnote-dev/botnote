import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { entities, workspaces } from "../src/db/schema.js";
import { buildServer } from "../src/rest/server.js";
import { EmbeddingService } from "../src/service/embedding.js";
import { addWorklogEntry, link, remove, update, write } from "../src/service/entities.js";
import { submitFeedback } from "../src/service/feedback.js";
import { createProject } from "../src/service/projects.js";
import { createRecurrenceRule, skipOccurrence } from "../src/service/recurrence.js";
import { DEFAULT_SCOPE as S } from "../src/service/scope.js";
import { createToken } from "../src/service/tokens.js";
import {
  exportWorkspace,
  FORMAT_VERSION,
  importWorkspace,
  RECORD_TYPES,
  type RecordType
} from "../src/service/transfer.js";
import { updateWorkspaceSettings } from "../src/service/workspace_settings.js";
import { createTestDb } from "./test_db.js";

const { db, pool } = createTestDb();
const embedding = new EmbeddingService(db);
let server: FastifyInstance;

interface Record {
  type: RecordType;
  [key: string]: unknown;
}

async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const l of gen) out.push(l.trimEnd());
  return out;
}

function records(lines: string[]): Record[] {
  return lines.slice(1).map((l) => JSON.parse(l) as Record);
}

function expectSameRecords(actual: Record[], expected: Record[]): void {
  const changed = expected
    .map((before, i) => ({ i, before, after: actual[i] }))
    .filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after));
  expect(changed).toEqual([]);
  expect(actual).toHaveLength(expected.length);
}

function countBy(rows: Record[]): Map<RecordType, number> {
  const m = new Map<RecordType, number>();
  for (const r of rows) m.set(r.type, (m.get(r.type) ?? 0) + 1);
  return m;
}

async function wipe(opts: { tokens?: boolean } = {}): Promise<void> {
  await db.execute(
    sql`TRUNCATE projects, entities, edges, recurrence_rules, recurrence_exceptions, entity_revisions, workspace_settings RESTART IDENTITY CASCADE`
  );
  if (opts.tokens) await db.execute(sql`TRUNCATE tokens, sessions RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM workspaces WHERE id <> ${S.workspaceId}::uuid`);
}

async function seed() {
  const { token } = await createToken(S, db, { name: "Exporter" });
  const ops = await createProject(S, db, { key: "OPS", name: "Ops" });
  const lab = await createProject(S, db, { key: "LAB", name: "Lab" });
  const task = await write(S, db, {
    kind: "task",
    projectId: ops.id,
    title: "Rotate certs",
    body: "step 1\nstep 2",
    tags: ["certs", "infra"],
    status: "in_progress",
    priority: "high",
    dueAt: new Date("2030-03-01T12:00:00Z"),
    pinned: true,
    idempotencyKey: "seed-task-1",
    actorKind: "agent",
    actorTokenId: token.id,
    metadata: { source: "seed", nested: { n: 1 } }
  });
  const blocker = await write(S, db, {
    kind: "task",
    projectId: ops.id,
    title: "Order HSM",
    body: "",
    tags: [],
    status: "open",
    actorKind: "human",
    metadata: {}
  });
  const note = await write(S, db, {
    kind: "note",
    projectId: lab.id,
    title: null,
    body: "Certs expire yearly",
    tags: ["certs"],
    status: "open",
    actorKind: "human",
    metadata: {},
    pinned: true
  });
  await addWorklogEntry(
    S,
    db,
    task.id,
    { body: "renewed staging", actorKind: "agent", metadata: {} },
    { actorTokenId: token.id }
  );
  await submitFeedback(S, db, {
    category: "friction",
    title: "export is slow",
    body: "",
    actorKind: "agent",
    projectId: ops.id
  });
  const trashed = await write(S, db, {
    kind: "note",
    projectId: null,
    title: "Old",
    body: "gone",
    tags: [],
    status: "open",
    actorKind: "human",
    metadata: {}
  });
  await remove(S, db, trashed.id);
  await link(S, db, { fromId: blocker.id, toId: task.id, kind: "blocks" });
  await link(S, db, { fromId: note.id, toId: task.id, kind: "references" });
  await update(S, db, task.id, { title: "Rotate the certs", bodyAppend: "step 3" }, { actorTokenId: token.id });
  await update(S, db, task.id, { priority: "urgent" });
  const recurring = await write(S, db, {
    kind: "task",
    projectId: ops.id,
    title: "Weekly backup check",
    body: "",
    tags: [],
    status: "open",
    dueAt: new Date("2030-01-07T12:00:00Z"),
    actorKind: "human",
    metadata: {}
  });
  await createRecurrenceRule(S, db, recurring.id, {
    preset: "weekly",
    interval: 1,
    timezone: "UTC",
    allDay: true,
    anchor: "scheduled"
  });
  await skipOccurrence(S, db, recurring.id, { reason: "holiday" });
  await updateWorkspaceSettings(S, db, { timezone: "Asia/Shanghai" });
  return { token, ops, lab, task };
}

beforeAll(async () => {
  server = await buildServer({
    db,
    embedding,
    logLevel: "silent",
    auth: { required: false, trustLocalhost: true, trustedProxies: ["loopback"] }
  });
  await server.ready();
});

beforeEach(async () => {
  await wipe({ tokens: true });
});

afterAll(async () => {
  await server?.close();
  await pool.end();
});

describe("workspace export/import", () => {
  it("round-trips every table losslessly and keeps KEY-SEQ counters ahead of imported rows", async () => {
    const { ops } = await seed();
    const first = await collect(exportWorkspace(S, db));

    const header = JSON.parse(first[0]!) as { type: string; formatVersion: number; includesVectors: boolean; workspace: { id: string } };
    expect(header).toMatchObject({
      type: "header",
      formatVersion: FORMAT_VERSION,
      includesVectors: false,
      workspace: { id: S.workspaceId }
    });

    const rows = records(first);
    const types = rows.map((r) => r.type);
    expect(new Set(types)).toEqual(new Set(RECORD_TYPES));
    expect(types.lastIndexOf("project")).toBeLessThan(types.indexOf("entity"));
    expect(types.lastIndexOf("entity")).toBeLessThan(types.indexOf("edge"));
    expect(types.lastIndexOf("recurrence_rule")).toBeLessThan(types.indexOf("recurrence_exception"));
    expect(rows.every((r) => !("bodyVec" in r) && !("bodyTsv" in r) && !("workspaceId" in r))).toBe(true);
    const trashed = rows.find((r) => r.type === "entity" && r.title === "Old");
    expect(trashed?.deletedAt).toBeTruthy();

    await wipe();
    const report = await importWorkspace(S, db, first);
    expect(report.conflictsTotal).toBe(0);
    expect(report.conflicts).toEqual([]);
    const expected = countBy(rows);
    for (const type of RECORD_TYPES) {
      expect(report.counts[type], type).toEqual({ imported: expected.get(type) ?? 0, skipped: 0, conflicts: 0 });
    }
    expect(report.entitiesWithoutVector).toBe(expected.get("entity"));

    const second = await collect(exportWorkspace(S, db));
    expectSameRecords(records(second), rows);

    const maxSeq = Math.max(
      ...rows
        .filter((r) => r.type === "entity" && r.projectId === ops.id && typeof r.sequenceId === "number")
        .map((r) => r.sequenceId as number)
    );
    const fresh = await write(S, db, {
      kind: "task",
      projectId: ops.id,
      title: "After import",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    expect(fresh.sequenceId).toBe(maxSeq + 1);
  });

  it("is idempotent: re-importing the same dump changes nothing", async () => {
    await seed();
    const dump = await collect(exportWorkspace(S, db));
    const rows = records(dump);

    const report = await importWorkspace(S, db, dump);
    expect(report.conflictsTotal).toBe(0);
    const expected = countBy(rows);
    for (const type of RECORD_TYPES) {
      if (type === "settings") continue;
      expect(report.counts[type], type).toEqual({ imported: 0, skipped: expected.get(type) ?? 0, conflicts: 0 });
    }
    expectSameRecords(records(await collect(exportWorkspace(S, db))), rows);
  });

  it("imports pre-0.2.16 dumps whose worklog entries carry kind comment", async () => {
    await seed();
    const dump = await collect(exportWorkspace(S, db));
    const legacy = dump.map((line) => line.replace('"kind":"worklog"', '"kind":"comment"'));
    expect(legacy.some((line) => line.includes('"kind":"comment"'))).toBe(true);
    await wipe();

    const report = await importWorkspace(S, db, legacy);
    expect(report.conflictsTotal).toBe(0);
    const kinds = await db
      .execute<{ kind: string }>(sql`SELECT DISTINCT kind FROM entities ORDER BY kind`)
      .then((r) => r.rows.map((row) => row.kind));
    expect(kinds).toContain("worklog");
    expect(kinds).not.toContain("comment");
  });

  it("round-trips vectors when asked and re-embeds nothing that arrived with one", async () => {
    const { task } = await seed();
    const vec = Array.from({ length: 384 }, (_, i) => (i % 7) / 10);
    await db.execute(sql`UPDATE entities SET body_vec = ${`[${vec.join(",")}]`}::vector WHERE id = ${task.id}::uuid`);

    const withVectors = await collect(exportWorkspace(S, db, { includeVectors: true }));
    const exported = records(withVectors).find((r) => r.id === task.id);
    expect((exported?.bodyVec as number[]).length).toBe(384);

    await wipe();
    const report = await importWorkspace(S, db, withVectors);
    const entityCount = countBy(records(withVectors)).get("entity")!;
    expect(report.counts.entity.imported).toBe(entityCount);
    expect(report.entitiesWithoutVector).toBe(entityCount - 1);
    const [row] = await db.execute<{ has_vec: boolean }>(
      sql`SELECT body_vec IS NOT NULL AS has_vec FROM entities WHERE id = ${task.id}::uuid`
    ).then((r) => r.rows);
    expect(row?.has_vec).toBe(true);
  });

  it("reports cross-workspace id collisions and taken project keys instead of aborting", async () => {
    const { ops, task } = await seed();
    const dump = await collect(exportWorkspace(S, db));
    const rows = records(dump);
    await wipe();

    const [other] = await db.insert(workspaces).values({ slug: "other", name: "Other" }).returning();
    await db.insert(entities).values({
      id: task.id,
      workspaceId: other!.id,
      kind: "note",
      body: "lives elsewhere",
      actorKind: "human"
    });
    const squatter = await createProject(S, db, { key: "OPS", name: "Someone else's OPS" });

    const report = await importWorkspace(S, db, dump);
    expect(report.counts.project).toEqual({ imported: 1, skipped: 0, conflicts: 1 });
    expect(report.conflicts).toContainEqual({
      type: "project",
      id: ops.id,
      reason: `key OPS already belongs to project ${squatter.id}`
    });
    expect(report.conflicts).toContainEqual({
      type: "entity",
      id: task.id,
      reason: "id already exists in another workspace"
    });
    const opsEntities = rows.filter((r) => r.type === "entity" && r.projectId === ops.id && r.id !== task.id);
    for (const e of opsEntities) {
      expect(report.conflicts).toContainEqual({
        type: "entity",
        id: e.id,
        reason: `project ${ops.id} is not in the target workspace`
      });
    }
    expect(report.counts.entity.conflicts).toBe(opsEntities.length + 1);
    expect(report.counts.edge.conflicts).toBeGreaterThan(0);
    expect(report.counts.recurrence_rule.conflicts).toBe(1);
    expect(report.counts.recurrence_exception.conflicts).toBe(1);
    expect(report.counts.entity_revision.conflicts).toBe(2);
    const labEntities = rows.filter((r) => r.type === "entity" && r.projectId !== ops.id && r.id !== task.id);
    expect(report.counts.entity.imported).toBe(labEntities.length);
  });

  it("rejects dumps it cannot read with a 400-class error", async () => {
    const header = (formatVersion: number) =>
      JSON.stringify({ type: "header", formatVersion, botnoteVersion: "x", exportedAt: "", workspace: { id: "w" } });
    await expect(importWorkspace(S, db, [header(FORMAT_VERSION + 1)])).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("formatVersion")
    });
    await expect(importWorkspace(S, db, ['{"type":"entity"}'])).rejects.toMatchObject({
      statusCode: 400,
      message: "line 1 must be the export header"
    });
    await expect(importWorkspace(S, db, [header(1), '{"type":"spreadsheet"}'])).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("unknown record type")
    });
    await expect(importWorkspace(S, db, [header(1), '{"type":"project","id":"nope"}'])).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("invalid project record")
    });
    await expect(importWorkspace(S, db, [])).rejects.toMatchObject({ statusCode: 400 });
  });

  it("streams over REST as application/x-ndjson in both directions", async () => {
    await seed();
    const exported = await server.inject({ method: "GET", url: "/v1/export", remoteAddress: "127.0.0.1" });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/x-ndjson");
    expect(exported.headers["content-disposition"]).toContain("botnote-export-");
    const lines = exported.body.trimEnd().split("\n");
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "header", formatVersion: FORMAT_VERSION });
    const rows = records(lines);
    expect(rows.length).toBeGreaterThan(5);

    await wipe();
    const imported = await server.inject({
      method: "POST",
      url: "/v1/import",
      remoteAddress: "127.0.0.1",
      headers: { "content-type": "application/x-ndjson" },
      payload: exported.body
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({
      formatVersion: FORMAT_VERSION,
      conflictsTotal: 0,
      counts: { entity: { imported: countBy(rows).get("entity"), skipped: 0, conflicts: 0 } }
    });

    const again = await server.inject({ method: "GET", url: "/v1/export", remoteAddress: "127.0.0.1" });
    expectSameRecords(records(again.body.trimEnd().split("\n")), rows);

    const wrongType = await server.inject({
      method: "POST",
      url: "/v1/import",
      remoteAddress: "127.0.0.1",
      headers: { "content-type": "text/plain" },
      payload: exported.body
    });
    expect(wrongType.statusCode).not.toBe(200);
  });
});
