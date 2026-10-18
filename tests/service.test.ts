import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EmbeddingService } from "../src/service/embedding.js";
import {
  embeddingCoverage,
  getEmbeddingSettings,
  updateEmbeddingSettings
} from "../src/service/embedding_settings.js";
import {
  addWorklogEntry,
  bumpAccess,
  get,
  getByKey,
  getLinks,
  link,
  listChildren,
  listWorklog,
  listTags,
  markSuperseded,
  recent,
  remove,
  restore,
  setBodyVec,
  purge,
  update,
  write
} from "../src/service/entities.js";
import { attachHierarchy, hierarchyFor } from "../src/service/hierarchy.js";
import { listRevisions, REVISION_RETENTION } from "../src/service/revisions.js";
import { createSession, pruneExpiredSessions } from "../src/service/sessions.js";
import { sessions } from "../src/db/schema.js";
import { formatOpeningBrief, openingBrief } from "../src/service/opening_brief.js";
import {
  createProject,
  getProjectByKey,
  listProjects,
  updateProject
} from "../src/service/projects.js";
import {
  createRecurrenceRule,
  getRecurrenceForTask,
  materializeScheduledRecurrences,
  skipOccurrence,
  splitRecurrence,
  stopRecurrence
} from "../src/service/recurrence.js";
import { eq, and } from "drizzle-orm";
import { entities, recurrenceExceptions, recurrenceRules } from "../src/db/schema.js";
import { listFeedback, submitFeedback } from "../src/service/feedback.js";
import { findSimilar, search, timeDecayFor } from "../src/service/search.js";
import { tasksRange } from "../src/service/tasks.js";
import { consumeToken, createToken, listTokens, revokeToken } from "../src/service/tokens.js";
import {
  getWorkspaceSettings,
  updateWorkspaceSettings
} from "../src/service/workspace_settings.js";
import { allDayDueAtInZone } from "../src/service/dates.js";
import { DEFAULT_SCOPE as S } from "../src/service/scope.js";
import { createTestDb } from "./test_db.js";

const { db, pool } = createTestDb();

beforeAll(async () => {
  await db.execute(sql`SELECT 1`);
});

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE recurrence_exceptions, recurrence_rules, entities, edges, projects, tokens, sessions, embedding_settings, workspace_settings
    RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  await pool.end();
});

async function withEntitiesTouchDisabled(fn: () => Promise<void>): Promise<void> {
  await db.execute(sql`ALTER TABLE entities DISABLE TRIGGER entities_touch_updated_at`);
  try {
    await fn();
  } finally {
    await db.execute(sql`ALTER TABLE entities ENABLE TRIGGER entities_touch_updated_at`);
  }
}

describe("botnote service", () => {
  it("creates a project and looks it up by key", async () => {
    const p = await createProject(S, db, {
      key: "TEST",
      name: "Test Project",
      agentsMd: "## Rules\nALWAYS test."
    });
    expect(p.key).toBe("TEST");
    expect(p.status).toBe("active");
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);

    const found = await getProjectByKey(S, db, "TEST");
    expect(found?.id).toBe(p.id);
  });

  it("updates project status for active lifecycle states", async () => {
    const p = await createProject(S, db, {
      key: "STAT",
      name: "Status Project",
      status: "planned"
    });
    expect(p.status).toBe("planned");

    const updated = await updateProject(S, db, p.id, { status: "watching" });
    expect(updated.status).toBe("watching");

    const found = await getProjectByKey(S, db, "STAT");
    expect(found?.status).toBe("watching");

    const archived = await updateProject(S, db, p.id, { status: "archived" });
    expect(archived.status).toBe("archived");
    expect(archived.archivedAt).not.toBeNull();

    const restored = await updateProject(S, db, p.id, { status: "active" });
    expect(restored.status).toBe("active");
    expect(restored.archivedAt).toBeNull();
  });

  it("archives projects and hides their entities from workspace views by default", async () => {
    const active = await createProject(S, db, { key: "ACT", name: "Active" });
    const archived = await createProject(S, db, { key: "ARC", name: "Archived" });
    const dueAt = new Date("2026-06-25T12:00:00.000Z");

    await write(S, db, {
      kind: "task",
      projectId: active.id,
      title: "Visible active task",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });
    const archivedTask = await write(S, db, {
      kind: "task",
      projectId: archived.id,
      title: "Hidden archived task",
      body: "archive-only needle",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });

    const archivedProject = await updateProject(S, db, archived.id, { status: "archived" });
    expect(archivedProject.status).toBe("archived");
    expect(archivedProject.archivedAt).not.toBeNull();

    expect((await listProjects(S, db)).map((p) => p.key)).toEqual(["ACT"]);
    expect((await listProjects(S, db, { includeArchived: true })).map((p) => p.key)).toEqual([
      "ACT",
      "ARC"
    ]);

    const recentRows = await recent(S, db, { limit: 10 });
    expect(recentRows.map((e) => e.id)).not.toContain(archivedTask.id);
    const archivedRecentRows = await recent(S, db, { projectId: archived.id, limit: 10 });
    expect(archivedRecentRows.map((e) => e.id)).toContain(archivedTask.id);

    expect((await search(S, db, { query: "archive-only needle", limit: 5 })).length).toBe(0);
    expect(
      (await search(S, db, { query: "archive-only needle", projectId: archived.id, limit: 5 }))[0]
        ?.entity.id
    ).toBe(archivedTask.id);

    const range = await tasksRange(S, db, {
      from: new Date("2026-06-25T00:00:00.000Z"),
      to: new Date("2026-06-26T00:00:00.000Z"),
      includeBacklog: false,
      includeDone: false
    });
    expect(range.scheduled.map((e) => e.id)).not.toContain(archivedTask.id);

    const archivedRange = await tasksRange(S, db, {
      from: new Date("2026-06-25T00:00:00.000Z"),
      to: new Date("2026-06-26T00:00:00.000Z"),
      projectIds: [archived.id],
      includeBacklog: false,
      includeDone: false
    });
    expect(archivedRange.scheduled.map((e) => e.id)).toContain(archivedTask.id);

    const restored = await updateProject(S, db, archived.id, { status: "active" });
    expect(restored.status).toBe("active");
    expect(restored.archivedAt).toBeNull();
    expect((await listProjects(S, db)).map((p) => p.key)).toEqual(["ACT", "ARC"]);
  });

  it("write entity + get + update + recent", async () => {
    const p = await createProject(S, db, { key: "WORK", name: "Work" });

    const t = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Build botnote v0",
      body: "Lightweight, agent-first.",
      tags: ["roadmap", "v0"],
      status: "open",
      actorKind: "human",
      metadata: {},
      idempotencyKey: null
    });
    expect(t.kind).toBe("task");

    const fetched = await get(S, db, t.id);
    expect(fetched?.title).toBe("Build botnote v0");

    const fetchedByPrefix = await get(S, db, t.id.slice(0, 8));
    expect(fetchedByPrefix?.id).toBe(t.id);

    const prefixUpdated = await update(S, db, t.id.slice(0, 8), { priority: "high" });
    expect(prefixUpdated.priority).toBe("high");

    const updated = await update(S, db, t.id, { status: "done" });
    expect(updated.status).toBe("done");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(updated.createdAt.getTime());

    const list = await recent(S, db, { projectId: p.id, limit: 10 });
    expect(list.length).toBe(1);
  });

  it("moves an entity between projects and to workspace scope", async () => {
    const source = await createProject(S, db, { key: "SRC", name: "Source" });
    const destination = await createProject(S, db, { key: "DST", name: "Destination" });
    const task = await write(S, db, {
      kind: "task",
      projectId: source.id,
      title: "Move this task",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });

    const moved = await update(S, db, task.id, { projectId: destination.id });
    expect(moved.projectId).toBe(destination.id);
    expect(await recent(S, db, { projectId: source.id, limit: 10 })).toEqual([]);
    expect((await recent(S, db, { projectId: destination.id, limit: 10 }))[0]?.id).toBe(task.id);

    const unscoped = await update(S, db, task.id, { projectId: null });
    expect(unscoped.projectId).toBeNull();
    expect((await recent(S, db, { projectId: null, limit: 10 }))[0]?.id).toBe(task.id);
  });

  it("write is idempotent on idempotency_key", async () => {
    const p = await createProject(S, db, { key: "IDP", name: "Idp" });
    const input = {
      kind: "note" as const,
      projectId: p.id,
      title: "First write",
      body: "x",
      tags: [],
      status: "open",
      actorKind: "agent" as const,
      metadata: {},
      idempotencyKey: "k-1"
    };
    const first = await write(S, db, input);
    const second = await write(S, db, {
      ...input,
      title: "Different title"
    });
    expect(second.id).toBe(first.id);
    expect(second.title).toBe("First write");
  });

  it("normalizes retired delayed and archived statuses to done", async () => {
    const p = await createProject(S, db, { key: "RET", name: "Retired statuses" });
    const delayed = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Normalize delayed task",
      body: "",
      tags: [],
      status: "delayed",
      actorKind: "human",
      metadata: {}
    });
    expect(delayed.status).toBe("done");
    expect(delayed.completedAt).not.toBeNull();

    const open = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Normalize archived update",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const archived = await update(S, db, open.id, { status: "archived" as never });
    expect(archived.status).toBe("done");
    expect(archived.completedAt).not.toBeNull();
  });

  it("allows explicit completedAt on done tasks and rejects it elsewhere", async () => {
    const p = await createProject(S, db, { key: "CMPL", name: "Completion stamps" });
    const backdated = new Date("2026-07-01T09:00:00.000Z");

    // Create already-done with a backdated completion.
    const created = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Backdated at creation",
      body: "",
      tags: [],
      status: "done",
      actorKind: "human",
      metadata: {},
      completedAt: backdated
    });
    expect(created.completedAt?.toISOString()).toBe(backdated.toISOString());

    // Complete-and-backdate in one update: explicit value beats the auto stamp.
    const open = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Complete and backdate",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const doneAt = new Date("2026-07-05T18:00:00.000Z");
    const done = await update(S, db, open.id, { status: "done", completedAt: doneAt });
    expect(done.completedAt?.toISOString()).toBe(doneAt.toISOString());

    // Fix the timestamp on an already-done task without touching status.
    const fixedAt = new Date("2026-07-06T08:00:00.000Z");
    const fixed = await update(S, db, open.id, { completedAt: fixedAt });
    expect(fixed.status).toBe("done");
    expect(fixed.completedAt?.toISOString()).toBe(fixedAt.toISOString());

    // Rejected: setting completedAt on a task that is not done.
    const stillOpen = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Still open",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    await expect(
      update(S, db, stillOpen.id, { completedAt: new Date() })
    ).rejects.toThrow(/only be set on a done task/);

    // Rejected: creating a non-done task with completedAt.
    await expect(
      write(S, db, {
        kind: "task",
        projectId: p.id,
        title: "Open with stamp",
        body: "",
        tags: [],
        status: "open",
        actorKind: "human",
        metadata: {},
        completedAt: new Date()
      })
    ).rejects.toThrow(/status 'done'/);
  });

  it("never stamps completedAt on non-task kinds, and always allows clearing it", async () => {
    const p = await createProject(S, db, { key: "NCMP", name: "Non-task completion" });

    // A note created done carries no completion stamp.
    const createdDone = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Note created done",
      body: "",
      tags: [],
      status: "done",
      actorKind: "human",
      metadata: {}
    });
    expect(createdDone.completedAt).toBeNull();

    // Neither does a note that transitions into done.
    const note = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Note marked done later",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const noteDone = await update(S, db, note.id, { status: "done" });
    expect(noteDone.completedAt).toBeNull();

    // Setting a value on a non-task is still rejected...
    await expect(
      update(S, db, note.id, { completedAt: new Date() })
    ).rejects.toThrow(/applies to tasks only/);

    // ...but clearing must always work, so a stray stamp (e.g. written by an
    // older build) can be removed instead of being stuck forever.
    await db.execute(sql`
      UPDATE entities SET completed_at = now() WHERE id = ${note.id}
    `);
    const cleared = await update(S, db, note.id, { completedAt: null });
    expect(cleared.completedAt).toBeNull();
  });

  it("tasksRange displays done tasks on completion day, not due day", async () => {
    const p = await createProject(S, db, { key: "CAL", name: "Calendar" });
    const dueAt = new Date("2026-06-01T12:00:00.000Z");
    const completedAt = new Date("2026-06-10T15:30:00.000Z");
    const legacyUpdatedAt = new Date("2026-06-11T09:00:00.000Z");

    const done = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Ship finished task",
      body: "",
      tags: [],
      status: "done",
      actorKind: "human",
      metadata: {},
      dueAt
    });
    await withEntitiesTouchDisabled(async () => {
      await db.execute(sql`
        UPDATE entities
        SET completed_at = ${completedAt}, updated_at = ${completedAt}
        WHERE id = ${done.id}
      `);
    });

    const legacyDone = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Legacy finished task",
      body: "",
      tags: [],
      status: "done",
      actorKind: "human",
      metadata: {},
      dueAt
    });
    await withEntitiesTouchDisabled(async () => {
      await db.execute(sql`
        UPDATE entities
        SET completed_at = NULL, updated_at = ${legacyUpdatedAt}
        WHERE id = ${legacyDone.id}
      `);
    });
    const overdueOpen = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Still needs attention",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });

    const dueDay = await tasksRange(S, db, {
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-06-02T00:00:00.000Z"),
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: true
    });
    expect(dueDay.scheduled.map((t) => t.id)).not.toContain(done.id);
    expect(dueDay.scheduled.map((t) => t.id)).not.toContain(legacyDone.id);

    const completionDay = await tasksRange(S, db, {
      from: new Date("2026-06-10T00:00:00.000Z"),
      to: new Date("2026-06-11T00:00:00.000Z"),
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: true
    });
    expect(completionDay.scheduled.map((t) => t.id)).toContain(done.id);
    expect(completionDay.scheduled.map((t) => t.id)).not.toContain(legacyDone.id);
    expect(completionDay.overdue.map((t) => t.id)).toContain(overdueOpen.id);

    const legacyCompletionDay = await tasksRange(S, db, {
      from: new Date("2026-06-11T00:00:00.000Z"),
      to: new Date("2026-06-12T00:00:00.000Z"),
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: true
    });
    expect(legacyCompletionDay.scheduled.map((t) => t.id)).toContain(legacyDone.id);
  });

  it("tasksRange does not duplicate in-range tasks into overdue", async () => {
    const p = await createProject(S, db, { key: "DUP", name: "No Duplicate" });
    const from = new Date(Date.now() - 2 * 60 * 1000);
    const dueAt = new Date(Date.now() - 60 * 1000);
    const to = new Date(Date.now() + 60 * 60 * 1000);

    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Show once in the active range",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });

    const range = await tasksRange(S, db, {
      from,
      to,
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: false
    });

    expect(range.scheduled.map((t) => t.id)).toContain(task.id);
    expect(range.overdue.map((t) => t.id)).not.toContain(task.id);
  });

  it("tasksRange keeps in-progress tasks on today, and past-due ones in overdue only", async () => {
    const p = await createProject(S, db, { key: "NOW", name: "Now" });
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Keep active work visible",
      body: "",
      tags: [],
      status: "in_progress",
      actorKind: "human",
      metadata: {}
    });
    const started = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Started but past due",
      body: "",
      tags: [],
      status: "in_progress",
      actorKind: "human",
      metadata: {},
      dueAt: new Date("2020-01-01T12:00:00.000Z")
    });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);

    const today = await tasksRange(S, db, {
      from: todayStart,
      to: tomorrowStart,
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: false
    });
    expect(today.scheduled.map((t) => t.id)).toContain(task.id);
    expect(today.overdue.map((t) => t.id)).not.toContain(task.id);
    expect(today.overdue.map((t) => t.id)).toContain(started.id);
    expect(today.scheduled.map((t) => t.id)).not.toContain(started.id);

    const yesterday = await tasksRange(S, db, {
      from: yesterdayStart,
      to: todayStart,
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: false
    });
    expect(yesterday.scheduled.map((t) => t.id)).not.toContain(task.id);
  });

  it("tasksRange keeps cancelled tasks out of every bucket", async () => {
    const p = await createProject(S, db, { key: "INBX", name: "Inbox" });
    const open = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Show undated task",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const cancelled = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Show cancelled undated task",
      body: "",
      tags: [],
      status: "rejected",
      actorKind: "human",
      metadata: {}
    });
    // A leftover dueAt on a cancelled task must not resurrect it as Scheduled.
    const cancelledDated = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Cancelled task with stale due date",
      body: "",
      tags: [],
      status: "rejected",
      actorKind: "human",
      metadata: {},
      dueAt: new Date()
    });

    const range = await tasksRange(S, db, {
      projectIds: [p.id],
      includeBacklog: true,
      includeDone: true
    });
    expect(range.backlog.map((t) => t.id)).toContain(open.id);
    const everywhere = [...range.scheduled, ...range.overdue, ...range.backlog].map((t) => t.id);
    expect(everywhere).not.toContain(cancelled.id);
    expect(everywhere).not.toContain(cancelledDated.id);
  });

  it("listChildren unions parentId and parent_of children and excludes worklog entries", async () => {
    const p = await createProject(S, db, { key: "MILE", name: "Milestone" });
    const parent = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Milestone parent",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const byColumn = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Child via parentId",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      parentId: parent.id
    });
    const byEdge = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Child via parent_of edge",
      body: "",
      tags: [],
      status: "done",
      actorKind: "human",
      metadata: {}
    });
    await link(S, db, { fromId: parent.id, toId: byEdge.id, kind: "parent_of" });
    // Worklog entries hang off parentId too but are not child work items.
    const entry = await addWorklogEntry(S, db, parent.id, { body: "worklog", actorKind: "agent" });

    const children = await listChildren(S, db, parent.id);
    const ids = children.map((ch) => ch.id);
    expect(ids).toContain(byColumn.id);
    expect(ids).toContain(byEdge.id);
    expect(ids).not.toContain(entry.id);
  });

  it("creates a recurrence rule and generates the next scheduled occurrence on completion", async () => {
    const p = await createProject(S, db, { key: "REC", name: "Recurrence" });
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    dueAt.setUTCHours(12, 0, 0, 0);
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Review recurring task",
      body: "same body",
      tags: ["repeat"],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt,
      priority: "medium"
    });

    const rule = await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });
    expect(rule.rrule).toContain("FREQ=DAILY");

    await update(S, db, task.id, { status: "done" });
    const details = await getRecurrenceForTask(S, db, task.id);
    expect(details?.rule.currentOccurrenceId).not.toBe(task.id);
    expect(details?.currentOccurrence?.title).toBe(task.title);
    expect(details?.currentOccurrence?.status).toBe("open");
    expect(details?.currentOccurrence?.priority).toBe("medium");
    expect(details?.currentOccurrence?.dueAt?.toISOString()).toBe(
      new Date(dueAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
    );

    await update(S, db, task.id, { status: "done" });
    const afterRetry = await getRecurrenceForTask(S, db, task.id);
    expect(afterRetry?.rule.currentOccurrenceId).toBe(details?.rule.currentOccurrenceId);
  });

  it("tasksRange is a pure read: it does not materialize scheduled recurrences", async () => {
    const p = await createProject(S, db, { key: "RPR", name: "Recurrence Pure Read" });
    const twoDaysAgo = new Date();
    twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
    twoDaysAgo.setUTCHours(12, 0, 0, 0);
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Not advanced by reads",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt: twoDaysAgo
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    await tasksRange(S, db, { projectIds: [p.id], includeBacklog: true, includeDone: false });
    await tasksRange(S, db, { projectIds: [p.id], includeBacklog: true, includeDone: false });

    const rows = await db.select().from(entities).where(eq(entities.projectId, p.id));
    expect(rows).toHaveLength(1);
    const details = await getRecurrenceForTask(S, db, task.id);
    expect(details?.rule.generatedCount).toBe(1);
  });

  it("concurrent materializer passes advance a due rule exactly once", async () => {
    const p = await createProject(S, db, { key: "RCC", name: "Recurrence Concurrency" });
    const todayStartUTC = new Date();
    todayStartUTC.setUTCHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStartUTC);
    tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);
    const twoDaysAgo = new Date(todayStartUTC);
    twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
    twoDaysAgo.setUTCHours(12, 0, 0, 0);

    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Raced daily task",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt: twoDaysAgo
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    const passes = await Promise.all(
      Array.from({ length: 4 }, () => materializeScheduledRecurrences(db, tomorrowStart))
    );
    const createdTotal = passes.reduce((n, created) => n + created.length, 0);
    // The seed sits two days ago; yesterday and today are owed. Generated once in total.
    expect(createdTotal).toBe(2);

    const rows = await db.select().from(entities).where(eq(entities.projectId, p.id));
    expect(rows).toHaveLength(3);
    const dueAts = new Set(rows.map((row) => row.dueAt?.toISOString()));
    expect(dueAts.size).toBe(3);

    const details = await getRecurrenceForTask(S, db, task.id);
    expect(details?.rule.generatedCount).toBe(3);
  });

  it("the scheduler pass materializes scheduled recurrences through today", async () => {
    const p = await createProject(S, db, { key: "RMT", name: "Recurrence Materialize Today" });
    // Use UTC-based dates so allDayDueAtInZone(date, "UTC") produces predictable noon-UTC results
    // regardless of the test machine's local timezone.
    const todayStartUTC = new Date();
    todayStartUTC.setUTCHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStartUTC);
    tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);
    const twoDaysAgo = new Date(todayStartUTC);
    twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
    twoDaysAgo.setUTCHours(12, 0, 0, 0);
    const todayStart = todayStartUTC;
    const todayDue = new Date(todayStartUTC);
    todayDue.setUTCHours(12, 0, 0, 0);

    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Publish daily recurring task",
      body: "",
      tags: ["repeat"],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt: twoDaysAgo
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    await materializeScheduledRecurrences(db, tomorrowStart);
    const range = await tasksRange(S, db, {
      from: todayStart,
      to: tomorrowStart,
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: false
    });

    const todayOccurrence = range.scheduled.find(
      (row) => row.title === task.title && row.dueAt?.getTime() === todayDue.getTime()
    );
    expect(todayOccurrence?.status).toBe("open");
    expect(range.overdue.filter((row) => row.title === task.title)).toHaveLength(2);

    const details = await getRecurrenceForTask(S, db, task.id);
    expect(details?.currentOccurrence?.id).toBe(todayOccurrence?.id);
    expect(details?.rule.generatedCount).toBe(3);
  });

  it("supports repeat-after-completion anchor", async () => {
    const p = await createProject(S, db, { key: "RAC", name: "Repeat After Completion" });
    const dueAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    dueAt.setUTCHours(12, 0, 0, 0);
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Replace maintenance item",
      body: "",
      tags: ["maintenance"],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });

    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 2,
      timezone: "UTC",
      allDay: true,
      anchor: "completion"
    });
    const before = Date.now();
    await update(S, db, task.id, { status: "done" });
    const after = Date.now();
    const details = await getRecurrenceForTask(S, db, task.id);
    const nextDue = details?.currentOccurrence?.dueAt?.getTime() ?? 0;

    // For all-day completion-anchor rules with timezone "UTC", the next occurrence is
    // snapped to noon UTC of the UTC calendar day that is 2 days after completion.
    // Compute the expected noon-UTC of (UTC day of "before" + 2 days).
    const twoDaysAfterBefore = new Date(before + 2 * 24 * 60 * 60 * 1000);
    twoDaysAfterBefore.setUTCHours(12, 0, 0, 0);
    const twoDaysAfterAfter = new Date(after + 2 * 24 * 60 * 60 * 1000);
    twoDaysAfterAfter.setUTCHours(12, 0, 0, 0);
    // The result is noon UTC of the day 2 days from now; allow ±1 day window for day-boundary edge cases.
    expect(nextDue).toBeGreaterThanOrEqual(twoDaysAfterBefore.getTime() - 24 * 60 * 60 * 1000);
    expect(nextDue).toBeLessThanOrEqual(twoDaysAfterAfter.getTime() + 24 * 60 * 60 * 1000);
    // Also verify the time is noon UTC (0 for hours other than 12 UTC means non-noon — reject that).
    expect(new Date(nextDue).getUTCHours()).toBe(12);
    expect(new Date(nextDue).getUTCMinutes()).toBe(0);
  });

  it("skips recurring occurrence and stops when count is exhausted", async () => {
    const p = await createProject(S, db, { key: "RSK", name: "Recurrence Skip" });
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    dueAt.setUTCHours(12, 0, 0, 0);
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Attend recurring meeting",
      body: "",
      tags: ["meeting"],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });

    await createRecurrenceRule(S, db, task.id, {
      preset: "weekly",
      interval: 1,
      count: 2,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });
    const skipped = await skipOccurrence(S, db, task.id, { actorKind: "human" });
    expect(skipped.skipped.status).toBe("rejected");
    expect(skipped.next?.status).toBe("open");

    await update(S, db, skipped.next!.id, { status: "done" });
    const details = await getRecurrenceForTask(S, db, skipped.next!.id);
    expect(details?.rule.enabled).toBe(false);
    expect(details?.rule.currentOccurrenceId).toBeNull();
  });

  it("rejects recurrence rules for tasks without due dates", async () => {
    const p = await createProject(S, db, { key: "RNO", name: "Recurrence No Due" });
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Needs a first due date",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });

    await expect(
      createRecurrenceRule(S, db, task.id, {
        preset: "weekly",
        interval: 1,
        timezone: "UTC",
        allDay: true,
        anchor: "scheduled"
      })
    ).rejects.toThrow("no due date");
  });

  it("link creates edge + listChildren via parentId", async () => {
    const p = await createProject(S, db, { key: "LNK", name: "Link" });
    const parent = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Parent task",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const child = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Child note",
      body: "looks good",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      parentId: parent.id
    });

    const result = await link(S, db, {
      fromId: parent.id,
      toId: child.id,
      kind: "references"
    });
    expect(result.created).toBe(true);

    const dup = await link(S, db, {
      fromId: parent.id,
      toId: child.id,
      kind: "references"
    });
    expect(dup.created).toBe(false);
  });

  it("updateProject edits AGENTS.md", async () => {
    const p = await createProject(S, db, { key: "AGT", name: "Agt" });
    expect(p.agentsMd).toBe("");
    const updated = await updateProject(S, db, p.id, { agentsMd: "## Be brief." });
    expect(updated.agentsMd).toBe("## Be brief.");
  });

  it("search returns BM25 hit on tsvector match", async () => {
    const p = await createProject(S, db, { key: "SRC", name: "Src" });
    await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Postgres hybrid retrieval",
      body: "BM25 + cosine + time decay merged via RRF",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Coffee order",
      body: "Latte oat milk",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const hits = await search(S, db, { query: "RRF hybrid", projectId: p.id, limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.entity.title).toBe("Postgres hybrid retrieval");
  });

  it("supersedes edge downweights the outdated entity in search", async () => {
    const p = await createProject(S, db, { key: "SUP", name: "Sup" });
    const noteInput = {
      kind: "note" as const,
      projectId: p.id,
      title: "Deploy requires manual cache flush",
      body: "Run scripts/flush-cache.sh after every deploy",
      tags: [],
      status: "open",
      actorKind: "human" as const,
      metadata: {}
    };
    const replacement = await write(S, db, noteInput);
    // The outdated note is created LAST so time decay would naturally rank it
    // first — only the supersedes penalty can flip the order.
    const outdated = await write(S, db, noteInput);
    await markSuperseded(S, db, replacement.id, outdated.id);

    const hits = await search(S, db, { query: "cache flush deploy", projectId: p.id, limit: 5 });
    const ids = hits.map((h) => h.entity.id);
    expect(ids.indexOf(replacement.id)).toBeLessThan(ids.indexOf(outdated.id));
    expect(hits.find((h) => h.entity.id === outdated.id)?.superseded).toBe(true);
    expect(hits.find((h) => h.entity.id === replacement.id)?.superseded).toBeUndefined();
  });

  it("markSuperseded rejects self-reference and missing targets", async () => {
    const p = await createProject(S, db, { key: "SUX", name: "Sux" });
    const note = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Lone note",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    await expect(markSuperseded(S, db, note.id, note.id)).rejects.toThrow(/supersede itself/);
    await expect(
      markSuperseded(S, db, note.id, "00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow(/not found/);
  });

  it("findSimilar surfaces near-duplicate notes and excludes the new note itself", async () => {
    const p = await createProject(S, db, { key: "DUP", name: "Dup" });
    const existing = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Staging DB password lives in 1Password",
      body: "Vault: infra / item: staging-postgres",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const fresh = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Staging DB password lives in 1Password",
      body: "Duplicate capture from another session",
      tags: [],
      status: "open",
      actorKind: "agent",
      metadata: {}
    });

    const similar = await findSimilar(S, db, {
      title: fresh.title,
      body: fresh.body,
      projectId: p.id,
      excludeId: fresh.id
    });
    expect(similar.map((h) => h.entity.id)).toContain(existing.id);
    expect(similar.map((h) => h.entity.id)).not.toContain(fresh.id);
  });

  it("submitFeedback stores categorized feedback and listFeedback filters it", async () => {
    const p = await createProject(S, db, { key: "FBK", name: "Fbk" });
    const bug = await submitFeedback(S, db, {
      category: "bug",
      title: "search drops KEY-SEQ refs from queries",
      body: "Searching for BOT-12 returns nothing even though the task exists.",
      projectId: p.id,
      tool: "search",
      actorKind: "agent",
      metadata: {},
      idempotencyKey: "fbk-1"
    });
    expect(bug.kind).toBe("feedback");
    expect(bug.status).toBe("open");
    expect((bug.metadata as { category?: string }).category).toBe("bug");
    expect((bug.metadata as { tool?: string }).tool).toBe("search");
    // Feedback with a project gets a KEY-SEQ ref like any addressable item.
    expect(bug.sequenceId).toBe(1);

    // Idempotent replay returns the same row.
    const replay = await submitFeedback(S, db, {
      category: "bug",
      title: "search drops KEY-SEQ refs from queries",
      body: "",
      actorKind: "agent",
      metadata: {},
      idempotencyKey: "fbk-1"
    });
    expect(replay.id).toBe(bug.id);

    await submitFeedback(S, db, {
      category: "idea",
      title: "opening brief could include a weekly summary",
      body: "",
      actorKind: "agent",
      metadata: {}
    });

    const bugs = await listFeedback(S, db, { category: "bug", limit: 20 });
    expect(bugs.map((f) => f.id)).toEqual([bug.id]);
    const all = await listFeedback(S, db, { limit: 20 });
    expect(all.length).toBe(2);
    const done = await listFeedback(S, db, { status: "done", limit: 20 });
    expect(done.length).toBe(0);
  });

  it("bumpAccess tracks reads and boosts frequently-recalled entities in search", async () => {
    const p = await createProject(S, db, { key: "ACC", name: "Acc" });
    const noteInput = {
      kind: "note" as const,
      projectId: p.id,
      title: "Redis eviction policy is allkeys-lru",
      body: "Set on the prod cluster; do not change without capacity review",
      tags: [],
      status: "open",
      actorKind: "human" as const,
      metadata: {}
    };
    const recalled = await write(S, db, noteInput);
    // Newer twin would win on time decay if access count did not matter.
    const untouched = await write(S, db, noteInput);

    for (let i = 0; i < 20; i += 1) await bumpAccess(S, db, recalled.id);
    const fetched = await get(S, db, recalled.id);
    expect(fetched?.accessCount).toBe(20);
    expect(fetched?.lastAccessedAt).not.toBeNull();

    const hits = await search(S, db, { query: "redis eviction policy", projectId: p.id, limit: 5 });
    const ids = hits.map((h) => h.entity.id);
    expect(ids.indexOf(recalled.id)).toBeLessThan(ids.indexOf(untouched.id));
    expect(hits.find((h) => h.entity.id === recalled.id)?.components.accessBoost).toBeGreaterThan(0);
  });

  it("embedding queue is no-op when disabled", async () => {
    const svc = new EmbeddingService(db);
    expect(svc.isEnabled()).toBe(false);
    svc.enqueue("fake-id", "some text");
    expect(svc.pendingCount()).toBe(0);
    expect(await svc.embedQuery("hello")).toBeNull();
  });

  it("embedding settings persist and reload the runtime", async () => {
    const initial = await getEmbeddingSettings(S, db);
    expect(initial.enabled).toBe(true);
    expect(initial.model).toBe("text-embedding-3-small");

    const svc = new EmbeddingService(db);
    const missing = await svc.reloadConfig();
    expect(missing.enabled).toBe(false);
    expect(missing.reason).toBe("missing_api_key");

    await updateEmbeddingSettings(S, db, {
      provider: "openai",
      model: "text-embedding-3-large",
      apiKey: "sk-test"
    });

    const ready = await svc.reloadConfig();
    expect(ready.enabled).toBe(true);
    expect(ready.model).toBe("text-embedding-3-large");
    expect(ready.apiKeySource).toBe("settings");
    expect(ready.apiKeyPreview).toBe("configured");
  });

  it("openai-compatible embedding settings require a base URL", async () => {
    await updateEmbeddingSettings(S, db, {
      provider: "openai_compatible",
      model: "custom-384",
      apiKey: "sk-compatible"
    });

    const svc = new EmbeddingService(db);
    const missingBaseUrl = await svc.reloadConfig();
    expect(missingBaseUrl.enabled).toBe(false);
    expect(missingBaseUrl.reason).toBe("missing_base_url");

    await updateEmbeddingSettings(S, db, {
      baseUrl: "https://embeddings.example.com/v1"
    });

    const ready = await svc.reloadConfig();
    expect(ready.enabled).toBe(true);
    expect(ready.provider).toBe("openai_compatible");
    expect(ready.baseUrl).toBe("https://embeddings.example.com/v1");
  });

  it("stores recoverable API token plaintext for Settings copy", async () => {
    const { plaintext } = await createToken(S, db, { name: "laptop" });
    expect(plaintext).toMatch(/^bn_[0-9a-f]{48}$/);

    const rows = await listTokens(S, db);
    expect(rows[0]?.name).toBe("laptop");
    expect(rows[0]?.prefix).toBe(plaintext.slice(0, 11));
    expect(rows[0]?.plaintext).toBe(plaintext);

    const consumed = await consumeToken(db, plaintext);
    expect(consumed?.id).toBe(rows[0]?.id);
  });

  it("embedding queue drains via injected embedFn + sets body_vec", async () => {
    const p = await createProject(S, db, { key: "EMB", name: "Emb" });
    const note = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Sample note",
      body: "embedding worker test",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const fakeVec = new Array(384).fill(0).map((_, i) => (i % 7) / 10);
    const svc = new EmbeddingService(db, {
      embedFn: async () => fakeVec,
      logger: () => undefined
    });
    expect(svc.isEnabled()).toBe(true);
    svc.enqueue(note.id, "embedding worker test");
    await svc.drain(5000);

    const fetched = await get(S, db, note.id);
    expect(fetched?.bodyVec).not.toBeNull();
    expect(fetched?.bodyVec?.length).toBe(384);
  });

  it("embedding backfill queues only entities without vectors", async () => {
    const p = await createProject(S, db, { key: "BFI", name: "Backfill" });
    const missing = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Needs embedding",
      body: "queue this one",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const alreadyEmbedded = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Already embedded",
      body: "skip this one",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    await setBodyVec(db, alreadyEmbedded.id, new Array(384).fill(0.2));

    const before = await embeddingCoverage(S, db);
    expect(before.missingCount).toBe(1);
    expect(before.embeddedCount).toBe(1);

    const svc = new EmbeddingService(db, {
      embedFn: async () => new Array(384).fill(0.4),
      logger: () => undefined
    });
    const queued = await svc.enqueueMissing(10);
    expect(queued.enqueued).toBe(1);
    await svc.drain(5000);

    const fetchedMissing = await get(S, db, missing.id);
    const fetchedExisting = await get(S, db, alreadyEmbedded.id);
    expect(fetchedMissing?.bodyVec?.[0]).toBe(0.4);
    expect(fetchedExisting?.bodyVec?.[0]).toBe(0.2);
  });

  it("embedding queue retries on transient failure", async () => {
    const p = await createProject(S, db, { key: "RTY", name: "Rty" });
    const note = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Retry test",
      body: "x",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    let calls = 0;
    const fakeVec = new Array(384).fill(0.5);
    const svc = new EmbeddingService(db, {
      embedFn: async () => {
        calls++;
        if (calls < 2) throw new Error("transient");
        return fakeVec;
      },
      logger: () => undefined
    });
    svc.enqueue(note.id, "x");
    await svc.drain(5000);
    expect(calls).toBeGreaterThanOrEqual(2);
    const fetched = await get(S, db, note.id);
    expect(fetched?.bodyVec?.length).toBe(384);
  });

  it("a fresh service instance picks up rows left without vectors", async () => {
    const p = await createProject(S, db, { key: "RST", name: "Restart" });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await write(S, db, {
        kind: "note",
        projectId: p.id,
        title: `Orphaned ${i}`,
        body: "written while the worker was down",
        tags: [],
        status: "open",
        actorKind: "human",
        metadata: {}
      });
      ids.push(e.id);
    }

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const svc = new EmbeddingService(db, {
      embedBatchFn: async (texts) => {
        await gate;
        return texts.map(() => new Array(384).fill(0.3));
      },
      logger: () => undefined
    });
    const first = await svc.enqueueMissing();
    expect(first.enqueued).toBe(3);
    const again = await svc.enqueueMissing();
    expect(again.enqueued).toBe(0);
    expect(again.pendingCount).toBe(3);
    release();
    await svc.drain(5000);

    for (const id of ids) {
      const fetched = await get(S, db, id);
      expect(fetched?.bodyVec?.[0]).toBeCloseTo(0.3, 6);
    }
    expect((await svc.enqueueMissing()).enqueued).toBe(0);
  });

  it("batches backfill requests and matches the single-text path", async () => {
    const p = await createProject(S, db, { key: "BAT", name: "Batch" });
    const vecFor = async (text: string): Promise<number[]> => {
      let h = 2166136261;
      for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
      return new Array(384).fill(0).map((_, i) => ((h + i * 7919) % 1000) / 1000);
    };
    const rows = 250;
    const ids: string[] = [];
    for (let i = 0; i < rows; i++) {
      const e = await write(S, db, {
        kind: i % 2 === 0 ? "note" : "task",
        projectId: p.id,
        title: `Row ${i}`,
        body: `body text ${i}`,
        tags: [],
        status: "open",
        actorKind: "human",
        metadata: {}
      });
      ids.push(e.id);
    }

    const batchSizes: number[] = [];
    const batched = new EmbeddingService(db, {
      embedBatchFn: async (texts) => {
        batchSizes.push(texts.length);
        return Promise.all(texts.map(vecFor));
      },
      logger: () => undefined
    });
    expect((await batched.enqueueMissing()).enqueued).toBe(rows);
    await batched.drain(10000);
    expect(batchSizes.length).toBe(3);
    expect(Math.max(...batchSizes)).toBe(100);

    const twin = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Row 0",
      body: "body text 0",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const single = new EmbeddingService(db, { embedFn: vecFor, logger: () => undefined });
    expect((await single.enqueueMissing()).enqueued).toBe(1);
    await single.drain(5000);

    const viaBatch = await get(S, db, ids[0]!);
    const viaSingle = await get(S, db, twin.id);
    expect(viaBatch?.bodyVec).toEqual(viaSingle?.bodyVec);
    expect(viaBatch?.bodyVec?.[0]).toBeCloseTo((await vecFor("Row 0\nbody text 0"))[0]!, 6);
  });

  it("a failing text is retried alone and does not poison its batch", async () => {
    const p = await createProject(S, db, { key: "PSN", name: "Poison" });
    const make = (title: string) =>
      write(S, db, {
        kind: "note",
        projectId: p.id,
        title,
        body: "b",
        tags: [],
        status: "open",
        actorKind: "human",
        metadata: {}
      });
    const good = await Promise.all([make("good 1"), make("good 2"), make("good 3")]);
    const bad = await make("poison");

    const logs: string[] = [];
    const svc = new EmbeddingService(db, {
      embedBatchFn: async (texts) => {
        if (texts.some((t) => t.includes("poison"))) throw new Error("provider rejected input");
        return texts.map(() => new Array(384).fill(0.6));
      },
      logger: (m) => logs.push(m)
    });
    expect((await svc.enqueueMissing()).enqueued).toBe(4);
    await svc.drain(10000);

    for (const e of good) expect((await get(S, db, e.id))?.bodyVec?.length).toBe(384);
    expect((await get(S, db, bad.id))?.bodyVec).toBeNull();
    expect(logs.some((l) => l.includes("giving up"))).toBe(true);
    expect((await svc.enqueueMissing()).enqueued).toBe(1);
  });

  it("hybrid search merges BM25 + cosine via RRF", async () => {
    const p = await createProject(S, db, { key: "HYB", name: "Hybrid" });

    const dim = 384;
    function vec(seed: number): number[] {
      const v = new Array(dim);
      let x = seed;
      for (let i = 0; i < dim; i++) {
        x = (x * 1664525 + 1013904223) >>> 0;
        v[i] = ((x / 0xffffffff) - 0.5) * 2;
      }
      let norm = 0;
      for (const c of v) norm += c * c;
      norm = Math.sqrt(norm);
      return v.map((c) => c / norm);
    }

    const target = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Esoteric subject zenith",
      body: "no normal keyword match here",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const noise = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Coffee order",
      body: "Latte oat milk",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });

    const targetVec = vec(1);
    await setBodyVec(db, target.id, targetVec);
    await setBodyVec(db, noise.id, vec(99999));

    const hits = await search(S, db,
      { query: "unrelated query", projectId: p.id, limit: 5 },
      { queryEmbedding: targetVec }
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.entity.id).toBe(target.id);
    expect(hits[0]?.components.cosine).toBeDefined();
  });

  it("openingBrief gathers project context", async () => {
    const p = await createProject(S, db, {
      key: "OBR",
      name: "OBR Project",
      agentsMd: "## NEVER push to main"
    });
    const openTask = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Open task A",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Pinned deployment note",
      body: "Production uses the npm package for plugin runtime.",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      pinned: true
    });
    await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Random thought",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const brief = await openingBrief(S, db, { projectId: p.id, recentLimit: 10 });
    expect(brief.project?.key).toBe("OBR");
    expect(brief.agentsMd).toContain("NEVER push");
    expect(brief.openTasks.length).toBe(1);
    expect(brief.pinnedNotes.length).toBe(1);
    expect(brief.recent.length).toBe(3);

    const formatted = formatOpeningBrief(brief);
    expect(formatted).toContain("# Project: OBR");
    expect(formatted).toContain("## Open Tasks");
    expect(formatted).toContain("## Pinned Notes");
    expect(formatted).toContain(`[OBR-${openTask.sequenceId}]`);
    expect(formatted).toMatch(/OBR-\d+ · Open task A/);
  });

  it("openingBrief surfaces in_progress tasks first and orders open tasks by urgency", async () => {
    const p = await createProject(S, db, { key: "OBR2", name: "OBR2 Project" });
    const base = {
      kind: "task" as const,
      projectId: p.id,
      body: "",
      tags: [],
      actorKind: "human" as const,
      metadata: {}
    };
    const backlog = await write(S, db, { ...base, title: "Backlog idea", status: "open" });
    const started = await write(S, db, { ...base, title: "Started yesterday", status: "in_progress" });
    const overdue = await write(S, db, {
      ...base,
      title: "Overdue chore",
      status: "open",
      dueAt: new Date("2026-01-05T12:00:00.000Z")
    });
    const urgent = await write(S, db, { ...base, title: "Urgent no date", status: "open", priority: "urgent" });
    await write(S, db, { ...base, title: "Already done", status: "done" });

    const brief = await openingBrief(S, db, { projectId: p.id, recentLimit: 10 });
    const ids = brief.openTasks.map((t) => t.id);
    expect(ids).toEqual([started.id, overdue.id, urgent.id, backlog.id]);

    const formatted = formatOpeningBrief(brief);
    expect(formatted).toContain("## In Progress (1)");
    expect(formatted).toContain("Started yesterday");
    expect(formatted).toContain("## Open Tasks (3)");
    expect(formatted).toContain("(OVERDUE 2026-01-05)");
    expect(formatted).toContain("!urgent");
  });

  it("concurrent writes to one project get distinct consecutive sequence ids", async () => {
    const p = await createProject(S, db, { key: "SEQ", name: "Seq Project" });
    const rows = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        write(S, db, {
          kind: i % 2 === 0 ? "task" : "note",
          projectId: p.id,
          title: `Concurrent ${i}`,
          body: "",
          tags: [],
          status: "open",
          actorKind: "agent",
          metadata: {}
        })
      )
    );
    const ids = rows.map((r) => r.sequenceId).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(new Set(ids).size).toBe(20);
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

    const next = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "After the burst",
      body: "",
      tags: [],
      status: "open",
      actorKind: "agent",
      metadata: {}
    });
    expect(next.sequenceId).toBe(21);
  });

  it("explicit sequence ids advance the counter and duplicates are rejected", async () => {
    const p = await createProject(S, db, { key: "EXP", name: "Explicit Seq" });
    await db.execute(sql`
      INSERT INTO entities (project_id, kind, title, sequence_id)
      VALUES (${p.id}::uuid, 'task', 'imported', 40)
    `);
    const after = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "auto after import",
      body: "",
      tags: [],
      status: "open",
      actorKind: "agent",
      metadata: {}
    });
    expect(after.sequenceId).toBe(41);

    await expect(
      db.execute(sql`
        INSERT INTO entities (project_id, kind, title, sequence_id)
        VALUES (${p.id}::uuid, 'task', 'collision', 40)
      `)
    ).rejects.toThrow(/entities_project_seq_unique/);
  });

  it("update rejects self-parenting and direct parent cycles", async () => {
    const p = await createProject(S, db, { key: "PAR", name: "Parents" });
    const base = { body: "", tags: [], status: "open", actorKind: "human", metadata: {} } as const;
    const a = await write(S, db, { kind: "task", projectId: p.id, title: "A", ...base });
    const b = await write(S, db, { kind: "task", projectId: p.id, title: "B", parentId: a.id, ...base });

    await expect(update(S, db, a.id, { parentId: a.id })).rejects.toMatchObject({
      statusCode: 400
    });
    await expect(update(S, db, a.id, { parentId: b.id })).rejects.toMatchObject({
      statusCode: 400
    });
    await expect(
      update(S, db, a.id, { parentId: "00000000-0000-4000-8000-000000000000" })
    ).rejects.toMatchObject({ statusCode: 404 });

    const c = await write(S, db, { kind: "note", projectId: p.id, title: "C", ...base });
    const moved = await update(S, db, c.id, { parentId: b.id });
    expect(moved.parentId).toBe(b.id);
    expect((await get(S, db, a.id))?.parentId).toBeNull();
  });

  it("migration 0027 clears self-parent rows and self edges and is idempotent", async () => {
    const p = await createProject(S, db, { key: "SLF", name: "Self" });
    const base = { body: "", tags: [], status: "open", actorKind: "human", metadata: {} } as const;
    const legacy = await write(S, db, { kind: "note", projectId: p.id, title: "legacy", ...base });
    const child = await write(S, db, { kind: "note", projectId: p.id, title: "child", parentId: legacy.id, ...base });
    await db.execute(sql`UPDATE entities SET parent_id = id WHERE id = ${legacy.id}::uuid`);
    await db.execute(sql`INSERT INTO edges (from_id, to_id, kind) VALUES (${legacy.id}::uuid, ${legacy.id}::uuid, 'parent_of')`);
    expect((await listChildren(S, db, legacy.id)).map((e) => e.id)).toContain(legacy.id);

    const migration = readFileSync(
      new URL("../src/db/migrations/0027_self_parent_repair.sql", import.meta.url),
      "utf8"
    );
    for (let pass = 0; pass < 2; pass++) await db.execute(sql.raw(migration));

    expect((await get(S, db, legacy.id))?.parentId).toBeNull();
    expect((await listChildren(S, db, legacy.id)).map((e) => e.id)).toEqual([child.id]);
    const selfEdges = await db.execute(sql`SELECT count(*)::int AS n FROM edges WHERE from_id = to_id`);
    expect((selfEdges.rows[0] as { n: number }).n).toBe(0);
    const outgoing = await getLinks(S, db, { id: legacy.id, kind: null, direction: "outgoing" });
    expect(outgoing.map((l) => l.entity.id)).toEqual([child.id]);
  });

  it("addWorklogEntry appends a worklog entry that inherits the project but no sequence id", async () => {
    const p = await createProject(S, db, { key: "CMT", name: "CMT Project" });
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Task with worklog",
      body: "",
      tags: [],
      status: "in_progress",
      actorKind: "human",
      metadata: {}
    });

    const c1 = await addWorklogEntry(S, db, task.id, {
      body: "Implemented the parser, tests green.",
      actorKind: "agent",
      metadata: {},
      idempotencyKey: "cmt-1"
    });
    expect(c1.kind).toBe("worklog");
    expect(c1.parentId).toBe(task.id);
    expect(c1.projectId).toBe(p.id);
    expect(c1.sequenceId).toBeNull();

    // idempotent re-write returns the same row
    const again = await addWorklogEntry(S, db, task.id, {
      body: "Implemented the parser, tests green.",
      actorKind: "agent",
      metadata: {},
      idempotencyKey: "cmt-1"
    });
    expect(again.id).toBe(c1.id);

    await addWorklogEntry(S, db, task.id, {
      body: "Blocked on the flaky CI runner.",
      actorKind: "agent",
      metadata: {}
    });
    const all = await listWorklog(S, db, task.id);
    expect(all.map((c) => c.body)).toEqual([
      "Implemented the parser, tests green.",
      "Blocked on the flaky CI runner."
    ]);

    // append-only: entries reject updates, nesting is refused
    await expect(update(S, db, c1.id, { body: "rewritten" })).rejects.toThrow(/append-only/);
    await expect(
      addWorklogEntry(S, db, c1.id, { body: "nested", actorKind: "agent", metadata: {} })
    ).rejects.toThrow(/nested/);
  });

  it("openingBrief and tasksRange flag tasks whose blocker is still open", async () => {
    const p = await createProject(S, db, { key: "BLK", name: "Blockers" });
    const mk = (title: string, status: string) =>
      write(S, db, {
        kind: "task",
        projectId: p.id,
        title,
        body: "",
        tags: [],
        status,
        actorKind: "human",
        metadata: {}
      });
    const blocker = await mk("Ship the parser", "open");
    const blocked = await mk("Wire the REST layer", "open");
    const finishedBlocker = await mk("Old prerequisite", "done");
    const free = await mk("Independent work", "in_progress");
    const blockedInProgress = await mk("Started too early", "in_progress");
    await link(S, db, { fromId: blocker.id, toId: blocked.id, kind: "blocks" });
    await link(S, db, { fromId: finishedBlocker.id, toId: free.id, kind: "blocks" });
    await link(S, db, { fromId: blocker.id, toId: blockedInProgress.id, kind: "blocks" });
    await link(S, db, { fromId: free.id, toId: blockedInProgress.id, kind: "blocks" });

    const brief = await openingBrief(S, db, { projectId: p.id, recentLimit: 5 });
    expect(Object.keys(brief.blockedBy).sort()).toEqual([blocked.id, blockedInProgress.id].sort());
    expect(brief.blockedBy[blocked.id]).toEqual([
      { id: blocker.id, ref: "BLK-1", title: "Ship the parser", status: "open" }
    ]);
    expect(brief.blockedBy[blockedInProgress.id]?.map((b) => b.ref)).toEqual(["BLK-1", "BLK-4"]);

    const formatted = formatOpeningBrief(brief);
    expect(formatted).toContain("[BLK-2] Wire the REST layer (BLOCKED by BLK-1)");
    expect(formatted).toContain("[BLK-5] Started too early (BLOCKED by BLK-1, BLK-4)");
    expect(formatted).not.toContain("Independent work (BLOCKED");
    expect(formatted).not.toContain("Ship the parser (BLOCKED");
    // Blocked work sinks below unblocked work inside each group.
    expect(formatted.indexOf("[BLK-4] Independent work")).toBeLessThan(
      formatted.indexOf("[BLK-5] Started too early")
    );
    expect(formatted.indexOf("[BLK-1] Ship the parser")).toBeLessThan(
      formatted.indexOf("[BLK-2] Wire the REST layer")
    );

    const range = await tasksRange(S, db, {
      projectIds: [p.id],
      includeBacklog: true,
      includeDone: false
    });
    const byId = new Map(range.backlog.map((t) => [t.id, t]));
    expect(byId.get(blocked.id)?.blockedBy.map((b) => b.ref)).toEqual(["BLK-1"]);
    expect(byId.get(blocker.id)?.blockedBy).toEqual([]);
    expect(byId.get(free.id)?.blockedBy).toEqual([]);

    // Finishing the blocker lifts the flag without touching the edge.
    await update(S, db, blocker.id, { status: "done" });
    const after = await openingBrief(S, db, { projectId: p.id, recentLimit: 5 });
    expect(after.blockedBy[blocked.id]).toBeUndefined();
    expect(after.blockedBy[blockedInProgress.id]?.map((b) => b.ref)).toEqual(["BLK-4"]);
  });

  it("hierarchyFor returns parent refs and sub-task counts across both linkage styles", async () => {
    const p = await createProject(S, db, { key: "HIE", name: "Hierarchy" });
    const mk = (title: string, status: string, parentId: string | null = null) =>
      write(S, db, {
        kind: "task",
        projectId: p.id,
        title,
        body: "",
        tags: [],
        status,
        parentId,
        actorKind: "human",
        metadata: {}
      });
    const parent = await mk("Ship hierarchy", "in_progress");
    const done = await mk("Write the query", "done", parent.id);
    const rejected = await mk("Cache counts", "rejected", parent.id);
    const active = await mk("Render chips", "in_progress", parent.id);
    const viaEdge = await mk("Linked later", "open");
    await link(S, db, { fromId: parent.id, toId: viaEdge.id, kind: "parent_of" });
    const gone = await mk("Dropped idea", "open", parent.id);
    await remove(S, db, gone.id);
    await addWorklogEntry(S, db, parent.id, { body: "worklog, not a sub-task", actorKind: "agent", metadata: {} });
    await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Design memory",
      body: "a memory, not a sub-task",
      tags: [],
      parentId: parent.id,
      actorKind: "human",
      metadata: {}
    });
    const loner = await mk("Standalone", "open");

    const h = await hierarchyFor(S, db, [parent.id, done.id, viaEdge.id, loner.id]);
    expect(h.get(parent.id)).toEqual({
      parent: null,
      subtasks: { total: 4, closed: 2, inProgress: 1 }
    });
    expect(h.get(done.id)).toEqual({
      parent: { id: parent.id, ref: "HIE-1", title: "Ship hierarchy", status: "in_progress" },
      subtasks: null
    });
    expect(h.get(viaEdge.id)?.parent?.ref).toBe("HIE-1");
    expect(h.get(loner.id)).toEqual({ parent: null, subtasks: null });

    // The parentId column wins over an older parent_of edge.
    const other = await mk("Other parent", "open");
    await link(S, db, { fromId: other.id, toId: active.id, kind: "parent_of" });
    expect((await hierarchyFor(S, db, [active.id])).get(active.id)?.parent?.id).toBe(parent.id);

    // A deleted parent no longer shows as a chip.
    await remove(S, db, parent.id);
    expect((await hierarchyFor(S, db, [done.id])).get(done.id)?.parent).toBeNull();
    expect((await hierarchyFor(S, db, [])).size).toBe(0);
  });

  it("tasksRange and attachHierarchy decorate task rows only", async () => {
    const p = await createProject(S, db, { key: "HRC", name: "Hierarchy recent" });
    const parent = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Parent",
      body: "",
      tags: [],
      actorKind: "human",
      metadata: {}
    });
    const child = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Child",
      body: "",
      tags: [],
      status: "done",
      parentId: parent.id,
      actorKind: "human",
      metadata: {}
    });
    const note = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Note",
      body: "plain memory",
      tags: [],
      actorKind: "human",
      metadata: {}
    });

    const range = await tasksRange(S, db, { projectIds: [p.id], includeBacklog: true, includeDone: true });
    const byId = new Map([...range.scheduled, ...range.backlog].map((t) => [t.id, t]));
    expect(byId.get(parent.id)?.subtasks).toEqual({ total: 1, closed: 1, inProgress: 0 });
    expect(byId.get(parent.id)?.parent).toBeNull();
    expect(byId.get(child.id)?.parent?.ref).toBe("HRC-1");
    expect(byId.get(child.id)?.subtasks).toBeNull();

    const rows = await attachHierarchy(S, db, await recent(S, db, { projectId: p.id, limit: 10 }));
    const decorated = new Map(rows.map((r) => [r.id, r as Record<string, unknown>]));
    expect(decorated.get(child.id)?.parent).toMatchObject({ ref: "HRC-1", title: "Parent" });
    expect(decorated.get(note.id)).not.toHaveProperty("parent");
    expect(decorated.get(note.id)).not.toHaveProperty("subtasks");
  });

  it("openingBrief surfaces the latest worklog entry for in_progress tasks", async () => {
    const p = await createProject(S, db, { key: "CMT2", name: "CMT2 Project" });
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Resumable task",
      body: "",
      tags: [],
      status: "in_progress",
      actorKind: "human",
      metadata: {}
    });
    await addWorklogEntry(S, db, task.id, { body: "First log.", actorKind: "agent", metadata: {} });
    await addWorklogEntry(S, db, task.id, {
      body: "Second log — stopped at the REST layer.",
      actorKind: "agent",
      metadata: {}
    });

    const brief = await openingBrief(S, db, { projectId: p.id, recentLimit: 10 });
    expect(brief.latestWorklog.length).toBe(1);
    expect(brief.latestWorklog[0]?.body).toContain("Second log");

    const formatted = formatOpeningBrief(brief);
    expect(formatted).toContain("↳ last log");
    expect(formatted).toContain("by agent:");
    expect(formatted).toContain("stopped at the REST layer");
  });

  it("stores the token behind a write and keeps the row when the token is revoked", async () => {
    const { token } = await createToken(S, db, { name: "Claude Code @ MacBook" });
    const task = await write(S, db, {
      kind: "task",
      title: "Attributed task",
      body: "",
      tags: [],
      status: "open",
      actorKind: "agent",
      actorTokenId: token.id,
      metadata: {}
    });
    expect(task.actorTokenId).toBe(token.id);

    const entry = await addWorklogEntry(
      S,
      db,
      task.id,
      { body: "Attributed log.", actorKind: "agent", metadata: {} },
      { actorTokenId: token.id }
    );
    expect(entry.actorTokenId).toBe(token.id);

    const unattributed = await addWorklogEntry(S, db, task.id, {
      body: "Session log.",
      actorKind: "human",
      metadata: {}
    });
    expect(unattributed.actorTokenId).toBeNull();

    expect(await revokeToken(S, db, token.id)).toBe(true);
    const after = await get(S, db, task.id);
    expect(after?.id).toBe(task.id);
    expect(after?.actorTokenId).toBeNull();
  });

  it("openingBrief names the token that wrote the latest worklog line", async () => {
    const p = await createProject(S, db, { key: "ATTR", name: "Attribution" });
    const { token } = await createToken(S, db, { name: "Codex @ Mini" });
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Attributed resumable task",
      body: "",
      tags: [],
      status: "in_progress",
      actorKind: "human",
      metadata: {}
    });
    await addWorklogEntry(
      S,
      db,
      task.id,
      { body: "Parser done, REST layer next.", actorKind: "agent", metadata: {} },
      { actorTokenId: token.id }
    );

    const brief = await openingBrief(S, db, { projectId: p.id, recentLimit: 5 });
    expect(brief.actorLabels).toEqual({ [token.id]: "Codex @ Mini" });
    const formatted = formatOpeningBrief(brief);
    expect(formatted).toContain("by Codex @ Mini: Parser done, REST layer next.");
  });

  describe("entity revisions", () => {
    async function freshTask(title = "Original title") {
      return write(S, db, {
        kind: "task",
        title,
        body: "line one\nline two",
        tags: ["a"],
        status: "open",
        priority: "low",
        actorKind: "human",
        metadata: {}
      });
    }

    it("snapshots the prior content on a content change and records who changed it", async () => {
      const task = await freshTask();
      const { token } = await createToken(S, db, { name: "Codex @ Mini" });

      expect(await listRevisions(S, db, task.id)).toEqual([]);

      await update(S, db, task.id, { title: "Renamed" }, { actorTokenId: token.id });
      const afterRename = await listRevisions(S, db, task.id);
      expect(afterRename).toHaveLength(1);
      expect(afterRename![0]).toMatchObject({
        entityId: task.id,
        revision: 1,
        title: "Original title",
        body: "line one\nline two",
        tags: ["a"],
        priority: "low",
        status: "open",
        actorKind: "agent",
        actorTokenId: token.id
      });

      await update(S, db, task.id, { bodyAppend: "line three" });
      await update(S, db, task.id, { status: "in_progress" });
      const all = await listRevisions(S, db, task.id);
      expect(all!.map((r) => r.revision)).toEqual([3, 2, 1]);
      const current = await get(S, db, task.id);
      expect(current?.body).toContain("line three");
      expect(current?.status).toBe("in_progress");
      expect(all![0]).toMatchObject({ status: "open", body: current!.body, actorKind: "human", actorTokenId: null });
      expect(all![1]).toMatchObject({ title: "Renamed", body: "line one\nline two" });
    });

    it("writes no revision when nothing content-bearing changes", async () => {
      const task = await freshTask();
      await update(S, db, task.id, { title: "Original title", tags: ["a"], priority: "low" });
      await update(S, db, task.id, { bodyAppend: "" });
      await update(S, db, task.id, { dueAt: new Date("2030-01-01T00:00:00Z"), pinned: true });
      expect(await listRevisions(S, db, task.id)).toEqual([]);
      await update(S, db, task.id, { tags: ["a", "b"] });
      expect(await listRevisions(S, db, task.id)).toHaveLength(1);
    });

    it("keeps only the newest revisions and drops history with the entity", async () => {
      const task = await freshTask();
      for (let i = 1; i <= REVISION_RETENTION + 5; i++) {
        await update(S, db, task.id, { title: `Title ${i}` });
      }
      const kept = await listRevisions(S, db, task.id, 1000);
      expect(kept).toHaveLength(REVISION_RETENTION);
      expect(kept![0]!.revision).toBe(REVISION_RETENTION + 5);
      expect(kept![kept!.length - 1]!.revision).toBe(6);
      expect(kept![0]!.title).toBe(`Title ${REVISION_RETENTION + 4}`);

      await remove(S, db, task.id);
      expect(await purge(S, db, task.id)).toBe(true);
      const orphans = await db.execute(
        sql`SELECT count(*)::int AS n FROM entity_revisions WHERE entity_id = ${task.id}::uuid`
      );
      expect((orphans.rows[0] as { n: number }).n).toBe(0);
      expect(await listRevisions(S, db, task.id)).toBeNull();
    });
  });

  it("formatOpeningBrief truncates oversized pinned notes with a fetch hint", async () => {
    const p = await createProject(S, db, { key: "OBR3", name: "OBR3 Project" });
    await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Huge pinned doc",
      body: "x".repeat(5000),
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      pinned: true
    });
    const brief = await openingBrief(S, db, { projectId: p.id, recentLimit: 5 });
    const formatted = formatOpeningBrief(brief);
    expect(formatted).toContain("truncated — fetch");
    // 2000-char per-note cap plus surrounding sections; the raw 5000-char body must not appear.
    expect(formatted).not.toContain("x".repeat(2001));
    expect(formatted).toContain("x".repeat(2000));
  });

  // ---------------------------------------------------------------------------
  // allDayDueAtInZone unit tests

  it("allDayDueAtInZone resolves UTC midnight to noon UTC (no-op equivalent to normalizeDueAt)", () => {
    const date = new Date("2026-06-23T00:00:00.000Z");
    const result = allDayDueAtInZone(date, "UTC");
    expect(result?.toISOString()).toBe("2026-06-23T12:00:00.000Z");
  });

  it("allDayDueAtInZone resolves a date at 02:00Z to the previous calendar day in America/New_York", () => {
    // 2026-06-23T02:00:00Z is 2026-06-22 22:00 EDT (UTC-4), so calendar day is June 22
    const date = new Date("2026-06-23T02:00:00.000Z");
    const result = allDayDueAtInZone(date, "America/New_York");
    // Should be noon UTC of June 22
    expect(result?.toISOString()).toBe("2026-06-22T12:00:00.000Z");
  });

  it("allDayDueAtInZone falls back to normalizeDueAt for an invalid timezone", () => {
    const date = new Date("2026-06-23T00:00:00.000Z");
    const result = allDayDueAtInZone(date, "Not/A_Timezone");
    // normalizeDueAt of midnight UTC => noon UTC
    expect(result?.toISOString()).toBe("2026-06-23T12:00:00.000Z");
  });

  it("allDayDueAtInZone returns null for null input", () => {
    expect(allDayDueAtInZone(null, "UTC")).toBeNull();
    expect(allDayDueAtInZone(undefined, "UTC")).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // workspace settings service tests

  it("getWorkspaceSettings lazy-creates default row with UTC timezone", async () => {
    const settings = await getWorkspaceSettings(S, db);
    expect(settings.timezone).toBe("UTC");
    expect(settings.id).toBe("default");
  });

  it("getWorkspaceSettings is idempotent (lazy-create does not duplicate rows)", async () => {
    const first = await getWorkspaceSettings(S, db);
    const second = await getWorkspaceSettings(S, db);
    expect(first.id).toBe(second.id);
    expect(first.timezone).toBe(second.timezone);
  });

  it("updateWorkspaceSettings persists a valid IANA timezone", async () => {
    const updated = await updateWorkspaceSettings(S, db, { timezone: "America/New_York" });
    expect(updated.timezone).toBe("America/New_York");

    const fetched = await getWorkspaceSettings(S, db);
    expect(fetched.timezone).toBe("America/New_York");
  });

  it("updateWorkspaceSettings rejects an invalid timezone string", async () => {
    await expect(
      updateWorkspaceSettings(S, db, { timezone: "Not/Real_TZ" })
    ).rejects.toThrow("Invalid IANA timezone");
  });

  it("createRecurrenceRule with no input.timezone adopts the workspace timezone", async () => {
    await updateWorkspaceSettings(S, db, { timezone: "America/Chicago" });

    const p = await createProject(S, db, { key: "WSTZ", name: "Workspace TZ" });
    const dueAt = new Date("2026-06-23T12:00:00.000Z");
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Workspace TZ task",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });

    const rule = await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      allDay: true,
      anchor: "scheduled"
      // No timezone field — should adopt workspace tz
    });

    expect(rule.timezone).toBe("America/Chicago");
  });

  // -----------------------------------------------------------------------
  // BOT-54: recurrenceScope tests
  // -----------------------------------------------------------------------

  it("this-only title edit does not propagate to next occurrence", async () => {
    const p = await createProject(S, db, { key: "SC1", name: "Scope1" });
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    dueAt.setUTCHours(12, 0, 0, 0);
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Original title",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    // Edit title with scope='this'
    await update(S, db, task.id, { title: "Changed title", recurrenceScope: "this" });

    // Complete to advance
    await update(S, db, task.id, { status: "done" });

    const details = await getRecurrenceForTask(S, db, task.id);
    expect(details?.currentOccurrence?.title).toBe("Original title");
  });

  it("going-forward edit propagates title to next occurrence", async () => {
    const p = await createProject(S, db, { key: "SC2", name: "Scope2" });
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    dueAt.setUTCHours(12, 0, 0, 0);
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Original title",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    // Edit title with scope='future' (explicit)
    await update(S, db, task.id, { title: "New title", recurrenceScope: "future" });
    await update(S, db, task.id, { status: "done" });

    const details = await getRecurrenceForTask(S, db, task.id);
    expect(details?.currentOccurrence?.title).toBe("New title");
  });

  it("baseline merge: earliest-wins — two this-only title edits preserve original", async () => {
    const p = await createProject(S, db, { key: "SC3", name: "Scope3" });
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    dueAt.setUTCHours(12, 0, 0, 0);
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Original title",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    await update(S, db, task.id, { title: "First change", recurrenceScope: "this" });
    await update(S, db, task.id, { title: "Second change", recurrenceScope: "this" });
    await update(S, db, task.id, { status: "done" });

    const details = await getRecurrenceForTask(S, db, task.id);
    expect(details?.currentOccurrence?.title).toBe("Original title");
  });

  it("mixed: this-only title + going-forward priority", async () => {
    const p = await createProject(S, db, { key: "SC4", name: "Scope4" });
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    dueAt.setUTCHours(12, 0, 0, 0);
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Original title",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt,
      priority: "low"
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    // Edit title this-only, then priority going-forward (two separate calls)
    await update(S, db, task.id, { title: "Changed title", recurrenceScope: "this" });
    await update(S, db, task.id, { priority: "high", recurrenceScope: "future" });
    await update(S, db, task.id, { status: "done" });

    const details = await getRecurrenceForTask(S, db, task.id);
    expect(details?.currentOccurrence?.title).toBe("Original title");
    expect(details?.currentOccurrence?.priority).toBe("high");
  });

  it("exception row has correct shape for this-only body edit", async () => {
    const p = await createProject(S, db, { key: "SC5", name: "Scope5" });
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    dueAt.setUTCHours(12, 0, 0, 0);
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Task",
      body: "original body",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });
    const rule = await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    await update(S, db, task.id, { body: "changed body", recurrenceScope: "this" });

    const exceptions = await db
      .select()
      .from(recurrenceExceptions)
      .where(
        and(
          eq(recurrenceExceptions.entityId, task.id),
          eq(recurrenceExceptions.action, "modified")
        )
      )
      .limit(1);
    const ex = exceptions[0];
    expect(ex).toBeDefined();
    expect(ex!.action).toBe("modified");
    expect(ex!.ruleId).toBe(rule.id);
    expect(ex!.entityId).toBe(task.id);
    const meta = ex!.metadata as Record<string, unknown>;
    expect(meta.scope).toBe("this");
    const baseline = meta.baseline as Record<string, unknown>;
    expect(baseline.body).toBe("original body");
    expect(meta.changedFields).toContain("body");
  });

  it("going-forward edit clears prior this-only baseline for that field", async () => {
    const p = await createProject(S, db, { key: "SC6", name: "Scope6" });
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    dueAt.setUTCHours(12, 0, 0, 0);
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Original title",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    // First set a this-only baseline for title
    await update(S, db, task.id, { title: "This-only change", recurrenceScope: "this" });
    // Then override going-forward — should clear the baseline
    await update(S, db, task.id, { title: "Going-forward change", recurrenceScope: "future" });

    // No modified exception should exist for this field now
    const exceptions = await db
      .select()
      .from(recurrenceExceptions)
      .where(
        and(
          eq(recurrenceExceptions.entityId, task.id),
          eq(recurrenceExceptions.action, "modified")
        )
      );
    // Either row is deleted (empty baseline) or field not in baseline
    if (exceptions.length > 0) {
      const meta = exceptions[0]!.metadata as Record<string, unknown>;
      const baseline = (meta.baseline ?? {}) as Record<string, unknown>;
      expect("title" in baseline).toBe(false);
    }

    // Complete and verify next occurrence gets going-forward value
    await update(S, db, task.id, { status: "done" });
    const details = await getRecurrenceForTask(S, db, task.id);
    expect(details?.currentOccurrence?.title).toBe("Going-forward change");
  });

  it("materializeScheduledRecurrences respects baseline for scheduled-anchor series", async () => {
    const p = await createProject(S, db, { key: "SC7", name: "Scope7" });
    const todayStartUTC = new Date();
    todayStartUTC.setUTCHours(0, 0, 0, 0);
    const twoDaysAgo = new Date(todayStartUTC);
    twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
    twoDaysAgo.setUTCHours(12, 0, 0, 0);

    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Series title",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt: twoDaysAgo
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    // Mark current occurrence as this-only title change
    await update(S, db, task.id, { title: "Occurrence-only title", recurrenceScope: "this" });

    // Materialize upcoming occurrences
    const upTo = new Date();
    upTo.setUTCDate(upTo.getUTCDate() + 1);
    const created = await materializeScheduledRecurrences(db, upTo);

    // Created occurrences should use the original series title (baseline restored)
    for (const occ of created) {
      if (occ.title !== "Occurrence-only title") {
        expect(occ.title).toBe("Series title");
      }
    }
    // At least one was created
    expect(created.length).toBeGreaterThan(0);
  });

  it("recurrenceScope is a no-op for non-recurring entities", async () => {
    const p = await createProject(S, db, { key: "SC8", name: "Scope8" });
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Plain task",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });

    // Update with recurrenceScope should work fine and update the field
    const updated = await update(S, db, task.id, {
      title: "Updated title",
      recurrenceScope: "this"
    });
    expect(updated.title).toBe("Updated title");

    // No exception row created
    const exceptions = await db
      .select()
      .from(recurrenceExceptions)
      .where(eq(recurrenceExceptions.entityId, task.id));
    expect(exceptions).toHaveLength(0);
  });

  it("skip after this-only edit: next occurrence has original series field", async () => {
    const p = await createProject(S, db, { key: "SC9", name: "Scope9" });
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    dueAt.setUTCHours(12, 0, 0, 0);
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Original title",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    // Edit title this-only, then skip
    await update(S, db, task.id, { title: "This-only title", recurrenceScope: "this" });
    const { next } = await skipOccurrence(S, db, task.id, { actorKind: "human" });

    expect(next?.title).toBe("Original title");
  });

  it("all-day recurrence under non-UTC workspace tz computes occurrence on correct local calendar day", async () => {
    // Set workspace to America/New_York (UTC-4 in summer).
    await updateWorkspaceSettings(S, db, { timezone: "America/New_York" });

    const p = await createProject(S, db, { key: "NYTK", name: "NY TZ Recurrence" });
    // dtstart noon UTC = noon UTC on June 23, which is June 23 08:00 EDT — calendar day June 23 in NY.
    const dueAt = new Date("2026-06-23T12:00:00.000Z");
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "NY daily task",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });

    const rule = await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      allDay: true,
      anchor: "scheduled"
    });

    // The next occurrence should be on June 24 local time in NY = noon UTC June 24
    expect(rule.nextOccurrenceAt?.toISOString()).toBe("2026-06-24T12:00:00.000Z");
  });

  // ---------------------------------------------------------------------------
  // BOT-53: Virtual occurrences (ghost cards) tests
  // ---------------------------------------------------------------------------

  it("virtualOccurrences is [] when includeVirtualRecurrences is false (hard boundary)", async () => {
    const p = await createProject(S, db, { key: "VRT0", name: "Virtual0" });
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    dueAt.setUTCHours(12, 0, 0, 0);
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Daily recurring",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    const from = new Date();
    from.setUTCHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 14);

    const result = await tasksRange(S, db, {
      from,
      to,
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: false
      // includeVirtualRecurrences not set → defaults to false
    });
    expect(result.virtualOccurrences).toEqual([]);
  });

  it("daily rule fills window; materialized occurrence subtracted; virtuals have correct shape", async () => {
    const p = await createProject(S, db, { key: "VRT1", name: "Virtual1" });
    // Task due tomorrow (so window starts after now but rule is already set up)
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(12, 0, 0, 0);

    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Virtual daily",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt: tomorrow
    });
    const rule = await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    // Query: from now, to now+5 days
    const from = new Date();
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 5);

    const result = await tasksRange(S, db, {
      from,
      to,
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: false,
      includeVirtualRecurrences: true
    });

    // Tomorrow's occurrence is the materialized real task (already in scheduled)
    const realIds = result.scheduled.map((e) => e.id);
    expect(realIds).toContain(task.id);

    // Virtuals should not include the materialized occurrence's dueAt
    const virtualDueTimes = result.virtualOccurrences.map((v) => v.dueAt);
    expect(virtualDueTimes).not.toContain(tomorrow.toISOString());

    // Each virtual has virtual=true, correct ruleId, seriesId, and noon-UTC dueAt
    for (const v of result.virtualOccurrences) {
      expect(v.virtual).toBe(true);
      expect(v.ruleId).toBe(rule.id);
      expect(v.seriesId).toBe(rule.seriesId);
      expect(v.id).toMatch(/^virtual:/);
      // All-day UTC → noon UTC
      const dueDate = new Date(v.dueAt);
      expect(dueDate.getUTCHours()).toBe(12);
      expect(dueDate.getUTCMinutes()).toBe(0);
    }

    // Virtuals should cover 2 days+: day-after-tomorrow through to (up to ~4 days)
    expect(result.virtualOccurrences.length).toBeGreaterThan(0);
  });

  it("virtual id format is virtual:<ruleId>:<iso>", async () => {
    const p = await createProject(S, db, { key: "VRT2", name: "Virtual2" });
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(12, 0, 0, 0);

    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "ID check",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt: tomorrow
    });
    const rule = await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    const from = new Date();
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 5);

    const result = await tasksRange(S, db, {
      from,
      to,
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: false,
      includeVirtualRecurrences: true
    });

    for (const v of result.virtualOccurrences) {
      expect(v.id).toBe(`virtual:${rule.id}:${v.dueAt}`);
    }
  });

  it("skipped exception blocks corresponding virtual occurrence", async () => {
    const p = await createProject(S, db, { key: "VRT3", name: "Virtual3" });
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(12, 0, 0, 0);

    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Skip test",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt: tomorrow
    });
    const rule = await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    // Insert a 'skipped' exception for the day-after-tomorrow occurrence.
    // The exception's occurrenceAt must match the RRule raw output date, which
    // for a UTC daily rule with dtstart=noon-UTC is also noon UTC.
    const dayAfterTomorrow = new Date(tomorrow);
    dayAfterTomorrow.setUTCDate(dayAfterTomorrow.getUTCDate() + 1);
    // dayAfterTomorrow is already noon UTC (inherited from `tomorrow`)
    await db.insert(recurrenceExceptions).values({
      ruleId: rule.id,
      occurrenceAt: dayAfterTomorrow,
      action: "skipped",
      entityId: null,
      metadata: {}
    });

    const from = new Date();
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 7);

    const result = await tasksRange(S, db, {
      from,
      to,
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: false,
      includeVirtualRecurrences: true
    });

    // The day-after-tomorrow virtual should be blocked by the exception
    const blockedDue = dayAfterTomorrow.toISOString();
    const found = result.virtualOccurrences.find((v) => v.dueAt === blockedDue);
    expect(found).toBeUndefined();
  });

  it("all-day + non-UTC timezone → dueAt is noon UTC of correct local calendar day", async () => {
    // Set workspace to America/New_York (UTC-4 summer)
    await updateWorkspaceSettings(S, db, { timezone: "America/New_York" });

    const p = await createProject(S, db, { key: "VRT4", name: "Virtual4" });
    // dueAt: noon UTC June 23 = 08:00 EDT = calendar day June 23 in NY
    const dueAt = new Date("2026-06-23T12:00:00.000Z");
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "NY tz virtual",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      allDay: true,
      anchor: "scheduled"
      // timezone inherited from workspace = America/New_York
    });

    // Query from now to 2026-06-30 (future window from today's perspective)
    const from = new Date();
    const to = new Date("2026-06-30T12:00:00.000Z");

    // If today > 2026-06-30, skip test (won't have future virtuals)
    if (from.getTime() >= to.getTime()) return;

    const result = await tasksRange(S, db, {
      from,
      to,
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: false,
      includeVirtualRecurrences: true
    });

    // Each virtual's dueAt should be noon UTC on the correct calendar day
    for (const v of result.virtualOccurrences) {
      const d = new Date(v.dueAt);
      expect(d.getUTCHours()).toBe(12);
      expect(d.getUTCMinutes()).toBe(0);
    }
  });

  it("COUNT-bounded rule → no virtuals beyond count", async () => {
    const p = await createProject(S, db, { key: "VRT5", name: "Virtual5" });
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(12, 0, 0, 0);

    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Count bounded",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt: tomorrow
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      count: 3,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    // Query 30 days
    const from = new Date();
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 30);

    const result = await tasksRange(S, db, {
      from,
      to,
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: false,
      includeVirtualRecurrences: true
    });

    // With count=3 and 1 already materialized, at most 2 virtuals
    // The RRule with count=3 only generates 3 dates total (including dtstart)
    expect(result.virtualOccurrences.length).toBeLessThanOrEqual(2);
  });

  it("stopped/disabled rule → no virtuals", async () => {
    const p = await createProject(S, db, { key: "VRT6", name: "Virtual6" });
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(12, 0, 0, 0);

    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Stopped rule",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt: tomorrow
    });
    const rule = await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    // Stop the rule
    await stopRecurrence(S, db, rule.id);

    const from = new Date();
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 7);

    const result = await tasksRange(S, db, {
      from,
      to,
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: false,
      includeVirtualRecurrences: true
    });

    expect(result.virtualOccurrences).toHaveLength(0);
  });

  it("completion-anchor rule → no virtuals (anchor must be 'scheduled')", async () => {
    const p = await createProject(S, db, { key: "VRT7", name: "Virtual7" });
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(12, 0, 0, 0);

    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Completion anchor task",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt: tomorrow
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "completion"
    });

    const from = new Date();
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 7);

    const result = await tasksRange(S, db, {
      from,
      to,
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: false,
      includeVirtualRecurrences: true
    });

    expect(result.virtualOccurrences).toHaveLength(0);
  });

  it("project filter restricts virtuals to matching projectId", async () => {
    const p1 = await createProject(S, db, { key: "VRP1", name: "Virtual P1" });
    const p2 = await createProject(S, db, { key: "VRP2", name: "Virtual P2" });

    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(12, 0, 0, 0);

    const task1 = await write(S, db, {
      kind: "task",
      projectId: p1.id,
      title: "P1 daily",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt: tomorrow
    });
    await createRecurrenceRule(S, db, task1.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    const task2 = await write(S, db, {
      kind: "task",
      projectId: p2.id,
      title: "P2 daily",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt: tomorrow
    });
    await createRecurrenceRule(S, db, task2.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    const from = new Date();
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 5);

    // Filter to p1 only
    const result = await tasksRange(S, db, {
      from,
      to,
      projectIds: [p1.id],
      includeBacklog: false,
      includeDone: false,
      includeVirtualRecurrences: true
    });

    for (const v of result.virtualOccurrences) {
      expect(v.projectId).toBe(p1.id);
    }
    expect(result.virtualOccurrences.length).toBeGreaterThan(0);
  });

  it("virtual dueAt is within [windowStart, to); window clamped to now", async () => {
    const p = await createProject(S, db, { key: "VRT8", name: "Virtual8" });
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(12, 0, 0, 0);

    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Horizon test",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt: tomorrow
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    const from = new Date("2020-01-01T00:00:00.000Z"); // past
    const to = new Date();
    to.setUTCDate(to.getUTCDate() + 7);
    const now = Date.now();

    const result = await tasksRange(S, db, {
      from,
      to,
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: false,
      includeVirtualRecurrences: true
    });

    // All virtual dueAt must be >= now (no past ghosts, even though from is in past)
    for (const v of result.virtualOccurrences) {
      expect(new Date(v.dueAt).getTime()).toBeGreaterThanOrEqual(now - 60000); // 1-minute tolerance
      expect(new Date(v.dueAt).getTime()).toBeLessThan(to.getTime());
    }
  });

  it("CORRECTION 1: after going-forward title edit, virtual title reflects NEW title", async () => {
    const p = await createProject(S, db, { key: "VRC1", name: "VirtualCorr1" });
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(12, 0, 0, 0);

    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Original title",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt: tomorrow
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    // Going-forward title edit (no recurrenceScope = going-forward by default)
    await update(S, db, task.id, { title: "New series title", recurrenceScope: "future" });

    const from = new Date();
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 5);

    const result = await tasksRange(S, db, {
      from,
      to,
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: false,
      includeVirtualRecurrences: true
    });

    // All virtuals should reflect the new title
    for (const v of result.virtualOccurrences) {
      expect(v.title).toBe("New series title");
    }
    expect(result.virtualOccurrences.length).toBeGreaterThan(0);
  });

  it("CORRECTION 1: after this-only title edit, virtual title reflects ORIGINAL (baseline) title", async () => {
    const p = await createProject(S, db, { key: "VRC2", name: "VirtualCorr2" });
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(12, 0, 0, 0);

    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Original title",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt: tomorrow
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    // This-only edit: title on current occurrence should not propagate to virtuals
    await update(S, db, task.id, { title: "This-occurrence-only title", recurrenceScope: "this" });

    const from = new Date();
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 5);

    const result = await tasksRange(S, db, {
      from,
      to,
      projectIds: [p.id],
      includeBacklog: false,
      includeDone: false,
      includeVirtualRecurrences: true
    });

    // Virtuals should show original (baseline) title, not the this-only override
    for (const v of result.virtualOccurrences) {
      expect(v.title).toBe("Original title");
    }
    expect(result.virtualOccurrences.length).toBeGreaterThan(0);
  });

  it("splitRecurrence forks a scheduled series at the current occurrence", async () => {
    const p = await createProject(S, db, { key: "SPL", name: "Split Scheduled" });
    const dueAt = new Date();
    dueAt.setUTCHours(12, 0, 0, 0);
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Series task",
      body: "series body",
      tags: ["series"],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt,
      priority: "high"
    });
    const rule = await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    const newRule = await splitRecurrence(S, db, rule.id, { preset: "weekly", interval: 1 });

    // Old rule is frozen with UNTIL at the fork; disabled but kept as history.
    const [oldRow] = await db
      .select()
      .from(recurrenceRules)
      .where(eq(recurrenceRules.id, rule.id));
    expect(oldRow.enabled).toBe(false);
    expect(oldRow.rrule).toContain("UNTIL=");
    expect(oldRow.endedAt).not.toBeNull();
    expect(oldRow.currentOccurrenceId).toBe(task.id);

    // New rule shares the series_id (UI continuity) but is a distinct row.
    expect(newRule.id).not.toBe(rule.id);
    expect(newRule.seriesId).toBe(rule.seriesId);
    expect(newRule.enabled).toBe(true);
    expect(newRule.rrule).toContain("FREQ=WEEKLY");
    expect(newRule.generatedCount).toBe(0);
    expect(newRule.currentOccurrenceId).toBe(task.id);
    // First new-cadence occurrence is strictly after the fork — no duplicate at it.
    expect(newRule.dtstart.getTime()).toBeGreaterThan(dueAt.getTime());
    expect(newRule.nextOccurrenceAt?.getTime()).toBe(newRule.dtstart.getTime());

    // Exactly one task carries the fork due date (the original current occurrence).
    const atFork = await db.select().from(entities).where(eq(entities.dueAt, dueAt));
    expect(atFork).toHaveLength(1);
    expect(atFork[0].id).toBe(task.id);

    // Materialize the new cadence forward.
    const upTo = new Date(dueAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    const created = await materializeScheduledRecurrences(db, upTo);
    expect(created.length).toBeGreaterThan(0);
    const first = created[0];
    expect(first.dueAt?.getTime()).toBe(newRule.dtstart.getTime());
    expect(first.dueAt?.getTime()).not.toBe(dueAt.getTime());
    expect(first.title).toBe("Series task");
    expect(first.priority).toBe("high");
    const marker = (first.metadata as { recurrence?: Record<string, unknown> }).recurrence;
    expect(marker?.seriesId).toBe(rule.seriesId);
    expect(marker?.ruleId).toBe(newRule.id);

    // Re-running the materializer over the same window is idempotent (no dupes).
    const createdAgain = await materializeScheduledRecurrences(db, upTo);
    expect(createdAgain).toHaveLength(0);

    // The original occurrence still routes to the (disabled) old rule.
    const fromCurrent = await getRecurrenceForTask(S, db, task.id);
    expect(fromCurrent?.rule.id).toBe(rule.id);
  });

  it("splitRecurrence with completion anchor re-homes the current occurrence", async () => {
    const p = await createProject(S, db, { key: "SPC", name: "Split Completion" });
    const dueAt = new Date();
    dueAt.setUTCDate(dueAt.getUTCDate() - 1);
    dueAt.setUTCHours(12, 0, 0, 0);
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Maintenance",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });
    const rule = await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    const newRule = await splitRecurrence(S, db, rule.id, {
      preset: "weekly",
      interval: 1,
      anchor: "completion"
    });
    expect(newRule.anchor).toBe("completion");
    expect(newRule.currentOccurrenceId).toBe(task.id);
    expect(newRule.nextOccurrenceAt).toBeNull();
    expect(newRule.generatedCount).toBe(rule.generatedCount);

    // Old rule is frozen and releases the current occurrence (it was re-homed).
    const [oldRow] = await db
      .select()
      .from(recurrenceRules)
      .where(eq(recurrenceRules.id, rule.id));
    expect(oldRow.enabled).toBe(false);
    expect(oldRow.currentOccurrenceId).toBeNull();

    // The current occurrence now routes to the new rule.
    const rehomed = await getRecurrenceForTask(S, db, task.id);
    expect(rehomed?.rule.id).toBe(newRule.id);

    // Completing it advances the NEW (weekly, completion) cadence.
    await update(S, db, task.id, { status: "done" });
    const details = await getRecurrenceForTask(S, db, task.id);
    expect(details?.rule.id).toBe(newRule.id);
    expect(details?.rule.currentOccurrenceId).not.toBe(task.id);
    expect(details?.currentOccurrence?.status).toBe("open");
    const nextDue = details?.currentOccurrence?.dueAt?.getTime() ?? 0;
    expect(nextDue).toBeGreaterThan(Date.now());
  });

  it("splitRecurrence rejects unknown and disabled rules", async () => {
    await expect(
      splitRecurrence(S, db, "00000000-0000-0000-0000-000000000000", { preset: "daily" })
    ).rejects.toThrow(/not found/);

    const p = await createProject(S, db, { key: "SPD", name: "Split Disabled" });
    const dueAt = new Date();
    dueAt.setUTCHours(12, 0, 0, 0);
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Already stopped",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });
    const rule = await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });
    await stopRecurrence(S, db, rule.id);
    await expect(splitRecurrence(S, db, rule.id, { preset: "weekly" })).rejects.toThrow(/active/);
  });

  // ---------------------------------------------------------------------------
  // listTags service tests

  it("listTags returns distinct tags ordered by count desc then tag asc", async () => {
    const p = await createProject(S, db, { key: "LTAG", name: "List Tags" });
    await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Task 1",
      body: "",
      tags: ["alpha", "beta"],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Task 2",
      body: "",
      tags: ["alpha", "gamma"],
      status: "open",
      actorKind: "human",
      metadata: {}
    });

    const tags = await listTags(S, db, { projectId: p.id });
    // alpha appears twice, beta and gamma once
    expect(tags[0]?.tag).toBe("alpha");
    expect(tags[0]?.count).toBe(2);
    // beta and gamma both have count=1, sorted alphabetically
    const rest = tags.slice(1).map((t) => t.tag);
    expect(rest).toEqual(["beta", "gamma"]);
    expect(tags.slice(1).every((t) => t.count === 1)).toBe(true);
  });

  it("listTags scopes to projectId when provided", async () => {
    const p1 = await createProject(S, db, { key: "TLP1", name: "Tags Project 1" });
    const p2 = await createProject(S, db, { key: "TLP2", name: "Tags Project 2" });
    await write(S, db, {
      kind: "note",
      projectId: p1.id,
      title: "P1 note",
      body: "",
      tags: ["p1-only"],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    await write(S, db, {
      kind: "note",
      projectId: p2.id,
      title: "P2 note",
      body: "",
      tags: ["p2-only"],
      status: "open",
      actorKind: "human",
      metadata: {}
    });

    const tagsP1 = await listTags(S, db, { projectId: p1.id });
    expect(tagsP1.map((t) => t.tag)).toEqual(["p1-only"]);

    const tagsAll = await listTags(S, db, { projectId: null });
    const tagNames = tagsAll.map((t) => t.tag);
    expect(tagNames).toContain("p1-only");
    expect(tagNames).toContain("p2-only");
  });

  it("listTags returns empty array when no tags exist", async () => {
    const p = await createProject(S, db, { key: "TLZ", name: "Tags Zero" });
    await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "No tags task",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const tags = await listTags(S, db, { projectId: p.id });
    expect(tags).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // getLinks service tests

  it("getLinks returns outgoing edges correctly", async () => {
    const p = await createProject(S, db, { key: "GLO", name: "Get Links Outgoing" });
    const taskA = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Task A",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const taskB = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Task B",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    await link(S, db, { fromId: taskA.id, toId: taskB.id, kind: "blocks" });

    const outgoing = await getLinks(S, db, { id: taskA.id, kind: null, direction: "outgoing" });
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]?.kind).toBe("blocks");
    expect(outgoing[0]?.direction).toBe("outgoing");
    expect(outgoing[0]?.entity.id).toBe(taskB.id);

    const incoming = await getLinks(S, db, { id: taskA.id, kind: null, direction: "incoming" });
    expect(incoming).toHaveLength(0);
  });

  it("getLinks returns incoming edges correctly", async () => {
    const p = await createProject(S, db, { key: "GLI", name: "Get Links Incoming" });
    const taskA = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Blocker",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const taskB = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Blocked",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    await link(S, db, { fromId: taskA.id, toId: taskB.id, kind: "references" });

    const incoming = await getLinks(S, db, { id: taskB.id, kind: null, direction: "incoming" });
    expect(incoming).toHaveLength(1);
    expect(incoming[0]?.kind).toBe("references");
    expect(incoming[0]?.direction).toBe("incoming");
    expect(incoming[0]?.entity.id).toBe(taskA.id);
  });

  it("getLinks returns both directions and supports kind filter", async () => {
    const p = await createProject(S, db, { key: "GLB", name: "Get Links Both" });
    const hub = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Hub task",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const child = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Child note",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const ref = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Ref note",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    await link(S, db, { fromId: hub.id, toId: child.id, kind: "parent_of" });
    await link(S, db, { fromId: ref.id, toId: hub.id, kind: "references" });

    const both = await getLinks(S, db, { id: hub.id, kind: null, direction: "both" });
    expect(both.length).toBe(2);
    const directions = both.map((l) => l.direction).sort();
    expect(directions).toEqual(["incoming", "outgoing"]);

    // Filter by kind=parent_of → only outgoing
    const filtered = await getLinks(S, db, { id: hub.id, kind: "parent_of", direction: "both" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.kind).toBe("parent_of");
    expect(filtered[0]?.direction).toBe("outgoing");
  });

  it("splitRecurrence rolls back when the new cadence has no occurrence after the fork", async () => {
    const p = await createProject(S, db, { key: "SPN", name: "Split No Occurrence" });
    const dueAt = new Date();
    dueAt.setUTCHours(12, 0, 0, 0);
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Bounded split",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });
    const rule = await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });

    const beforeFork = new Date(dueAt.getTime() - 7 * 24 * 60 * 60 * 1000);
    await expect(
      splitRecurrence(S, db, rule.id, { preset: "weekly", until: beforeFork })
    ).rejects.toThrow(/no occurrences after the fork/);

    // No half-split: the old rule is untouched and remains the only rule.
    const [oldRow] = await db
      .select()
      .from(recurrenceRules)
      .where(eq(recurrenceRules.id, rule.id));
    expect(oldRow.enabled).toBe(true);
    const rows = await db
      .select()
      .from(recurrenceRules)
      .where(eq(recurrenceRules.seriesId, rule.seriesId));
    expect(rows).toHaveLength(1);
  });

  it("update bodyAppend appends to non-empty body with blank line separator", async () => {
    const p = await createProject(S, db, { key: "BAP1", name: "BodyAppend Test 1" });
    const entity = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Append note",
      body: "initial content",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });

    const updated = await update(S, db, entity.id, { bodyAppend: "second paragraph" });
    expect(updated.body).toBe("initial content\n\nsecond paragraph");
  });

  it("update bodyAppend appends to empty body without leading blank line", async () => {
    const p = await createProject(S, db, { key: "BAP2", name: "BodyAppend Test 2" });
    const entity = await write(S, db, {
      kind: "note",
      projectId: p.id,
      title: "Empty body note",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });

    const updated = await update(S, db, entity.id, { bodyAppend: "first content" });
    expect(updated.body).toBe("first content");
  });

  it("update rejects when both body and bodyAppend are provided", async () => {
    const { UpdateInput } = await import("../src/service/types.js");
    const result = UpdateInput.safeParse({ body: "full body", bodyAppend: "extra" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "";
      expect(msg).toContain("mutually exclusive");
    }
  });
});

describe("trash consistency", () => {
  async function trashedTask() {
    const p = await createProject(S, db, { key: "TRSH", name: "Trash Project" });
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Soon trashed",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    expect(await remove(S, db, task.id)).toBe(true);
    return { p, task };
  }

  it("get and getByKey still return a trashed entity, with deletedAt set", async () => {
    const { task } = await trashedTask();
    const byId = await get(S, db, task.id);
    expect(byId?.id).toBe(task.id);
    expect(byId?.deletedAt).toBeInstanceOf(Date);
    const byKey = await getByKey(S, db, "TRSH", task.sequenceId!);
    expect(byKey?.id).toBe(task.id);
    expect(byKey?.deletedAt).toBeInstanceOf(Date);
  });

  it("refuses update and addWorklogEntry on a trashed entity with 409 until it is restored", async () => {
    const { task } = await trashedTask();
    const expect409 = async (promise: Promise<unknown>) => {
      await expect(promise).rejects.toMatchObject({
        statusCode: 409,
        message: "entity is in trash; restore first"
      });
    };
    await expect409(update(S, db, task.id, { status: "done" }));
    await expect409(addWorklogEntry(S, db, task.id, { body: "late note", actorKind: "agent" }));
    const entries = await listWorklog(S, db, task.id);
    expect(entries).toHaveLength(0);

    const back = await restore(S, db, task.id);
    expect(back?.deletedAt).toBeNull();
    const done = await update(S, db, task.id, { status: "done" });
    expect(done.status).toBe("done");
    const entry = await addWorklogEntry(S, db, task.id, { body: "after restore", actorKind: "agent" });
    expect(entry.parentId).toBe(task.id);
  });

  it("link validates both endpoints and rejects self-links", async () => {
    const { task } = await trashedTask();
    const missing = "00000000-0000-0000-0000-000000000000";
    await expect(link(S, db, { fromId: task.id, toId: task.id, kind: "references" })).rejects.toMatchObject({
      statusCode: 400
    });
    await expect(link(S, db, { fromId: task.id, toId: missing, kind: "references" })).rejects.toMatchObject({
      statusCode: 404
    });
    await expect(link(S, db, { fromId: missing, toId: task.id, kind: "references" })).rejects.toMatchObject({
      statusCode: 404
    });
  });
});

describe("pruneExpiredSessions", () => {
  it("deletes expired sessions and keeps live ones", async () => {
    const live = await createSession(S, db, { ttlDays: 7 });
    const expired = await createSession(S, db, { ttlDays: 7 });
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(sessions.id, expired.session.id));

    expect(await pruneExpiredSessions(db)).toBe(1);
    const left = await db.select({ id: sessions.id }).from(sessions);
    expect(left.map((r) => r.id)).toEqual([live.session.id]);
    expect(await pruneExpiredSessions(db)).toBe(0);
  });
});

describe("task buckets are disjoint", () => {
  it("places every unfinished task in exactly one of overdue, scheduled or backlog", async () => {
    const p = await createProject(S, db, { key: "DISJ", name: "Disjoint" });
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const mk = (title: string, status: string, dueAt?: Date) =>
      write(S, db, {
        kind: "task",
        projectId: p.id,
        title,
        body: "",
        tags: [],
        status,
        actorKind: "human",
        metadata: {},
        dueAt
      });
    const overdueOpen = await mk("overdue open", "open", past);
    const overdueStarted = await mk("overdue in progress", "in_progress", past);
    const upcoming = await mk("upcoming", "open", future);
    const startedUpcoming = await mk("started upcoming", "in_progress", future);
    const undated = await mk("undated", "open");
    const undatedStarted = await mk("undated in progress", "in_progress");

    const range = await tasksRange(S, db, {
      projectIds: [p.id],
      to: new Date("2100-01-01T00:00:00Z"),
      includeBacklog: true,
      includeDone: false
    });
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
    expect(ids(range.overdue)).toEqual([overdueOpen.id, overdueStarted.id].sort());
    expect(ids(range.scheduled)).toEqual([upcoming.id, startedUpcoming.id].sort());
    expect(ids(range.backlog)).toEqual([undated.id, undatedStarted.id].sort());

    const all = [...range.overdue, ...range.scheduled, ...range.backlog].map((r) => r.id);
    expect(new Set(all).size).toBe(all.length);

    // Without backlog, undated active work still surfaces on today.
    const noBacklog = await tasksRange(S, db, {
      projectIds: [p.id],
      to: new Date("2100-01-01T00:00:00Z"),
      includeBacklog: false,
      includeDone: false
    });
    expect(ids(noBacklog.scheduled)).toEqual([upcoming.id, startedUpcoming.id, undatedStarted.id].sort());
    expect(noBacklog.backlog).toEqual([]);
  });
});

describe("recurrence on a task without a due date", () => {
  const rule = { preset: "daily", interval: 1, timezone: "UTC", allDay: true, anchor: "scheduled" } as const;

  it("fails with 400 instead of 500 when neither dueAt nor dtstart is given", async () => {
    const p = await createProject(S, db, { key: "NODUE", name: "No Due" });
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Undated recurring",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    await expect(createRecurrenceRule(S, db, task.id, rule)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("dtstart")
    });
    await expect(
      createRecurrenceRule(S, db, "00000000-0000-0000-0000-000000000000", rule)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("uses an explicit dtstart as the seed task's due date", async () => {
    const p = await createProject(S, db, { key: "DTST", name: "Dtstart" });
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Undated recurring",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const dtstart = new Date(Date.now() + 24 * 60 * 60 * 1000);
    dtstart.setUTCHours(12, 0, 0, 0);
    const created = await createRecurrenceRule(S, db, task.id, { ...rule, dtstart });
    expect(created.dtstart.getTime()).toBe(dtstart.getTime());
    const seeded = await get(S, db, task.id);
    expect(seeded?.dueAt?.getTime()).toBe(dtstart.getTime());
  });
});

describe("occurrence notes stay on the occurrence", () => {
  async function dailySeries(key: string) {
    const p = await createProject(S, db, { key, name: key });
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    dueAt.setUTCHours(12, 0, 0, 0);
    const task = await write(S, db, {
      kind: "task",
      projectId: p.id,
      title: "Weekly sync",
      body: "Agenda template",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {},
      dueAt
    });
    await createRecurrenceRule(S, db, task.id, {
      preset: "daily",
      interval: 1,
      timezone: "UTC",
      allDay: true,
      anchor: "scheduled"
    });
    return task;
  }

  it("a body edit without recurrenceScope does not copy into the next occurrence", async () => {
    const task = await dailySeries("OCB1");
    await update(S, db, task.id, { body: "Agenda template\n\nNotes: decided X" });
    await update(S, db, task.id, { status: "done" });
    const details = await getRecurrenceForTask(S, db, task.id);
    expect(details?.currentOccurrence?.body).toBe("Agenda template");
    expect(details?.currentOccurrence?.title).toBe("Weekly sync");
  });

  it("bodyAppend without recurrenceScope is occurrence-only too", async () => {
    const task = await dailySeries("OCB2");
    await update(S, db, task.id, { bodyAppend: "Notes: decided Y" });
    const edited = await get(S, db, task.id);
    expect(edited?.body).toBe("Agenda template\n\nNotes: decided Y");
    await update(S, db, task.id, { status: "done" });
    const details = await getRecurrenceForTask(S, db, task.id);
    expect(details?.currentOccurrence?.body).toBe("Agenda template");
  });

  it("an explicit future-scoped body edit still carries forward", async () => {
    const task = await dailySeries("OCB3");
    await update(S, db, task.id, { body: "New agenda template", recurrenceScope: "future" });
    await update(S, db, task.id, { status: "done" });
    const details = await getRecurrenceForTask(S, db, task.id);
    expect(details?.currentOccurrence?.body).toBe("New agenda template");
  });

  it("a title edit without recurrenceScope still carries forward", async () => {
    const task = await dailySeries("OCB4");
    await update(S, db, task.id, { title: "Weekly sync (renamed)" });
    await update(S, db, task.id, { status: "done" });
    const details = await getRecurrenceForTask(S, db, task.id);
    expect(details?.currentOccurrence?.title).toBe("Weekly sync (renamed)");
  });
});

describe("search recall and ranking", () => {
  const DIM = 384;
  function unitVec(seed: number): number[] {
    const v = new Array<number>(DIM);
    let x = seed;
    for (let i = 0; i < DIM; i++) {
      x = (x * 1664525 + 1013904223) >>> 0;
      v[i] = x / 0xffffffff - 0.5;
    }
    const norm = Math.sqrt(v.reduce((acc, c) => acc + c * c, 0));
    return v.map((c) => c / norm);
  }

  async function note(projectId: string, title: string, body: string, vec?: number[]) {
    const e = await write(S, db, {
      kind: "note",
      projectId,
      title,
      body,
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    if (vec) await setBodyVec(db, e.id, vec);
    return e;
  }

  it("project-scoped vector search returns every row of a tiny project", async () => {
    const tiny = await createProject(S, db, { key: "TINY", name: "Tiny" });
    const big = await createProject(S, db, { key: "BIGP", name: "Big" });

    const queryVec = unitVec(7);
    const tinyIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = await note(tiny.id, `Tiny ${i}`, "quiet unrelated prose", unitVec(1000 + i));
      tinyIds.push(e.id);
    }
    // Noise lives in another project and sits much closer to the query, so a
    // post-filtered nearest-neighbour walk would exhaust its candidates on it.
    for (let i = 0; i < 60; i++) {
      await note(big.id, `Noise ${i}`, "quiet unrelated prose", queryVec.map((c, j) => c + (j % 7 === i % 7 ? 0.01 : 0)));
    }

    const hits = await search(S, db, { query: "zzqx-nomatch", projectId: tiny.id, limit: 10 }, { queryEmbedding: queryVec });
    expect(hits.map((h) => h.entity.id).sort()).toEqual([...tinyIds].sort());
    for (const h of hits) expect(h.components.cosine).toBeDefined();
  });

  it("timeDecayFor decays with age and stays below one top-of-list RRF step", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const fresh = timeDecayFor(now, now);
    const quarter = timeDecayFor(new Date(now.getTime() - 90 * 86_400_000), now);
    const year = timeDecayFor(new Date(now.getTime() - 365 * 86_400_000), now);
    const future = timeDecayFor(new Date(now.getTime() + 86_400_000), now);

    expect(fresh).toBeLessThan(1 / 61 - 1 / 62);
    expect(quarter).toBeCloseTo(fresh / Math.E, 8);
    expect(year).toBeLessThan(quarter);
    expect(year).toBeGreaterThan(0);
    expect(future).toBe(fresh);
  });

  it("scores freshness per hit instead of boosting the newest rows globally", async () => {
    const p = await createProject(S, db, { key: "DECY", name: "Decay" });
    const old = await note(p.id, "Old zephyr", "zephyr");
    const recent = await note(p.id, "Recent zephyr", "zephyr");
    for (let i = 0; i < 45; i++) await note(p.id, `Filler ${i}`, "nothing relevant");
    await db.execute(
      sql`UPDATE entities SET created_at = now() - interval '400 days' WHERE id = ${old.id}`
    );

    const hits = await search(S, db, { query: "zephyr", projectId: p.id, limit: 10 });
    const byId = new Map(hits.map((h) => [h.entity.id, h]));
    const oldHit = byId.get(old.id)!;
    const recentHit = byId.get(recent.id)!;
    expect(oldHit.components.timeDecay).toBeDefined();
    expect(recentHit.components.timeDecay).toBeDefined();
    expect(recentHit.components.timeDecay!).toBeGreaterThan(oldHit.components.timeDecay!);
    expect(recentHit.components.timeDecay!).toBeLessThan(1 / 61 - 1 / 62);
  });

  it("freshness never outranks a better lexical match", async () => {
    const p = await createProject(S, db, { key: "FRSH", name: "Fresh" });
    const strong = await note(p.id, "Quasar quasar", "quasar quasar quasar quasar");
    const weak = await note(p.id, "Weak", "one mention of quasar only");
    await db.execute(
      sql`UPDATE entities SET created_at = now() - interval '3 years' WHERE id = ${strong.id}`
    );

    const hits = await search(S, db, { query: "quasar", projectId: p.id, limit: 5 });
    expect(hits.map((h) => h.entity.id)).toEqual([strong.id, weak.id]);
  });
});
