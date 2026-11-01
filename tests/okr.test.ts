import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { edges } from "../src/db/schema.js";
import { listWorklog, write } from "../src/service/entities.js";
import {
  createKeyResult,
  createObjective,
  getOkr,
  getReview,
  isoWeekOf,
  keyResultMeta,
  listReviews,
  monthOf,
  objectiveMeta,
  quarterMonths,
  quarterOf,
  quarterOfPeriod,
  recordReview,
  reviewMeta,
  scoreKeyResult,
  tierRankFor,
  updateKeyResult,
  updateObjective
} from "../src/service/okr.js";
import { formatOpeningBrief, openingBrief } from "../src/service/opening_brief.js";
import { briefOkr } from "../src/service/okr.js";
import { createProject } from "../src/service/projects.js";
import { DEFAULT_SCOPE as S } from "../src/service/scope.js";
import {
  CreateKeyResultInput,
  CreateObjectiveInput,
  RecordReviewInput,
  ScoreKeyResultInput,
  UpdateKeyResultInput,
  UpdateObjectiveInput
} from "../src/service/types.js";
import { updateWorkspaceSettings } from "../src/service/workspace_settings.js";
import { createTestDb } from "./test_db.js";

const { db, pool } = createTestDb();

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE recurrence_exceptions, recurrence_rules, entities, edges, projects, tokens, sessions, embedding_settings, workspace_settings
    RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  await pool.end();
});

async function objectiveFixture(overrides: Partial<CreateObjectiveInput> = {}) {
  const project = await createProject(S, db, { key: "OKRT", name: "OKR test" });
  const objective = await createObjective(
    S,
    db,
    CreateObjectiveInput.parse({
      projectId: project.id,
      quarter: "2026Q4",
      title: "Ship the fine-mapping results paper",
      tier: "P0",
      ...overrides
    })
  );
  return { project, objective };
}

describe("okr period helpers", () => {
  it("derives quarter, month and ISO week in the workspace timezone", () => {
    const lateOct = new Date("2026-11-01T02:30:00Z");
    expect(quarterOf(lateOct, "America/New_York")).toBe("2026Q4");
    expect(monthOf(lateOct, "America/New_York")).toBe("2026-10");
    expect(monthOf(lateOct, "UTC")).toBe("2026-11");
    expect(isoWeekOf(new Date("2026-10-31T12:00:00Z"))).toBe("2026-W44");
    expect(isoWeekOf(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
    expect(quarterOf(new Date("2026-09-30T23:00:00Z"), "UTC")).toBe("2026Q3");
  });

  it("maps periods to quarters and quarters to months", () => {
    expect(quarterMonths("2026Q4")).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(quarterOfPeriod("monthly", "2026-11")).toBe("2026Q4");
    expect(quarterOfPeriod("weekly", "2026-W40")).toBe("2026Q4");
    expect(quarterOfPeriod("weekly", "2026-W53")).toBe("2026Q4");
    expect(() => quarterOfPeriod("weekly", "2025-W53")).toThrow(/does not exist/);
  });

  it("ranks research tiers before side tiers", () => {
    expect(tierRankFor("P0")).toBe(0);
    expect(tierRankFor("P3")).toBe(3);
    expect(tierRankFor("Side 1")).toBe(11);
    expect(tierRankFor("side2")).toBe(12);
    expect(tierRankFor("Wife")).toBe(50);
  });
});

describe("objectives", () => {
  it("creates an objective with tier metadata and a KEY-SEQ number", async () => {
    const { objective } = await objectiveFixture();
    expect(objective.kind).toBe("objective");
    expect(objective.sequenceId).toBe(1);
    expect(objectiveMeta(objective)).toEqual({
      quarter: "2026Q4",
      tier: "P0",
      tierRank: 0,
      ownerId: null
    });
  });

  it("returns the existing objective for a repeated idempotency key", async () => {
    const { project, objective } = await objectiveFixture({ idempotencyKey: "obj-1" });
    const again = await createObjective(
      S,
      db,
      CreateObjectiveInput.parse({
        projectId: project.id,
        quarter: "2026Q4",
        title: "Something else",
        tier: "P1",
        idempotencyKey: "obj-1"
      })
    );
    expect(again.id).toBe(objective.id);
    expect(again.title).toBe(objective.title);
  });

  it("rejects an unknown project", async () => {
    await expect(
      createObjective(
        S,
        db,
        CreateObjectiveInput.parse({
          projectId: "00000000-0000-4000-8000-0000000000aa",
          quarter: "2026Q4",
          title: "x",
          tier: "P0"
        })
      )
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("updates the tier, re-derives the rank and logs the change", async () => {
    const { objective } = await objectiveFixture();
    const updated = await updateObjective(
      S,
      db,
      objective.id,
      UpdateObjectiveInput.parse({ tier: "Side 2", reason: "Deprioritized at the monthly check" })
    );
    expect(objectiveMeta(updated)).toMatchObject({ tier: "Side 2", tierRank: 12 });

    const log = await listWorklog(S, db, objective.id);
    expect(log).toHaveLength(1);
    expect(log[0]!.body).toContain("tier: P0 → Side 2");
    expect(log[0]!.body).toContain("Reason: Deprioritized at the monthly check");
    expect(log[0]!.metadata).toMatchObject({
      okrChange: { changes: { tier: { from: "P0", to: "Side 2" } } }
    });
  });

  it("writes nothing when an update changes nothing", async () => {
    const { objective } = await objectiveFixture();
    const same = await updateObjective(
      S,
      db,
      objective.id,
      UpdateObjectiveInput.parse({ tier: "P0", title: objective.title! })
    );
    expect(same.updatedAt.getTime()).toBe(objective.updatedAt.getTime());
    expect(await listWorklog(S, db, objective.id)).toHaveLength(0);
  });

  it("refuses to update a task through the objective path", async () => {
    const { project } = await objectiveFixture();
    const task = await write(S, db, {
      kind: "task",
      projectId: project.id,
      title: "plain task",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    await expect(
      updateObjective(S, db, task.id, UpdateObjectiveInput.parse({ tier: "P1" }))
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("key results", () => {
  it("creates a key result under its objective in the objective's project", async () => {
    const { project, objective } = await objectiveFixture();
    const kr = await createKeyResult(
      S,
      db,
      CreateKeyResultInput.parse({
        objectiveId: objective.id,
        title: "Main figures 1–2 first version",
        month: "2026-10",
        dueAt: "2026-10-31"
      })
    );
    expect(kr.kind).toBe("key_result");
    expect(kr.parentId).toBe(objective.id);
    expect(kr.projectId).toBe(project.id);
    expect(kr.dueAt?.toISOString()).toBe("2026-10-31T12:00:00.000Z");
    expect(keyResultMeta(kr)).toMatchObject({ month: "2026-10", score: null });
  });

  it("returns the existing key result for a repeated idempotency key", async () => {
    const { objective } = await objectiveFixture();
    const input = CreateKeyResultInput.parse({
      objectiveId: objective.id,
      title: "KR",
      month: "2026-11",
      idempotencyKey: "kr-1"
    });
    const first = await createKeyResult(S, db, input);
    const second = await createKeyResult(S, db, { ...input, title: "changed" });
    expect(second.id).toBe(first.id);
    expect(second.title).toBe("KR");
  });

  it("rejects a month outside the objective's quarter", async () => {
    const { objective } = await objectiveFixture();
    await expect(
      createKeyResult(
        S,
        db,
        CreateKeyResultInput.parse({ objectiveId: objective.id, title: "KR", month: "2027-01" })
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("requires a reason for plan changes and logs them", async () => {
    const { objective } = await objectiveFixture();
    const kr = await createKeyResult(
      S,
      db,
      CreateKeyResultInput.parse({ objectiveId: objective.id, title: "KR", month: "2026-10" })
    );
    await expect(
      updateKeyResult(S, db, kr.id, UpdateKeyResultInput.parse({ month: "2026-11" }))
    ).rejects.toMatchObject({ statusCode: 400 });

    const moved = await updateKeyResult(
      S,
      db,
      kr.id,
      UpdateKeyResultInput.parse({
        month: "2026-11",
        dueAt: "2026-11-15",
        reason: "Data release slipped two weeks"
      })
    );
    expect(keyResultMeta(moved).month).toBe("2026-11");
    expect(moved.dueAt?.toISOString()).toBe("2026-11-15T12:00:00.000Z");

    const log = await listWorklog(S, db, kr.id);
    expect(log).toHaveLength(1);
    expect(log[0]!.body).toContain("month: 2026-10 → 2026-11");
    expect(log[0]!.body).toContain("dueAt: — → 2026-11-15");
    expect(log[0]!.body).toContain("Reason: Data release slipped two weeks");
  });

  it("allows a status change without a reason", async () => {
    const { objective } = await objectiveFixture();
    const kr = await createKeyResult(
      S,
      db,
      CreateKeyResultInput.parse({ objectiveId: objective.id, title: "KR", month: "2026-10" })
    );
    const done = await updateKeyResult(S, db, kr.id, UpdateKeyResultInput.parse({ status: "done" }));
    expect(done.status).toBe("done");
    expect(await listWorklog(S, db, kr.id)).toHaveLength(1);
  });

  it("scores a key result, logs the score, and treats a repeated score as a no-op", async () => {
    const { objective } = await objectiveFixture();
    const kr = await createKeyResult(
      S,
      db,
      CreateKeyResultInput.parse({ objectiveId: objective.id, title: "KR", month: "2026-10" })
    );
    const scored = await scoreKeyResult(
      S,
      db,
      kr.id,
      ScoreKeyResultInput.parse({ score: 0.7, note: "On target" })
    );
    expect(keyResultMeta(scored).score).toBe(0.7);
    expect(keyResultMeta(scored).scoredAt).not.toBeNull();

    const again = await scoreKeyResult(S, db, kr.id, ScoreKeyResultInput.parse({ score: 0.7 }));
    expect(again.updatedAt.getTime()).toBe(scored.updatedAt.getTime());

    const log = await listWorklog(S, db, kr.id);
    expect(log).toHaveLength(1);
    expect(log[0]!.body).toContain("score: — → 0.7");
    expect(log[0]!.body).toContain("Reason: On target");
  });

  it("rejects scores outside 0..1", () => {
    expect(ScoreKeyResultInput.safeParse({ score: 1.2 }).success).toBe(false);
    expect(ScoreKeyResultInput.safeParse({ score: -0.1 }).success).toBe(false);
  });
});

describe("getOkr", () => {
  it("groups key results under objectives, sorted by tier then month", async () => {
    const research = await createProject(S, db, { key: "RES", name: "Research" });
    const side = await createProject(S, db, { key: "SIDE", name: "Side" });
    const sideObjective = await createObjective(
      S,
      db,
      CreateObjectiveInput.parse({ projectId: side.id, quarter: "2026Q4", title: "Side O", tier: "Side 1" })
    );
    const researchObjective = await createObjective(
      S,
      db,
      CreateObjectiveInput.parse({ projectId: research.id, quarter: "2026Q4", title: "Res O", tier: "P1" })
    );
    await createObjective(
      S,
      db,
      CreateObjectiveInput.parse({ projectId: research.id, quarter: "2027Q1", title: "Next quarter", tier: "P0" })
    );
    const nov = await createKeyResult(
      S,
      db,
      CreateKeyResultInput.parse({ objectiveId: researchObjective.id, title: "Nov KR", month: "2026-11" })
    );
    const oct = await createKeyResult(
      S,
      db,
      CreateKeyResultInput.parse({ objectiveId: researchObjective.id, title: "Oct KR", month: "2026-10" })
    );

    const view = await getOkr(S, db, { quarter: "2026Q4", includeClosed: true });
    expect(view.months).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(view.objectives.map((o) => o.id)).toEqual([researchObjective.id, sideObjective.id]);
    const first = view.objectives[0]!;
    expect(first.key).toBe("RES-1");
    expect(first.project).toMatchObject({ key: "RES", name: "Research" });
    expect(first.keyResults.map((k) => k.id)).toEqual([oct.id, nov.id]);
    expect(first.keyResults[0]!.key).toBe("RES-4");
    expect(first.keyResults[0]!.month).toBe("2026-10");

    const onlySide = await getOkr(S, db, { quarter: "2026Q4", projectId: side.id, includeClosed: true });
    expect(onlySide.objectives.map((o) => o.id)).toEqual([sideObjective.id]);
  });

  it("defaults to the current quarter in the workspace timezone and can hide closed work", async () => {
    await updateWorkspaceSettings(S, db, { timezone: "America/New_York" });
    const { objective } = await objectiveFixture({ quarter: "2026Q4" });
    const kr = await createKeyResult(
      S,
      db,
      CreateKeyResultInput.parse({ objectiveId: objective.id, title: "KR", month: "2026-12" })
    );
    await updateKeyResult(S, db, kr.id, UpdateKeyResultInput.parse({ status: "rejected" }));

    // 2027-01-01T02:00Z is still New Year's Eve in New York.
    const view = await getOkr(S, db, { includeClosed: false }, new Date("2027-01-01T02:00:00Z"));
    expect(view.quarter).toBe("2026Q4");
    expect(view.objectives).toHaveLength(1);
    expect(view.objectives[0]!.keyResults).toEqual([]);
  });
});

describe("reviews", () => {
  it("records a weekly review with a Top 5 and links the referenced tasks", async () => {
    const { project } = await objectiveFixture();
    const task = await write(S, db, {
      kind: "task",
      projectId: project.id,
      title: "Main figures",
      body: "",
      tags: [],
      status: "open",
      actorKind: "human",
      metadata: {}
    });
    const review = await recordReview(
      S,
      db,
      RecordReviewInput.parse({
        type: "weekly",
        period: "2026-W44",
        body: "Good week.",
        top5: [{ title: "Main figures 1–2", refIds: [task.id.slice(0, 8)] }, { title: "Reply to Mitch" }]
      })
    );
    expect(review.kind).toBe("okr_review");
    expect(review.title).toBe("Weekly review 2026-W44");
    expect(review.projectId).toBeNull();
    expect(reviewMeta(review)).toEqual({
      type: "weekly",
      period: "2026-W44",
      quarter: "2026Q4",
      top5: [
        { title: "Main figures 1–2", refIds: [task.id] },
        { title: "Reply to Mitch", refIds: [] }
      ]
    });
    const links = await db
      .select()
      .from(edges)
      .where(and(eq(edges.fromId, review.id), eq(edges.kind, "references")));
    expect(links.map((l) => l.toId)).toEqual([task.id]);
  });

  it("replaces the review for the same period and drops stale links", async () => {
    const { project } = await objectiveFixture();
    const mk = (title: string) =>
      write(S, db, {
        kind: "task",
        projectId: project.id,
        title,
        body: "",
        tags: [],
        status: "open",
        actorKind: "human",
        metadata: {}
      });
    const a = await mk("a");
    const b = await mk("b");
    const first = await recordReview(
      S,
      db,
      RecordReviewInput.parse({ type: "weekly", period: "2026-W44", top5: [{ title: "A", refIds: [a.id] }] })
    );
    const second = await recordReview(
      S,
      db,
      RecordReviewInput.parse({
        type: "weekly",
        period: "2026-W44",
        body: "revised",
        top5: [{ title: "B", refIds: [b.id] }]
      })
    );
    expect(second.id).toBe(first.id);
    expect(second.body).toBe("revised");
    const links = await db.select().from(edges).where(eq(edges.fromId, first.id));
    expect(links.map((l) => l.toId)).toEqual([b.id]);
    expect((await getReview(S, db, "weekly", "2026-W44"))?.id).toBe(first.id);
  });

  it("returns the existing review unchanged for a repeated idempotency key", async () => {
    const input = RecordReviewInput.parse({
      type: "monthly",
      period: "2026-11",
      body: "first",
      idempotencyKey: "review-1"
    });
    const first = await recordReview(S, db, input);
    const again = await recordReview(S, db, { ...input, body: "second" });
    expect(again.id).toBe(first.id);
    expect(again.body).toBe("first");
  });

  it("validates the period format for the review type", () => {
    expect(RecordReviewInput.safeParse({ type: "weekly", period: "2026-11" }).success).toBe(false);
    expect(RecordReviewInput.safeParse({ type: "monthly", period: "2026-W44" }).success).toBe(false);
    expect(
      RecordReviewInput.safeParse({ type: "weekly", period: "2026-W44", top5: Array(6).fill({ title: "x" }) })
        .success
    ).toBe(false);
  });

  it("rejects an unknown Top 5 reference", async () => {
    await expect(
      recordReview(
        S,
        db,
        RecordReviewInput.parse({
          type: "weekly",
          period: "2026-W44",
          top5: [{ title: "x", refIds: ["00000000-0000-4000-8000-0000000000bb"] }]
        })
      )
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("lists reviews by quarter and type, newest period first", async () => {
    await recordReview(S, db, RecordReviewInput.parse({ type: "weekly", period: "2026-W44" }));
    await recordReview(S, db, RecordReviewInput.parse({ type: "weekly", period: "2026-W45" }));
    await recordReview(S, db, RecordReviewInput.parse({ type: "monthly", period: "2026-11" }));
    await recordReview(S, db, RecordReviewInput.parse({ type: "weekly", period: "2027-W02" }));

    const weekly = await listReviews(S, db, { quarter: "2026Q4", type: "weekly", limit: 20 });
    expect(weekly.map((r) => reviewMeta(r).period)).toEqual(["2026-W45", "2026-W44"]);
    const all = await listReviews(S, db, { quarter: "2026Q4", limit: 20 });
    expect(all).toHaveLength(3);
  });
});

describe("OKR in opening briefs", () => {
  const now = new Date("2026-10-31T16:00:00Z");

  async function seed() {
    const research = await createProject(S, db, { key: "RES", name: "Research" });
    const side = await createProject(S, db, { key: "SIDE", name: "Side" });
    const resObjective = await createObjective(
      S,
      db,
      CreateObjectiveInput.parse({ projectId: research.id, quarter: "2026Q4", title: "Results paper", tier: "P0" })
    );
    await createObjective(
      S,
      db,
      CreateObjectiveInput.parse({ projectId: side.id, quarter: "2026Q4", title: "OKR v1", tier: "Side 2" })
    );
    const octKr = await createKeyResult(
      S,
      db,
      CreateKeyResultInput.parse({
        objectiveId: resObjective.id,
        title: "Figures 1–2",
        month: "2026-10",
        dueAt: "2026-10-31",
        score: 0.5
      })
    );
    await createKeyResult(
      S,
      db,
      CreateKeyResultInput.parse({ objectiveId: resObjective.id, title: "Remaining figures", month: "2026-11" })
    );
    return { research, side, resObjective, octKr };
  }

  it("shows the project's objective and only this month's key results", async () => {
    const { research } = await seed();
    const okr = await briefOkr(S, db, research.id, now);
    expect(okr?.month).toBe("2026-10");
    expect(okr?.objectives).toHaveLength(1);
    expect(okr?.objectives[0]!.keyResults.map((k) => k.title)).toEqual(["Figures 1–2"]);
    expect(okr?.topFive).toBeNull();

    const brief = await openingBrief(S, db, { projectId: research.id, recentLimit: 5 });
    brief.okr = okr;
    const md = formatOpeningBrief(brief);
    expect(md).toContain("## OKR 2026Q4 — this month (2026-10)");
    expect(md).toContain("**P0 objective:** Results paper [RES-1]");
    expect(md).toContain("- [RES-2] Figures 1–2 (due 2026-10-31) · score 0.5");
    expect(md).not.toContain("[RES-3] Remaining figures");
  });

  it("shows the workspace tier list and this week's Top 5", async () => {
    const { octKr } = await seed();
    await recordReview(
      S,
      db,
      RecordReviewInput.parse({
        type: "weekly",
        period: "2026-W44",
        top5: [{ title: "Finish figures", refIds: [octKr.id] }, { title: "Inbox zero" }]
      })
    );
    const okr = await briefOkr(S, db, null, now);
    expect(okr?.objectives.map((o) => o.tier)).toEqual(["P0", "Side 2"]);
    expect(okr?.topFive).toEqual({
      period: "2026-W44",
      current: true,
      items: [
        { title: "Finish figures", refs: ["RES-2"] },
        { title: "Inbox zero", refs: [] }
      ]
    });

    const brief = await openingBrief(S, db, { recentLimit: 5 });
    brief.okr = okr;
    const md = formatOpeningBrief(brief);
    expect(md).toContain("## OKR 2026Q4 — tiers");
    expect(md).toContain("- P0 · RES Research: Results paper [RES-1]");
    expect(md).toContain("- Side 2 · SIDE Side: OKR v1 [SIDE-1]");
    expect(md).toContain("## Top 5 — this week (2026-W44)");
    expect(md).toContain("1. Finish figures (RES-2)");
  });

  it("falls back to the latest earlier Top 5 and labels it", async () => {
    await seed();
    await recordReview(
      S,
      db,
      RecordReviewInput.parse({ type: "weekly", period: "2026-W43", top5: [{ title: "Old item" }] })
    );
    const okr = await briefOkr(S, db, null, now);
    expect(okr?.topFive).toMatchObject({ period: "2026-W43", current: false });
    const brief = await openingBrief(S, db, { recentLimit: 5 });
    brief.okr = okr;
    expect(formatOpeningBrief(brief)).toContain("## Top 5 — latest: 2026-W43; no review for 2026-W44 yet");
  });

  it("leaves the brief unchanged when no OKR exists", async () => {
    const p = await createProject(S, db, { key: "NONE", name: "None" });
    expect(await briefOkr(S, db, p.id, now)).toBeNull();
    const brief = await openingBrief(S, db, { projectId: p.id, recentLimit: 5 });
    expect(formatOpeningBrief(brief)).not.toContain("## OKR");
  });
});
