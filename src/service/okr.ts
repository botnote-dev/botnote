import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { edges, entities, projects, type Entity } from "../db/schema.js";
import { normalizeDueAt } from "./dates.js";
import { addWorklogEntry, get, resolveEntityId, update, write } from "./entities.js";
import type { Scope } from "./scope.js";
import type {
  CreateKeyResultInput,
  CreateObjectiveInput,
  GetOkrInput,
  ListReviewsInput,
  OkrTopItem,
  RecordReviewInput,
  ScoreKeyResultInput,
  UpdateKeyResultInput,
  UpdateObjectiveInput,
  WriteAttribution
} from "./types.js";
import { getWorkspaceSettings } from "./workspace_settings.js";

/**
 * OKRs live in the entities table as three kinds:
 * - objective: one per project per quarter; metadata {quarter, tier, tierRank, ownerId}
 * - key_result: child of an objective; dueAt column plus metadata {month, score}
 * - okr_review: workspace-scoped weekly review (with Top 5) or monthly check;
 *   metadata {type, period, quarter, top5}
 * Plan changes are kept as worklog entries on the changed entity, each with
 * metadata.okrChange = {changes: {field: {from, to}}, reason}.
 */

export type ReviewType = "weekly" | "monthly";

export interface ObjectiveMeta {
  quarter: string;
  tier: string;
  tierRank: number;
  ownerId: string | null;
}

export interface KeyResultMeta {
  month: string;
  score: number | null;
  scoredAt: string | null;
}

export interface StoredTopItem {
  title: string;
  refIds: string[];
}

export interface ReviewMeta {
  type: ReviewType;
  period: string;
  quarter: string;
  top5: StoredTopItem[];
}

export type KeyResultView = Entity & {
  key: string | null;
  month: string;
  score: number | null;
};

export type ObjectiveView = Entity & {
  key: string | null;
  quarter: string;
  tier: string;
  tierRank: number;
  ownerId: string | null;
  project: { id: string; key: string; name: string } | null;
  keyResults: KeyResultView[];
};

export interface OkrQuarterView {
  quarter: string;
  months: string[];
  objectives: ObjectiveView[];
}

type FieldChanges = Record<string, { from: unknown; to: unknown }>;

function clientError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

function metaOf(entity: Entity): Record<string, unknown> {
  return (entity.metadata ?? {}) as Record<string, unknown>;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function localYmd(date: Date, timezone: string): { y: number; m: number; d: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
  } catch {
    return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
  }
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: pick("year"), m: pick("month"), d: pick("day") };
}

export function quarterOf(date: Date, timezone = "UTC"): string {
  const { y, m } = localYmd(date, timezone);
  return `${y}Q${Math.ceil(m / 3)}`;
}

export function monthOf(date: Date, timezone = "UTC"): string {
  const { y, m } = localYmd(date, timezone);
  return `${y}-${pad2(m)}`;
}

function isoWeekOfUtcDay(y: number, m: number, d: number): string {
  const t = new Date(Date.UTC(y, m - 1, d));
  const weekday = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad2(week)}`;
}

export function isoWeekOf(date: Date, timezone = "UTC"): string {
  const { y, m, d } = localYmd(date, timezone);
  return isoWeekOfUtcDay(y, m, d);
}

/** The Thursday of an ISO week decides which year, month and quarter it belongs to. */
function isoWeekThursday(period: string): Date {
  const [yearPart, weekPart] = period.split("-W");
  const year = Number(yearPart);
  const week = Number(weekPart);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Weekday = jan4.getUTCDay() || 7;
  const monday = Date.UTC(year, 0, 4 - (jan4Weekday - 1) + (week - 1) * 7);
  const thursday = new Date(monday + 3 * 86_400_000);
  if (isoWeekOfUtcDay(thursday.getUTCFullYear(), thursday.getUTCMonth() + 1, thursday.getUTCDate()) !== period) {
    throw clientError(`week ${period} does not exist`, 400);
  }
  return thursday;
}

export function quarterOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${y}Q${Math.ceil(m / 3)}`;
}

export function quarterOfPeriod(type: ReviewType, period: string): string {
  if (type === "monthly") return quarterOfMonth(period);
  return quarterOf(isoWeekThursday(period));
}

export function quarterMonths(quarter: string): string[] {
  const year = quarter.slice(0, 4);
  const q = Number(quarter.slice(5));
  return [1, 2, 3].map((i) => `${year}-${pad2((q - 1) * 3 + i)}`);
}

/** P0..P3 rank 0..3; Side 1..3 rank 11..13; any other label ranks after both. */
export function tierRankFor(tier: string): number {
  const research = /^P(\d{1,2})$/i.exec(tier.trim());
  if (research) return Number(research[1]);
  const side = /^Side\s*(\d{1,2})$/i.exec(tier.trim());
  if (side) return 10 + Number(side[1]);
  return 50;
}

export function objectiveMeta(entity: Entity): ObjectiveMeta {
  const m = entity.metadata as Partial<ObjectiveMeta>;
  const tier = typeof m.tier === "string" ? m.tier : "";
  return {
    quarter: typeof m.quarter === "string" ? m.quarter : "",
    tier,
    tierRank: typeof m.tierRank === "number" ? m.tierRank : tierRankFor(tier),
    ownerId: typeof m.ownerId === "string" ? m.ownerId : null
  };
}

export function keyResultMeta(entity: Entity): KeyResultMeta {
  const m = entity.metadata as Partial<KeyResultMeta>;
  return {
    month: typeof m.month === "string" ? m.month : "",
    score: typeof m.score === "number" ? m.score : null,
    scoredAt: typeof m.scoredAt === "string" ? m.scoredAt : null
  };
}

export function reviewMeta(entity: Entity): ReviewMeta {
  const m = entity.metadata as Partial<ReviewMeta>;
  return {
    type: m.type === "monthly" ? "monthly" : "weekly",
    period: typeof m.period === "string" ? m.period : "",
    quarter: typeof m.quarter === "string" ? m.quarter : "",
    top5: Array.isArray(m.top5) ? m.top5 : []
  };
}

async function requireKind(
  scope: Scope,
  db: Database["db"],
  id: string,
  kind: "objective" | "key_result"
): Promise<Entity> {
  const entity = await get(scope, db, id);
  if (!entity || entity.kind !== kind) {
    throw clientError(`${kind.replace("_", " ")} ${id} not found`, 404);
  }
  if (entity.deletedAt) throw clientError("entity is in trash; restore first", 409);
  return entity;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && value.length > 80) return `${value.slice(0, 77)}…`;
  return String(value);
}

async function logChange(
  scope: Scope,
  db: Database["db"],
  entityId: string,
  changes: FieldChanges,
  reason: string | undefined,
  actorKind: UpdateObjectiveInput["actorKind"],
  attribution: WriteAttribution
): Promise<void> {
  const lines = Object.entries(changes).map(([field, { from, to }]) =>
    field === "body"
      ? "- body edited"
      : `- ${field}: ${formatValue(from)} → ${formatValue(to)}`
  );
  const body = [`OKR change`, ...lines, ...(reason ? [`Reason: ${reason}`] : [])].join("\n");
  const serializable = Object.fromEntries(
    Object.entries(changes).map(([field, { from, to }]) => [
      field,
      {
        from: from instanceof Date ? from.toISOString() : (from ?? null),
        to: to instanceof Date ? to.toISOString() : (to ?? null)
      }
    ])
  );
  await addWorklogEntry(
    scope,
    db,
    entityId,
    {
      body,
      actorKind,
      metadata: { okrChange: { changes: serializable, reason: reason ?? null } },
      idempotencyKey: null
    },
    attribution
  );
}

export async function createObjective(
  scope: Scope,
  db: Database["db"],
  input: CreateObjectiveInput,
  attribution: WriteAttribution = {}
): Promise<Entity> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, scope.workspaceId)))
    .limit(1);
  if (!project) throw clientError(`project ${input.projectId} not found`, 404);

  const meta: ObjectiveMeta = {
    quarter: input.quarter,
    tier: input.tier,
    tierRank: input.tierRank ?? tierRankFor(input.tier),
    ownerId: input.ownerId ?? null
  };
  return write(scope, db, {
    kind: "objective",
    projectId: input.projectId,
    title: input.title,
    body: input.body,
    tags: input.tags,
    status: "open",
    parentId: null,
    actorKind: input.actorKind,
    actorTokenId: attribution.actorTokenId ?? null,
    metadata: { ...meta },
    dueAt: null,
    priority: "none",
    pinned: false,
    idempotencyKey: input.idempotencyKey
  });
}

export async function updateObjective(
  scope: Scope,
  db: Database["db"],
  id: string,
  input: UpdateObjectiveInput,
  attribution: WriteAttribution = {}
): Promise<Entity> {
  const objective = await requireKind(scope, db, id, "objective");
  const meta = objectiveMeta(objective);
  const changes: FieldChanges = {};

  if (input.title !== undefined && input.title !== objective.title) {
    changes.title = { from: objective.title, to: input.title };
  }
  if (input.body !== undefined && input.body !== objective.body) {
    changes.body = { from: objective.body, to: input.body };
  }
  if (input.status !== undefined && input.status !== objective.status) {
    changes.status = { from: objective.status, to: input.status };
  }
  const next: ObjectiveMeta = { ...meta };
  if (input.tier !== undefined && input.tier !== meta.tier) {
    changes.tier = { from: meta.tier, to: input.tier };
    next.tier = input.tier;
    if (input.tierRank === undefined) next.tierRank = tierRankFor(input.tier);
  }
  if (input.tierRank !== undefined) {
    const rank = input.tierRank ?? tierRankFor(next.tier);
    if (rank !== meta.tierRank) changes.tierRank = { from: meta.tierRank, to: rank };
    next.tierRank = rank;
  } else if (next.tierRank !== meta.tierRank) {
    changes.tierRank = { from: meta.tierRank, to: next.tierRank };
  }
  if (input.ownerId !== undefined && input.ownerId !== meta.ownerId) {
    changes.ownerId = { from: meta.ownerId, to: input.ownerId };
    next.ownerId = input.ownerId;
  }
  if (Object.keys(changes).length === 0) return objective;

  const row = await update(
    scope,
    db,
    objective.id,
    {
      ...(changes.title ? { title: input.title } : {}),
      ...(changes.body ? { body: input.body } : {}),
      ...(changes.status ? { status: input.status } : {}),
      metadata: { ...metaOf(objective), ...next }
    },
    attribution
  );
  await logChange(scope, db, objective.id, changes, input.reason, input.actorKind, attribution);
  return row;
}

export async function createKeyResult(
  scope: Scope,
  db: Database["db"],
  input: CreateKeyResultInput,
  attribution: WriteAttribution = {}
): Promise<Entity> {
  if (input.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.idempotencyKey, input.idempotencyKey),
          eq(entities.workspaceId, scope.workspaceId)
        )
      )
      .limit(1);
    if (existing) return existing;
  }
  const objective = await requireKind(scope, db, input.objectiveId, "objective");
  const { quarter } = objectiveMeta(objective);
  if (quarterOfMonth(input.month) !== quarter) {
    throw clientError(`month ${input.month} is outside the objective's quarter ${quarter}`, 400);
  }
  const meta: KeyResultMeta = {
    month: input.month,
    score: input.score ?? null,
    scoredAt: input.score != null ? new Date().toISOString() : null
  };
  return write(scope, db, {
    kind: "key_result",
    projectId: objective.projectId,
    title: input.title,
    body: input.body,
    tags: input.tags,
    status: "open",
    parentId: objective.id,
    actorKind: input.actorKind,
    actorTokenId: attribution.actorTokenId ?? null,
    metadata: { ...meta },
    dueAt: input.dueAt ?? null,
    priority: "none",
    pinned: false,
    idempotencyKey: input.idempotencyKey
  });
}

export async function updateKeyResult(
  scope: Scope,
  db: Database["db"],
  id: string,
  input: UpdateKeyResultInput,
  attribution: WriteAttribution = {}
): Promise<Entity> {
  const kr = await requireKind(scope, db, id, "key_result");
  const meta = keyResultMeta(kr);
  const changes: FieldChanges = {};

  if (input.title !== undefined && input.title !== kr.title) {
    changes.title = { from: kr.title, to: input.title };
  }
  if (input.body !== undefined && input.body !== kr.body) {
    changes.body = { from: kr.body, to: input.body };
  }
  if (input.month !== undefined && input.month !== meta.month) {
    if (kr.parentId) {
      const objective = await get(scope, db, kr.parentId);
      const quarter = objective ? objectiveMeta(objective).quarter : "";
      if (quarter && quarterOfMonth(input.month) !== quarter) {
        throw clientError(`month ${input.month} is outside the objective's quarter ${quarter}`, 400);
      }
    }
    changes.month = { from: meta.month, to: input.month };
  }
  if (input.dueAt !== undefined) {
    const nextDue = normalizeDueAt(input.dueAt);
    if ((nextDue?.getTime() ?? null) !== (kr.dueAt?.getTime() ?? null)) {
      changes.dueAt = { from: kr.dueAt, to: nextDue };
    }
  }
  const planChanged = Object.keys(changes).length > 0;
  if (planChanged && !input.reason) {
    throw clientError(
      "reason is required when a key result's title, body, month or due date changes",
      400
    );
  }
  if (input.status !== undefined && input.status !== kr.status) {
    changes.status = { from: kr.status, to: input.status };
  }
  if (Object.keys(changes).length === 0) return kr;

  const row = await update(
    scope,
    db,
    kr.id,
    {
      ...(changes.title ? { title: input.title } : {}),
      ...(changes.body ? { body: input.body } : {}),
      ...(changes.status ? { status: input.status } : {}),
      ...(changes.dueAt ? { dueAt: input.dueAt } : {}),
      ...(changes.month ? { metadata: { ...metaOf(kr), month: input.month } } : {})
    },
    attribution
  );
  await logChange(scope, db, kr.id, changes, input.reason, input.actorKind, attribution);
  return row;
}

export async function scoreKeyResult(
  scope: Scope,
  db: Database["db"],
  id: string,
  input: ScoreKeyResultInput,
  attribution: WriteAttribution = {}
): Promise<Entity> {
  const kr = await requireKind(scope, db, id, "key_result");
  const meta = keyResultMeta(kr);
  if (input.score === meta.score) return kr;
  const row = await update(
    scope,
    db,
    kr.id,
    {
      metadata: {
        ...metaOf(kr),
        score: input.score,
        scoredAt: input.score === null ? null : new Date().toISOString()
      }
    },
    attribution
  );
  await logChange(
    scope,
    db,
    kr.id,
    { score: { from: meta.score, to: input.score } },
    input.note || undefined,
    input.actorKind,
    attribution
  );
  return row;
}

function entityKey(entity: Entity, projectKey: string | undefined): string | null {
  return projectKey && entity.sequenceId != null ? `${projectKey}-${entity.sequenceId}` : null;
}

export async function currentPeriods(
  scope: Scope,
  db: Database["db"],
  now: Date = new Date()
): Promise<{ timezone: string; quarter: string; month: string; week: string }> {
  const { timezone } = await getWorkspaceSettings(scope, db);
  return {
    timezone,
    quarter: quarterOf(now, timezone),
    month: monthOf(now, timezone),
    week: isoWeekOf(now, timezone)
  };
}

export async function getOkr(
  scope: Scope,
  db: Database["db"],
  input: GetOkrInput,
  now: Date = new Date()
): Promise<OkrQuarterView> {
  const quarter = input.quarter ?? (await currentPeriods(scope, db, now)).quarter;
  const openOnly = inArray(entities.status, ["open", "in_progress"]);

  const objectiveConds = [
    eq(entities.workspaceId, scope.workspaceId),
    eq(entities.kind, "objective"),
    isNull(entities.deletedAt),
    sql`${entities.metadata} ->> 'quarter' = ${quarter}`
  ];
  if (input.projectId) objectiveConds.push(eq(entities.projectId, input.projectId));
  else {
    objectiveConds.push(sql`${entities.projectId} IN (
      SELECT id FROM projects
      WHERE status <> 'archived' AND workspace_id = ${scope.workspaceId}::uuid
    )`);
  }
  if (!input.includeClosed) objectiveConds.push(openOnly);
  const objectiveRows = await db
    .select()
    .from(entities)
    .where(and(...objectiveConds))
    .orderBy(asc(entities.createdAt));

  const objectiveIds = objectiveRows.map((o) => o.id);
  const krConds = [
    eq(entities.workspaceId, scope.workspaceId),
    eq(entities.kind, "key_result"),
    isNull(entities.deletedAt)
  ];
  if (!input.includeClosed) krConds.push(openOnly);
  const krRows = objectiveIds.length
    ? await db
        .select()
        .from(entities)
        .where(and(...krConds, inArray(entities.parentId, objectiveIds)))
        .orderBy(asc(entities.createdAt))
    : [];

  const projectIds = [...new Set(objectiveRows.map((o) => o.projectId).filter((p): p is string => !!p))];
  const projectRows = projectIds.length
    ? await db
        .select({ id: projects.id, key: projects.key, name: projects.name })
        .from(projects)
        .where(inArray(projects.id, projectIds))
    : [];
  const projectById = new Map(projectRows.map((p) => [p.id, p]));

  const krsByObjective = new Map<string, KeyResultView[]>();
  for (const kr of krRows) {
    const meta = keyResultMeta(kr);
    const projectKey = kr.projectId ? projectById.get(kr.projectId)?.key : undefined;
    const view: KeyResultView = {
      ...kr,
      key: entityKey(kr, projectKey),
      month: meta.month,
      score: meta.score
    };
    const list = krsByObjective.get(kr.parentId!) ?? [];
    list.push(view);
    krsByObjective.set(kr.parentId!, list);
  }
  const dueTime = (kr: KeyResultView) => kr.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  for (const list of krsByObjective.values()) {
    list.sort((a, b) => a.month.localeCompare(b.month) || dueTime(a) - dueTime(b));
  }

  const objectives: ObjectiveView[] = objectiveRows.map((o) => {
    const meta = objectiveMeta(o);
    const project = o.projectId ? (projectById.get(o.projectId) ?? null) : null;
    return {
      ...o,
      ...meta,
      key: entityKey(o, project?.key),
      project,
      keyResults: krsByObjective.get(o.id) ?? []
    };
  });
  objectives.sort(
    (a, b) =>
      a.tierRank - b.tierRank ||
      (a.project?.key ?? "").localeCompare(b.project?.key ?? "") ||
      a.createdAt.getTime() - b.createdAt.getTime()
  );
  return { quarter, months: quarterMonths(quarter), objectives };
}

async function resolveTopItems(
  scope: Scope,
  db: Database["db"],
  items: OkrTopItem[]
): Promise<StoredTopItem[]> {
  const resolved: StoredTopItem[] = [];
  for (const item of items) {
    const refIds: string[] = [];
    for (const ref of item.refIds) {
      const id = await resolveEntityId(scope, db, ref);
      const entity = id ? await get(scope, db, id) : null;
      if (!entity) throw clientError(`Top 5 reference ${ref} not found`, 404);
      if (!refIds.includes(entity.id)) refIds.push(entity.id);
    }
    resolved.push({ title: item.title, refIds });
  }
  return resolved;
}

async function findReview(
  scope: Scope,
  db: Database["db"],
  type: ReviewType,
  period: string
): Promise<Entity | null> {
  const [row] = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, scope.workspaceId),
        eq(entities.kind, "okr_review"),
        isNull(entities.deletedAt),
        sql`${entities.metadata} ->> 'type' = ${type}`,
        sql`${entities.metadata} ->> 'period' = ${period}`
      )
    )
    .orderBy(asc(entities.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getReview(
  scope: Scope,
  db: Database["db"],
  type: ReviewType,
  period: string
): Promise<Entity | null> {
  return findReview(scope, db, type, period);
}

function reviewTitle(type: ReviewType, period: string): string {
  return type === "weekly" ? `Weekly review ${period}` : `Monthly check ${period}`;
}

export async function recordReview(
  scope: Scope,
  db: Database["db"],
  input: RecordReviewInput,
  attribution: WriteAttribution = {}
): Promise<Entity> {
  if (input.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.idempotencyKey, input.idempotencyKey),
          eq(entities.workspaceId, scope.workspaceId)
        )
      )
      .limit(1);
    if (existing) return existing;
  }

  const quarter = quarterOfPeriod(input.type, input.period);
  const top5 = await resolveTopItems(scope, db, input.top5);
  const meta: ReviewMeta = { type: input.type, period: input.period, quarter, top5 };
  const existing = await findReview(scope, db, input.type, input.period);

  let review: Entity;
  let previousRefs: string[] = [];
  if (existing) {
    previousRefs = reviewMeta(existing).top5.flatMap((t) => t.refIds);
    review = await update(
      scope,
      db,
      existing.id,
      { body: input.body, metadata: { ...metaOf(existing), ...meta } },
      attribution
    );
  } else {
    review = await write(scope, db, {
      kind: "okr_review",
      projectId: null,
      title: reviewTitle(input.type, input.period),
      body: input.body,
      tags: [],
      status: "done",
      parentId: null,
      actorKind: input.actorKind,
      actorTokenId: attribution.actorTokenId ?? null,
      metadata: { ...meta },
      dueAt: null,
      priority: "none",
      pinned: false,
      idempotencyKey: input.idempotencyKey
    });
  }

  const nextRefs = [...new Set(top5.flatMap((t) => t.refIds))];
  const dropped = previousRefs.filter((id) => !nextRefs.includes(id));
  if (dropped.length) {
    await db
      .delete(edges)
      .where(
        and(eq(edges.fromId, review.id), eq(edges.kind, "references"), inArray(edges.toId, dropped))
      );
  }
  if (nextRefs.length) {
    await db
      .insert(edges)
      .values(nextRefs.map((toId) => ({ fromId: review.id, toId, kind: "references" as const })))
      .onConflictDoNothing();
  }
  return review;
}

export async function listReviews(
  scope: Scope,
  db: Database["db"],
  input: ListReviewsInput
): Promise<Entity[]> {
  const conds = [
    eq(entities.workspaceId, scope.workspaceId),
    eq(entities.kind, "okr_review"),
    isNull(entities.deletedAt)
  ];
  if (input.quarter) conds.push(sql`${entities.metadata} ->> 'quarter' = ${input.quarter}`);
  if (input.type) conds.push(sql`${entities.metadata} ->> 'type' = ${input.type}`);
  return db
    .select()
    .from(entities)
    .where(and(...conds))
    .orderBy(sql`${entities.metadata} ->> 'period' DESC`, sql`${entities.metadata} ->> 'type' DESC`)
    .limit(input.limit);
}

export interface BriefKeyResult {
  id: string;
  key: string | null;
  title: string | null;
  status: string;
  month: string;
  dueAt: Date | null;
  score: number | null;
}

export interface BriefObjective {
  id: string;
  key: string | null;
  title: string | null;
  status: string;
  tier: string;
  tierRank: number;
  project: { key: string; name: string } | null;
  keyResults: BriefKeyResult[];
}

export interface BriefTopFive {
  period: string;
  /** False when this week has no review yet and the latest earlier one is shown. */
  current: boolean;
  items: Array<{ title: string; refs: string[] }>;
}

export interface BriefOkr {
  quarter: string;
  month: string;
  week: string;
  objectives: BriefObjective[];
  topFive: BriefTopFive | null;
}

async function refLabels(
  scope: Scope,
  db: Database["db"],
  ids: string[]
): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: entities.id, kind: entities.kind, seq: entities.sequenceId, key: projects.key })
    .from(entities)
    .leftJoin(projects, eq(entities.projectId, projects.id))
    .where(and(eq(entities.workspaceId, scope.workspaceId), inArray(entities.id, ids)));
  return new Map(
    rows.map((r) => [
      r.id,
      r.key && r.seq != null ? `${r.key}-${r.seq}` : `${r.kind}/${r.id.slice(0, 8)}`
    ])
  );
}

/**
 * OKR context for an opening brief. A project brief gets that project's open
 * objectives with this month's key results; the workspace brief gets every open
 * objective as the tier list plus this week's Top 5.
 */
export async function briefOkr(
  scope: Scope,
  db: Database["db"],
  projectId: string | null,
  now: Date = new Date()
): Promise<BriefOkr | null> {
  const periods = await currentPeriods(scope, db, now);
  const view = await getOkr(
    scope,
    db,
    { quarter: periods.quarter, projectId: projectId ?? undefined, includeClosed: true },
    now
  );
  const activeObjectives = view.objectives.filter(
    (o) => o.status === "open" || o.status === "in_progress"
  );

  let topFive: BriefTopFive | null = null;
  if (!projectId) {
    const thisWeek = await findReview(scope, db, "weekly", periods.week);
    const review =
      thisWeek ??
      (
        await db
          .select()
          .from(entities)
          .where(
            and(
              eq(entities.workspaceId, scope.workspaceId),
              eq(entities.kind, "okr_review"),
              isNull(entities.deletedAt),
              sql`${entities.metadata} ->> 'type' = 'weekly'`,
              sql`${entities.metadata} ->> 'period' < ${periods.week}`
            )
          )
          .orderBy(sql`${entities.metadata} ->> 'period' DESC`)
          .limit(1)
      )[0];
    if (review) {
      const meta = reviewMeta(review);
      const labels = await refLabels(scope, db, meta.top5.flatMap((t) => t.refIds));
      topFive = {
        period: meta.period,
        current: meta.period === periods.week,
        items: meta.top5.map((t) => ({
          title: t.title,
          refs: t.refIds.map((id) => labels.get(id) ?? id.slice(0, 8))
        }))
      };
    }
  }

  if (!activeObjectives.length && !topFive) return null;
  return {
    quarter: periods.quarter,
    month: periods.month,
    week: periods.week,
    topFive,
    objectives: activeObjectives.map((o) => ({
      id: o.id,
      key: o.key,
      title: o.title,
      status: o.status,
      tier: o.tier,
      tierRank: o.tierRank,
      project: o.project ? { key: o.project.key, name: o.project.name } : null,
      keyResults: projectId
        ? o.keyResults
            .filter((kr) => kr.month === periods.month)
            .map((kr) => ({
              id: kr.id,
              key: kr.key,
              title: kr.title,
              status: kr.status,
              month: kr.month,
              dueAt: kr.dueAt,
              score: kr.score
            }))
        : []
    }))
  };
}
