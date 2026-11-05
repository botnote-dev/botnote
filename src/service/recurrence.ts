import { and, asc, desc, eq, lte, or } from "drizzle-orm";
import rrulePkg from "rrule";
import type { Database, Executor } from "../db/client.js";
import {
  entities,
  recurrenceExceptions,
  recurrenceRules,
  type Entity,
  type RecurrenceRule
} from "../db/schema.js";
import { allDayDueAtInZone, normalizeDueAt } from "./dates.js";
import type { Scope } from "./scope.js";
import type {
  RecurrenceInput,
  SplitRecurrenceInput,
  StopRecurrenceInput,
  UpdateRecurrenceInput
} from "./types.js";
import { getWorkspaceSettings } from "./workspace_settings.js";

// Content fields that can be scoped to "this occurrence only"
type BaselineFields = { title?: string | null; body?: string; tags?: string[]; priority?: string };
export type ContentFieldKey = "title" | "body" | "tags" | "priority";

const { RRule } = rrulePkg;

type WeekdayKey = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
type Frequency = NonNullable<RecurrenceInput["preset"]>;

const WEEKDAYS: Record<WeekdayKey, typeof RRule.MO> = {
  MO: RRule.MO,
  TU: RRule.TU,
  WE: RRule.WE,
  TH: RRule.TH,
  FR: RRule.FR,
  SA: RRule.SA,
  SU: RRule.SU
};

const FREQUENCIES: Record<Frequency, number> = {
  hourly: RRule.HOURLY,
  daily: RRule.DAILY,
  weekly: RRule.WEEKLY,
  monthly: RRule.MONTHLY,
  yearly: RRule.YEARLY
};

interface RecurrenceMarker {
  ruleId: string;
  seriesId: string;
  role: "occurrence";
  occurrenceAt: string;
  occurrenceIndex: number;
}

interface RecurrenceMetadata {
  recurrence?: Partial<RecurrenceMarker>;
}

export interface RecurrenceDetails {
  rule: RecurrenceRule;
  currentOccurrence: Entity | null;
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

export function recurrenceMarker(e: Entity): Partial<RecurrenceMarker> | null {
  const metadata = metadataObject(e.metadata) as RecurrenceMetadata;
  if (!metadata.recurrence || typeof metadata.recurrence !== "object") return null;
  return metadata.recurrence;
}

function withRecurrenceMetadata(
  e: Entity,
  marker: RecurrenceMarker
): Record<string, unknown> {
  return {
    ...metadataObject(e.metadata),
    recurrence: marker
  };
}

function normalizeRRuleText(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rruleLine = lines.find((line) => line.toUpperCase().startsWith("RRULE:")) ?? lines[0];
  if (!rruleLine) throw new Error("recurrence rule is empty");
  return rruleLine.replace(/^RRULE:/i, "");
}

function rruleLine(rule: InstanceType<typeof RRule>): string {
  const line = rule
    .toString()
    .split(/\r?\n/)
    .find((part) => part.startsWith("RRULE:"));
  if (!line) throw new Error("rrule did not produce an RRULE line");
  return line.slice("RRULE:".length);
}

/** The RRULE-shaping subset shared by RecurrenceInput and SplitRecurrenceInput. */
type RRuleFieldsInput = Pick<
  RecurrenceInput,
  "rrule" | "preset" | "interval" | "byWeekday" | "byMonthDay" | "bySetPos" | "byMonth" | "until" | "count"
>;

function buildRRuleFromInput(input: RRuleFieldsInput, dtstart: Date): string {
  if (input.rrule) return normalizeRRuleText(input.rrule);
  if (!input.preset) throw new Error("recurrence preset is required");

  const options: ConstructorParameters<typeof RRule>[0] = {
    freq: FREQUENCIES[input.preset],
    interval: input.interval,
    dtstart
  };
  if (input.byWeekday?.length) {
    options.byweekday = input.byWeekday.map((day) => WEEKDAYS[day]);
  }
  if (input.byMonthDay?.length) options.bymonthday = input.byMonthDay;
  if (input.bySetPos != null) options.bysetpos = input.bySetPos;
  if (input.byMonth?.length) options.bymonth = input.byMonth;
  if (input.until) options.until = input.until;
  if (input.count) options.count = input.count;

  return rruleLine(new RRule(options));
}

export function buildRRule(rule: Pick<RecurrenceRule, "rrule" | "dtstart">, dtstart = rule.dtstart) {
  const parsed = RRule.parseString(rule.rrule);
  return new RRule({ ...parsed, dtstart });
}

/**
 * Bound an existing RRULE with UNTIL at the fork point (used when freezing the
 * old rule during a split). UNTIL supersedes any COUNT the rule carried.
 */
function applyUntilToRrule(rruleText: string, dtstart: Date, until: Date): string {
  const parsed = RRule.parseString(rruleText);
  delete parsed.count;
  parsed.until = until;
  return rruleLine(new RRule({ ...parsed, dtstart }));
}

function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * Normalize a computed occurrence date for storage.
 * - All-day rules: resolve the calendar day as seen in the rule's timezone,
 *   then snap to noon UTC (so the intended local calendar day is preserved
 *   across all UTC-offset clients).
 * - Timed rules: use normalizeDueAt (exact-midnight-UTC -> noon-UTC heuristic).
 */
export function normalizeOccurrenceDueAt(
  rule: Pick<RecurrenceRule, "allDay" | "timezone">,
  date: Date
): Date {
  if (rule.allDay) {
    return allDayDueAtInZone(date, rule.timezone) ?? normalizeDueAt(date) ?? date;
  }
  return normalizeDueAt(date) ?? date;
}

function countLimit(rule: RecurrenceRule): number | null {
  return buildRRule(rule).options.count ?? null;
}

function computeNextOccurrenceAt(
  rule: RecurrenceRule,
  occurrence: Entity,
  completedAt: Date
): Date | null {
  const count = countLimit(rule);
  if (count != null && rule.generatedCount >= count) return null;

  const anchor = rule.anchor === "completion" ? "completion" : "scheduled";
  const dtstart = anchor === "completion" ? completedAt : rule.dtstart;
  const rrule = buildRRule(rule, dtstart);
  const scheduledBase = occurrence.dueAt ?? rule.dtstart;
  const cursor = anchor === "completion" ? completedAt : maxDate(scheduledBase, completedAt);
  return nextNormalizedAfter(rule, rrule, cursor, scheduledBase);
}

function computeNextScheduledAfter(rule: RecurrenceRule, after: Date): Date | null {
  return nextNormalizedAfter(rule, buildRRule(rule, rule.dtstart), after, after);
}

const MAX_SAME_DAY_SKIPS = 1000;

/**
 * First occurrence after `cursor` whose normalized due date is strictly later
 * than `floor`. All-day normalization snaps to noon UTC, so a raw hit later on
 * the floor's own day (dtstart 13:00Z, due 12:00Z) maps back onto the floor;
 * returning it would re-issue the same occurrence forever.
 */
function nextNormalizedAfter(
  rule: RecurrenceRule,
  rrule: ReturnType<typeof buildRRule>,
  cursor: Date,
  floor: Date
): Date | null {
  let raw = rrule.after(cursor, false);
  for (let i = 0; raw && i < MAX_SAME_DAY_SKIPS; i++) {
    const due = normalizeOccurrenceDueAt(rule, raw);
    if (due.getTime() > floor.getTime()) return due;
    raw = rrule.after(raw, false);
  }
  return null;
}

/** Internal fetch by id for rows already known to belong to a rule's workspace. */
async function fetchEntity(db: Executor, id: string): Promise<Entity> {
  const rows = await db.select().from(entities).where(eq(entities.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`entity ${id} not found`);
  return row;
}

/** Entry-point fetch: the caller's scope decides whether the id is visible at all. */
function clientError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

async function fetchEntityInScope(scope: Scope, db: Database["db"], id: string): Promise<Entity> {
  const rows = await db
    .select()
    .from(entities)
    .where(and(eq(entities.id, id), eq(entities.workspaceId, scope.workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw clientError(`entity ${id} not found`, 404);
  return row;
}

function ruleInScope(scope: Scope, ruleId: string) {
  return and(eq(recurrenceRules.id, ruleId), eq(recurrenceRules.workspaceId, scope.workspaceId));
}

export async function findRuleForTask(
  db: Database["db"],
  task: Entity,
  includeDisabled = true
): Promise<RecurrenceRule | null> {
  const marker = recurrenceMarker(task);
  const cond = marker?.ruleId
    ? eq(recurrenceRules.id, marker.ruleId)
    : or(eq(recurrenceRules.currentOccurrenceId, task.id), eq(recurrenceRules.seriesId, task.id))!;
  const where = includeDisabled ? cond : and(cond, eq(recurrenceRules.enabled, true));
  // A split leaves multiple rules per series (disabled history + one active),
  // so the seriesId/currentOccurrenceId fallback can match more than one. Prefer
  // the active rule, then the most recent. (The marker.ruleId branch is exact.)
  const rows = await db
    .select()
    .from(recurrenceRules)
    .where(where)
    .orderBy(desc(recurrenceRules.enabled), desc(recurrenceRules.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getRecurrenceForTask(
  scope: Scope,
  db: Database["db"],
  taskId: string
): Promise<RecurrenceDetails | null> {
  const task = await fetchEntityInScope(scope, db, taskId);
  const rule = await findRuleForTask(db, task);
  if (!rule) return null;
  const currentOccurrence = rule.currentOccurrenceId
    ? await fetchEntity(db, rule.currentOccurrenceId).catch(() => null)
    : null;
  return { rule, currentOccurrence };
}

export async function createRecurrenceRule(
  scope: Scope,
  db: Database["db"],
  taskId: string,
  input: RecurrenceInput
): Promise<RecurrenceRule> {
  const task = await fetchEntityInScope(scope, db, taskId);
  if (task.kind !== "task") throw clientError("recurrence can only be attached to tasks", 400);
  if (task.status === "done" || task.status === "rejected") {
    throw clientError("recurrence cannot be attached to a terminal task", 400);
  }
  // The series needs a first occurrence date: the task's dueAt, or an explicit
  // dtstart which then also becomes the seed task's dueAt.
  const dtstart = input.dtstart ? normalizeDueAt(input.dtstart)! : task.dueAt;
  if (!dtstart) {
    throw clientError(
      "task has no due date: set dueAt on the task or pass dtstart for the first occurrence",
      400
    );
  }

  // Resolve timezone: explicit input wins; otherwise fall back to workspace tz.
  const timezone = input.timezone ?? (await getWorkspaceSettings(scope, db)).timezone;

  const existingRule = await findRuleForTask(db, task);
  const seriesId = existingRule?.seriesId ?? recurrenceMarker(task)?.seriesId ?? task.id;
  const rrule = buildRRuleFromInput(input, dtstart);
  const nextOccurrenceRaw = buildRRule({ rrule, dtstart }).after(dtstart, false);

  // Build a partial rule shape for normalizeOccurrenceDueAt before the DB row exists.
  const ruleShape = { allDay: input.allDay ?? true, timezone };
  const nextOccurrenceAt = nextOccurrenceRaw
    ? normalizeOccurrenceDueAt(ruleShape, nextOccurrenceRaw)
    : null;

  let rule: RecurrenceRule;
  if (existingRule) {
    const [updated] = await db
      .update(recurrenceRules)
      .set({
        currentOccurrenceId: task.id,
        enabled: true,
        rrule,
        dtstart,
        timezone,
        allDay: input.allDay,
        anchor: input.anchor,
        maxInstancesAhead: 1,
        nextOccurrenceAt,
        endedAt: null
      })
      .where(eq(recurrenceRules.id, existingRule.id))
      .returning();
    if (!updated) throw new Error(`recurrence rule ${existingRule.id} not found`);
    rule = updated;
  } else {
    const [inserted] = await db
      .insert(recurrenceRules)
      .values({
        workspaceId: scope.workspaceId,
        seriesId,
        currentOccurrenceId: task.id,
        enabled: true,
        rrule,
        dtstart,
        timezone,
        allDay: input.allDay,
        anchor: input.anchor,
        maxInstancesAhead: 1,
        generatedCount: 1,
        lastOccurrenceAt: null,
        nextOccurrenceAt,
        endedAt: null
      })
      .returning();
    if (!inserted) throw new Error("recurrence rule insert returned no row");
    rule = inserted;
  }

  await db
    .update(entities)
    .set({
      ...(task.dueAt ? {} : { dueAt: dtstart }),
      metadata: withRecurrenceMetadata(task, {
        ruleId: rule.id,
        seriesId: rule.seriesId,
        role: "occurrence",
        occurrenceAt: (task.dueAt ?? rule.dtstart).toISOString(),
        occurrenceIndex: 1
      })
    })
    .where(eq(entities.id, task.id));

  return rule;
}

export async function updateRecurrenceRule(
  scope: Scope,
  db: Database["db"],
  ruleId: string,
  input: UpdateRecurrenceInput
): Promise<RecurrenceRule> {
  const rows = await db.select().from(recurrenceRules).where(ruleInScope(scope, ruleId)).limit(1);
  const current = rows[0];
  if (!current) throw new Error(`recurrence rule ${ruleId} not found`);
  const currentOccurrence = current.currentOccurrenceId
    ? await fetchEntity(db, current.currentOccurrenceId)
    : null;
  const dtstart = input.dtstart
    ? normalizeDueAt(input.dtstart)!
    : currentOccurrence?.dueAt ?? current.dtstart;
  const nextRRuleInput: RecurrenceInput = {
    rrule: input.rrule ?? current.rrule,
    preset: input.preset,
    interval: input.interval ?? 1,
    byWeekday: input.byWeekday,
    byMonthDay: input.byMonthDay,
    bySetPos: input.bySetPos,
    byMonth: input.byMonth,
    until: input.until,
    count: input.count,
    dtstart,
    timezone: input.timezone ?? current.timezone,
    allDay: input.allDay ?? current.allDay,
    anchor: input.anchor ?? (current.anchor === "completion" ? "completion" : "scheduled")
  };
  const rrule = input.rrule || input.preset ? buildRRuleFromInput(nextRRuleInput, dtstart) : current.rrule;
  const nextOccurrenceRaw = buildRRule({ rrule, dtstart }).after(dtstart, false);
  const resolvedAllDay = input.allDay ?? current.allDay;
  const resolvedTimezone = input.timezone ?? current.timezone;
  const ruleShape = { allDay: resolvedAllDay, timezone: resolvedTimezone };
  const nextOccurrenceAt = nextOccurrenceRaw
    ? normalizeOccurrenceDueAt(ruleShape, nextOccurrenceRaw)
    : null;

  const [updated] = await db
    .update(recurrenceRules)
    .set({
      enabled: input.enabled ?? current.enabled,
      rrule,
      dtstart,
      timezone: resolvedTimezone,
      allDay: resolvedAllDay,
      anchor: input.anchor ?? current.anchor,
      nextOccurrenceAt,
      endedAt: input.enabled === true ? null : current.endedAt
    })
    .where(eq(recurrenceRules.id, ruleId))
    .returning();
  if (!updated) throw new Error(`recurrence rule ${ruleId} not found`);
  return updated;
}

// ---------------------------------------------------------------------------
// Modified-exception helpers (scope='this' baseline management)
// ---------------------------------------------------------------------------

/**
 * Find the existing 'modified' exception row for a given entity.
 * Keyed by entityId (stable), not occurrenceAt.
 */
async function findModifiedExceptionForEntity(
  db: Executor,
  entityId: string
): Promise<{ id: string; metadata: Record<string, unknown> } | null> {
  const rows = await db
    .select({ id: recurrenceExceptions.id, metadata: recurrenceExceptions.metadata })
    .from(recurrenceExceptions)
    .where(
      and(
        eq(recurrenceExceptions.entityId, entityId),
        eq(recurrenceExceptions.action, "modified")
      )
    )
    .limit(1);
  if (!rows[0]) return null;
  const meta = rows[0].metadata;
  return {
    id: rows[0].id,
    metadata: (meta && typeof meta === "object" && !Array.isArray(meta))
      ? (meta as Record<string, unknown>)
      : {}
  };
}

/**
 * Upsert a 'modified' exception row recording the pre-edit (baseline) values
 * of content fields for this occurrence. Uses earliest-wins merge: only
 * adds a field to baseline if not already present.
 */
export async function upsertModifiedExceptionBaseline(
  db: Database["db"],
  rule: RecurrenceRule,
  occurrence: Entity,
  preEditValues: BaselineFields,
  changedFields: ContentFieldKey[]
): Promise<void> {
  const existing = await findModifiedExceptionForEntity(db, occurrence.id);

  if (existing) {
    const existingMeta = existing.metadata;
    const existingBaseline = (
      existingMeta.baseline && typeof existingMeta.baseline === "object" && !Array.isArray(existingMeta.baseline)
        ? existingMeta.baseline
        : {}
    ) as Record<string, unknown>;
    const existingChangedFields = Array.isArray(existingMeta.changedFields)
      ? (existingMeta.changedFields as string[])
      : [];

    // Merge: only add fields not already in baseline (earliest value wins)
    const mergedBaseline: Record<string, unknown> = { ...existingBaseline };
    const mergedChangedFields = new Set<string>(existingChangedFields);
    for (const field of changedFields) {
      if (!(field in mergedBaseline)) {
        mergedBaseline[field] = (preEditValues as Record<string, unknown>)[field] ?? null;
      }
      mergedChangedFields.add(field);
    }

    await db
      .update(recurrenceExceptions)
      .set({
        metadata: {
          scope: "this",
          baseline: mergedBaseline,
          changedFields: Array.from(mergedChangedFields),
          actorKind: "human"
        }
      })
      .where(eq(recurrenceExceptions.id, existing.id));
  } else {
    const baseline: Record<string, unknown> = {};
    for (const field of changedFields) {
      baseline[field] = (preEditValues as Record<string, unknown>)[field] ?? null;
    }
    await db.insert(recurrenceExceptions).values({
      ruleId: rule.id,
      occurrenceAt: occurrence.dueAt ?? rule.dtstart,
      action: "modified",
      entityId: occurrence.id,
      metadata: {
        scope: "this",
        baseline,
        changedFields,
        actorKind: "human"
      }
    });
  }
}

/**
 * Remove the given fields from an existing 'modified' exception's baseline.
 * If baseline becomes empty after removal, delete the row.
 */
export async function clearModifiedExceptionFields(
  db: Database["db"],
  _rule: RecurrenceRule,
  occurrence: Entity,
  changedFields: ContentFieldKey[]
): Promise<void> {
  const existing = await findModifiedExceptionForEntity(db, occurrence.id);
  if (!existing) return;

  const existingMeta = existing.metadata;
  const existingBaseline = (
    existingMeta.baseline && typeof existingMeta.baseline === "object" && !Array.isArray(existingMeta.baseline)
      ? existingMeta.baseline
      : {}
  ) as Record<string, unknown>;
  const existingChangedFields = Array.isArray(existingMeta.changedFields)
    ? (existingMeta.changedFields as string[])
    : [];

  const newBaseline: Record<string, unknown> = { ...existingBaseline };
  const newChangedFields = existingChangedFields.filter((f) => !changedFields.includes(f as ContentFieldKey));
  for (const field of changedFields) {
    delete newBaseline[field];
  }

  if (Object.keys(newBaseline).length === 0) {
    await db.delete(recurrenceExceptions).where(eq(recurrenceExceptions.id, existing.id));
  } else {
    await db
      .update(recurrenceExceptions)
      .set({
        metadata: {
          ...existingMeta,
          baseline: newBaseline,
          changedFields: newChangedFields
        }
      })
      .where(eq(recurrenceExceptions.id, existing.id));
  }
}

/**
 * Fetch the baseline stored in the 'modified' exception for the given template
 * occurrence. Returns null if no such exception exists.
 */
async function fetchBaselineForTemplate(
  db: Executor,
  _rule: RecurrenceRule,
  template: Entity
): Promise<BaselineFields | null> {
  const existing = await findModifiedExceptionForEntity(db, template.id);
  if (!existing) return null;
  const meta = existing.metadata;
  if (!meta.baseline || typeof meta.baseline !== "object" || Array.isArray(meta.baseline)) {
    return null;
  }
  return meta.baseline as BaselineFields;
}

async function insertNextOccurrence(
  db: Executor,
  rule: RecurrenceRule,
  occurrence: Entity,
  nextDueAt: Date,
  baseline?: BaselineFields
): Promise<Entity> {
  const occurrenceIndex = rule.generatedCount + 1;
  const idempotencyKey = `recurrence:${rule.id}:${nextDueAt.toISOString()}`;
  const metadata = {
    ...metadataObject(occurrence.metadata),
    recurrence: {
      ruleId: rule.id,
      seriesId: rule.seriesId,
      role: "occurrence",
      occurrenceAt: nextDueAt.toISOString(),
      occurrenceIndex
    } satisfies RecurrenceMarker
  };

  const values = {
    workspaceId: rule.workspaceId,
    kind: "task",
    projectId: occurrence.projectId,
    title: baseline && "title" in baseline ? baseline.title : occurrence.title,
    body: baseline && "body" in baseline ? (baseline.body ?? "") : occurrence.body,
    tags: baseline && "tags" in baseline ? (baseline.tags ?? []) : occurrence.tags,
    status: "open",
    parentId: occurrence.parentId,
    actorKind: "system",
    metadata,
    dueAt: nextDueAt,
    priority: (baseline && "priority" in baseline ? baseline.priority : null) ?? occurrence.priority,
    pinned: false,
    completedAt: null,
    idempotencyKey
  };
  const findExisting = async () =>
    (
      await db
        .select()
        .from(entities)
        .where(
          and(eq(entities.idempotencyKey, idempotencyKey), eq(entities.workspaceId, rule.workspaceId))
        )
        .limit(1)
    )[0];
  // The sequence trigger runs before ON CONFLICT drops the row, so every
  // conflicting insert would burn a KEY-SEQ number. Look first.
  const before = await findExisting();
  if (before) return before;
  const inserted = await db
    .insert(entities)
    .values(values)
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];
  const existing = await findExisting();
  if (!existing) throw new Error("recurrence idempotent insert returned no row");
  return existing;
}

async function advanceRuleFromOccurrence(
  db: Database["db"],
  rule: RecurrenceRule,
  occurrence: Entity,
  completedAt: Date
): Promise<Entity | null> {
  if (!rule.enabled) return null;
  const nextDueAt = computeNextOccurrenceAt(rule, occurrence, completedAt);
  if (!nextDueAt) {
    await db
      .update(recurrenceRules)
      .set({
        enabled: false,
        currentOccurrenceId: null,
        lastOccurrenceAt: occurrence.dueAt ?? rule.dtstart,
        nextOccurrenceAt: null,
        endedAt: completedAt
      })
      .where(eq(recurrenceRules.id, rule.id));
    return null;
  }

  const baseline = await fetchBaselineForTemplate(db, rule, occurrence);
  const next = await insertNextOccurrence(db, rule, occurrence, nextDueAt, baseline ?? undefined);
  await db
    .update(recurrenceRules)
    .set({
      currentOccurrenceId: next.id,
      generatedCount: Math.max(rule.generatedCount + 1, rule.generatedCount),
      lastOccurrenceAt: occurrence.dueAt ?? rule.dtstart,
      nextOccurrenceAt: nextDueAt
    })
    .where(eq(recurrenceRules.id, rule.id));
  return next;
}

/**
 * Create the occurrences every scheduled-anchor rule owes up to `upTo`.
 *
 * Each rule is processed in its own transaction under SELECT ... FOR UPDATE
 * SKIP LOCKED: a concurrent pass (another daemon instance, or the startup
 * pass overlapping the interval timer) skips rules already being advanced
 * instead of waiting and then re-generating the same occurrences with a
 * double-bumped generated_count.
 */
export async function materializeScheduledRecurrences(
  db: Database["db"],
  upTo: Date,
  limit = 100
): Promise<Entity[]> {
  const due = () =>
    and(
      eq(recurrenceRules.enabled, true),
      eq(recurrenceRules.anchor, "scheduled"),
      lte(recurrenceRules.nextOccurrenceAt, upTo)
    );
  const candidates = await db
    .select({ id: recurrenceRules.id })
    .from(recurrenceRules)
    .where(due())
    .orderBy(asc(recurrenceRules.nextOccurrenceAt))
    .limit(limit);

  const created: Entity[] = [];
  for (const { id } of candidates) {
    if (created.length >= limit) break;
    const budget = limit - created.length;
    const batch = await db.transaction(async (tx) => {
      const [rule] = await tx
        .select()
        .from(recurrenceRules)
        .where(and(eq(recurrenceRules.id, id), due()))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!rule) return [];
      return materializeRule(tx, rule, upTo, budget);
    });
    created.push(...batch);
  }

  return created;
}

async function materializeRule(
  db: Executor,
  originalRule: RecurrenceRule,
  upTo: Date,
  limit: number
): Promise<Entity[]> {
  const created: Entity[] = [];
  let rule = originalRule;
  let template = await fetchEntity(db, rule.currentOccurrenceId ?? rule.seriesId).catch(() =>
    fetchEntity(db, rule.seriesId)
  );

  while (
    rule.enabled &&
    rule.nextOccurrenceAt &&
    rule.nextOccurrenceAt.getTime() <= upTo.getTime() &&
    created.length < limit
  ) {
    const count = countLimit(rule);
    if (count != null && rule.generatedCount >= count) {
      await db
        .update(recurrenceRules)
        .set({ nextOccurrenceAt: null })
        .where(eq(recurrenceRules.id, rule.id));
      break;
    }

    const nextDueAt = normalizeOccurrenceDueAt(rule, rule.nextOccurrenceAt!);
    const baseline = await fetchBaselineForTemplate(db, rule, template);
    const next = await insertNextOccurrence(db, rule, template, nextDueAt, baseline ?? undefined);
    created.push(next);

    const generatedCount = rule.generatedCount + 1;
    const following =
      count != null && generatedCount >= count ? null : computeNextScheduledAfter(rule, nextDueAt);
    const [updated] = await db
      .update(recurrenceRules)
      .set({
        currentOccurrenceId: next.id,
        generatedCount,
        lastOccurrenceAt: template.dueAt ?? rule.dtstart,
        nextOccurrenceAt: following
      })
      .where(eq(recurrenceRules.id, rule.id))
      .returning();
    if (!updated) break;
    rule = updated;
    template = next;
  }

  return created;
}

export async function advanceRecurrenceOnCompletion(
  db: Database["db"],
  occurrence: Entity,
  completedAt = occurrence.completedAt ?? new Date()
): Promise<Entity | null> {
  if (occurrence.kind !== "task") return null;
  const rule = await findRuleForTask(db, occurrence, false);
  if (!rule) return null;
  if (rule.currentOccurrenceId && rule.currentOccurrenceId !== occurrence.id) return null;
  return advanceRuleFromOccurrence(db, rule, occurrence, completedAt);
}

export async function skipOccurrence(
  scope: Scope,
  db: Database["db"],
  taskId: string,
  input: { reason?: string; actorKind?: string } = {}
): Promise<{ skipped: Entity; next: Entity | null; rule: RecurrenceRule }> {
  const task = await fetchEntityInScope(scope, db, taskId);
  if (task.kind !== "task") throw new Error("only tasks can be skipped");
  const rule = await findRuleForTask(db, task, false);
  if (!rule) throw new Error("task is not an active recurring occurrence");
  if (rule.currentOccurrenceId && rule.currentOccurrenceId !== task.id) {
    throw new Error("only the current recurring occurrence can be skipped");
  }

  await db.insert(recurrenceExceptions).values({
    ruleId: rule.id,
    occurrenceAt: task.dueAt ?? rule.dtstart,
    action: "skipped",
    entityId: task.id,
    metadata: { reason: input.reason ?? null, actorKind: input.actorKind ?? "human" }
  });

  const [skipped] = await db
    .update(entities)
    .set({
      status: "rejected",
      updatedAt: new Date(),
      metadata: {
        ...metadataObject(task.metadata),
        recurrence: recurrenceMarker(task),
        skippedAt: new Date().toISOString(),
        skipReason: input.reason ?? null
      }
    })
    .where(eq(entities.id, task.id))
    .returning();
  if (!skipped) throw new Error(`entity ${task.id} not found`);

  const next = await advanceRuleFromOccurrence(db, rule, skipped, new Date());
  return { skipped, next, rule };
}

export async function stopRecurrence(
  scope: Scope,
  db: Database["db"],
  ruleId: string,
  _input: StopRecurrenceInput = {}
): Promise<RecurrenceRule> {
  const [updated] = await db
    .update(recurrenceRules)
    .set({
      enabled: false,
      nextOccurrenceAt: null,
      endedAt: new Date()
    })
    .where(ruleInScope(scope, ruleId))
    .returning();
  if (!updated) throw new Error(`recurrence rule ${ruleId} not found`);
  return updated;
}

/**
 * Fork a recurrence series at its current occurrence: freeze the old rule and
 * apply a new cadence going forward, keeping the same series so the UI still
 * shows one continuous timeline (history + future).
 *
 * Mechanics:
 *  - The old rule is bounded with UNTIL at the fork point and disabled. It stays
 *    as frozen history (its already-materialized occurrences are untouched).
 *  - A new enabled rule is created sharing the SAME series_id (UI continuity)
 *    with the new RRULE. The live occurrence is kept as its template/display
 *    source.
 *  - The new rule has a distinct id, so its occurrences live in a disjoint
 *    idempotency-key space (`recurrence:<ruleId>:<dueAt>`): no duplicate or
 *    orphan occurrence can appear at the fork even if a date coincides.
 *  - Scheduled forks let the materializer grow the new rule from the first
 *    occurrence after the fork; the live occurrence stays on the old rule as the
 *    tail of history. Completion forks re-home the live occurrence onto the new
 *    rule so completing it advances the new cadence.
 *
 * The whole operation runs in one transaction: the old rule is disabled before
 * the new one is inserted, so the partial-unique "one enabled rule per series"
 * index holds at every step.
 */
export async function splitRecurrence(
  scope: Scope,
  db: Database["db"],
  ruleId: string,
  input: SplitRecurrenceInput
): Promise<RecurrenceRule> {
  return db.transaction(async (tx) => {
    const ruleRows = await tx
      .select()
      .from(recurrenceRules)
      .where(ruleInScope(scope, ruleId))
      .limit(1);
    const oldRule = ruleRows[0];
    if (!oldRule) throw new Error(`recurrence rule ${ruleId} not found`);
    if (!oldRule.enabled) throw new Error("only an active recurrence can be split");
    if (!oldRule.currentOccurrenceId) {
      throw new Error("recurrence has no current occurrence to fork from");
    }

    const occRows = await tx
      .select()
      .from(entities)
      .where(eq(entities.id, oldRule.currentOccurrenceId))
      .limit(1);
    const current = occRows[0];
    if (!current) throw new Error("recurrence has no current occurrence to fork from");

    const forkAfter = current.dueAt ?? oldRule.dtstart;
    const allDay = input.allDay ?? oldRule.allDay;
    const timezone = input.timezone ?? oldRule.timezone;
    const anchor: "scheduled" | "completion" =
      input.anchor ?? (oldRule.anchor === "completion" ? "completion" : "scheduled");
    const ruleShape = { allDay, timezone };

    // The forward cadence.
    const newRrule = buildRRuleFromInput(input, forkAfter);

    // Resolve the new rule's anchoring before mutating anything, so a bounded
    // new rule with no occurrences after the fork fails cleanly (no half-split).
    let dtstart: Date;
    let nextOccurrenceAt: Date | null;
    let generatedCount: number;
    if (anchor === "completion") {
      // Completion series advance on completion, not on a schedule; the re-homed
      // live occurrence (below) carries the chain.
      dtstart = forkAfter;
      nextOccurrenceAt = null;
      generatedCount = oldRule.generatedCount;
    } else {
      const firstRaw = buildRRule({ rrule: newRrule, dtstart: forkAfter }).after(forkAfter, false);
      if (!firstRaw) {
        throw new Error("new recurrence has no occurrences after the fork point");
      }
      dtstart = normalizeOccurrenceDueAt(ruleShape, firstRaw);
      nextOccurrenceAt = dtstart;
      // The new rule has generated nothing yet — the scheduler materializes its
      // first occurrence (index 1) at dtstart. Starting at 0 keeps COUNT on the
      // new rule consistent with rrule expansion. UI continuity comes from the
      // shared series_id, not from this counter.
      generatedCount = 0;
    }

    // 1) Freeze the old rule. Must run before the insert so the partial-unique
    //    (one enabled rule per series) index is satisfied at every step.
    await tx
      .update(recurrenceRules)
      .set({
        enabled: false,
        rrule: applyUntilToRrule(oldRule.rrule, oldRule.dtstart, forkAfter),
        currentOccurrenceId: anchor === "completion" ? null : oldRule.currentOccurrenceId,
        lastOccurrenceAt: current.dueAt ?? oldRule.dtstart,
        nextOccurrenceAt: null,
        endedAt: new Date()
      })
      .where(eq(recurrenceRules.id, oldRule.id));

    // 2) Insert the new enabled rule, same series_id.
    const [created] = await tx
      .insert(recurrenceRules)
      .values({
        workspaceId: oldRule.workspaceId,
        seriesId: oldRule.seriesId,
        currentOccurrenceId: current.id,
        enabled: true,
        rrule: newRrule,
        dtstart,
        timezone,
        allDay,
        anchor,
        maxInstancesAhead: 1,
        generatedCount,
        lastOccurrenceAt: anchor === "completion" ? oldRule.lastOccurrenceAt : null,
        nextOccurrenceAt,
        endedAt: null
      })
      .returning();
    if (!created) throw new Error("recurrence rule insert returned no row");

    // 3) Completion fork: re-home the live occurrence onto the new rule so its
    //    completion advances the new cadence (findRuleForTask routes by the
    //    marker's ruleId). Scheduled forks leave it on the old rule as history.
    if (anchor === "completion") {
      const marker = recurrenceMarker(current);
      await tx
        .update(entities)
        .set({
          metadata: withRecurrenceMetadata(current, {
            ruleId: created.id,
            seriesId: created.seriesId,
            role: "occurrence",
            occurrenceAt: marker?.occurrenceAt ?? (current.dueAt ?? created.dtstart).toISOString(),
            occurrenceIndex: marker?.occurrenceIndex ?? created.generatedCount
          })
        })
        .where(eq(entities.id, current.id));
    }

    return created;
  });
}
