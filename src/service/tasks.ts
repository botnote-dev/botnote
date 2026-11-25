import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL
} from "drizzle-orm";
import type { Database } from "../db/client.js";
import { entities, recurrenceExceptions, recurrenceRules, type Entity } from "../db/schema.js";
import { blockersFor, type WithBlockers } from "./blockers.js";
import { hierarchyFor, type WithHierarchy } from "./hierarchy.js";
import { buildRRule, normalizeOccurrenceDueAt } from "./recurrence.js";
import { resolveAssignee } from "./members.js";
import { entityInScope, type Scope } from "./scope.js";
import type { TasksRangeInput } from "./types.js";

export interface VirtualOccurrence {
  virtual: true;
  id: string;
  ruleId: string;
  seriesId: string;
  occurrenceAt: string;
  dueAt: string;
  title: string | null;
  projectId: string | null;
  priority: string;
  allDay: boolean;
  timezone: string;
  rrule: string;
}

export type ListedTask = WithHierarchy<WithBlockers<Entity>>;

export interface TasksRangeResult {
  scheduled: ListedTask[];
  overdue: ListedTask[];
  backlog: ListedTask[];
  virtualOccurrences: VirtualOccurrence[];
}

/**
 * Tasks in a date range, split into scheduled / overdue / backlog buckets.
 * Pure read: recurring occurrences are materialized by the daemon scheduler
 * (startup pass + interval), never from this path, so concurrent polls from
 * several UI tabs and agents cannot race on rule advancement.
 *
 * Each task has a "display date" that decides where it lands on the calendar:
 *   - status='done'         → completedAt (when actually finished)
 *   - status='in_progress'  → today        (rolling — surfaces active work)
 *   - everything else       → dueAt        (when it's supposed to happen)
 *
 * `scheduled` returns any task whose display date falls inside [from, to).
 * Done tasks without a completedAt (legacy / weird state) fall back to updatedAt.
 * `overdue` is every unfinished task (open or in_progress) due before the
 * requested range start, or before now when no range start is supplied.
 *
 * The buckets are disjoint: a task lands in exactly one of overdue, scheduled
 * or backlog. Overdue wins over scheduled, and undated in_progress work sits
 * in backlog when backlog is requested, otherwise on today.
 */
async function assigneeFilter(
  scope: Scope,
  db: Database["db"],
  ref: string | null
): Promise<SQL | null> {
  if (!ref || !scope.userId) return null;
  if (ref === "mine") {
    return or(eq(entities.assigneeUserId, scope.userId), isNull(entities.assigneeUserId))!;
  }
  const userId = await resolveAssignee(scope, db, ref);
  return userId ? eq(entities.assigneeUserId, userId) : isNull(entities.assigneeUserId);
}

export async function tasksRange(
  scope: Scope,
  db: Database["db"],
  input: TasksRangeInput
): Promise<TasksRangeResult> {
  const now = new Date();

  // The assignee is part of the base scope, not of one pass: every bucket
  // (scheduled, done, in progress, overdue, backlog, recurring previews) must
  // answer for the same people.
  const assignee = await assigneeFilter(scope, db, input.assignee ?? null);
  const inWorkspace = assignee ? and(entityInScope(scope), assignee)! : entityInScope(scope);
  const projectFilter = input.projectIds?.length
    ? inArray(entities.projectId, input.projectIds)
    : undefined;
  const activeProjectFilter = projectFilter
    ? undefined
    : sql`(${entities.projectId} IS NULL OR ${entities.projectId} IN (
        SELECT id FROM projects
        WHERE status <> 'archived' AND workspace_id = ${scope.workspaceId}::uuid
      ))`;

  const notStatus = (status: string): SQL =>
    or(ne(entities.status, status), isNull(entities.status))!;

  // Base filter applied to every bucket: only tasks, optional project filter,
  // and the includeDone toggle. Rejected/archived work is excluded everywhere:
  // includeDone means "show completion history", not "show abandoned work",
  // and a cancelled task with a leftover dueAt is not scheduled for anything.
  const baseConds: SQL[] = [
    inWorkspace,
    eq(entities.kind, "task"),
    isNull(entities.deletedAt),
    notStatus("rejected"),
    notStatus("archived")
  ];
  if (!input.includeDone) {
    baseConds.push(notStatus("done"));
  }
  if (projectFilter) baseConds.push(projectFilter);
  if (activeProjectFilter) baseConds.push(activeProjectFilter);

  // Three independent passes, unioned in JS. Drizzle's `or` keeps the SQL
  // clear and the partial completed_at index keeps the done-pass cheap.
  const inRange = <T>(col: T): SQL[] => {
    const conds: SQL[] = [];
    if (input.from) conds.push(gte(col as never, input.from));
    if (input.to) conds.push(lt(col as never, input.to));
    return conds;
  };

  // Overdue claims anything due before this instant; the scheduled and
  // in-progress passes below exclude it so the buckets stay disjoint.
  const overdueCutoff = input.from ?? now;

  // (a) Non-done, non-in_progress tasks scheduled by dueAt.
  const dueByDueConds = [
    ...baseConds,
    isNotNull(entities.dueAt),
    notStatus("done"),
    notStatus("in_progress"),
    gte(entities.dueAt, overdueCutoff),
    ...inRange(entities.dueAt)
  ];
  const dueByDue = await db
    .select()
    .from(entities)
    .where(and(...dueByDueConds))
    .orderBy(asc(entities.dueAt));

  // (b) Done tasks rendered on completedAt, with updatedAt as the legacy
  // fallback for rows completed before completed_at existed. Never place done
  // work by dueAt: completion history should reflect when work actually ended.
  let doneByCompleted: Entity[] = [];
  if (input.includeDone) {
    const doneByCompletedConds: SQL[] = [
      inWorkspace,
      eq(entities.kind, "task"),
      isNull(entities.deletedAt),
      eq(entities.status, "done"),
      isNotNull(entities.completedAt),
      ...inRange(entities.completedAt)
    ];
    if (projectFilter) doneByCompletedConds.push(projectFilter);
    if (activeProjectFilter) doneByCompletedConds.push(activeProjectFilter);
    const completedRows = await db
      .select()
      .from(entities)
      .where(and(...doneByCompletedConds))
      .orderBy(asc(entities.completedAt));

    const legacyDoneConds: SQL[] = [
      inWorkspace,
      eq(entities.kind, "task"),
      isNull(entities.deletedAt),
      eq(entities.status, "done"),
      isNull(entities.completedAt),
      ...inRange(entities.updatedAt)
    ];
    if (projectFilter) legacyDoneConds.push(projectFilter);
    if (activeProjectFilter) legacyDoneConds.push(activeProjectFilter);
    const legacyRows = await db
      .select()
      .from(entities)
      .where(and(...legacyDoneConds))
      .orderBy(asc(entities.updatedAt));

    doneByCompleted = [...completedRows, ...legacyRows];
  }

  // (c) in_progress tasks → today. Only relevant when "now" falls inside the
  // requested window; otherwise the day cell would never render them anyway.
  // Past-due in_progress work belongs to overdue, and undated in_progress
  // work to backlog when the caller asked for it.
  let inProgressToday: Entity[] = [];
  const todayInRange =
    (!input.from || now >= new Date(input.from)) &&
    (!input.to || now < new Date(input.to));
  if (todayInRange) {
    const ipConds: SQL[] = [
      inWorkspace,
      eq(entities.kind, "task"),
      isNull(entities.deletedAt),
      eq(entities.status, "in_progress"),
      input.includeBacklog
        ? gte(entities.dueAt, overdueCutoff)
        : or(isNull(entities.dueAt), gte(entities.dueAt, overdueCutoff))!
    ];
    if (projectFilter) ipConds.push(projectFilter);
    if (activeProjectFilter) ipConds.push(activeProjectFilter);
    inProgressToday = await db
      .select()
      .from(entities)
      .where(and(...ipConds))
      .orderBy(asc(entities.dueAt));
  }

  // Dedup by id — a status='done' task with a completedAt also matched (a) if
  // its dueAt landed in range; (b) wins because it's the canonical display.
  const scheduledMap = new Map<string, Entity>();
  for (const e of dueByDue) scheduledMap.set(e.id, e);
  for (const e of doneByCompleted) scheduledMap.set(e.id, e);
  for (const e of inProgressToday) scheduledMap.set(e.id, e);
  const scheduled = Array.from(scheduledMap.values());

  // Overdue = past-due work that still needs attention, whether it has been
  // started or not.
  const overdueConds: SQL[] = [
    inWorkspace,
    eq(entities.kind, "task"),
    isNull(entities.deletedAt),
    isNotNull(entities.dueAt),
    lt(entities.dueAt, overdueCutoff),
    notStatus("done"),
    notStatus("rejected"),
    notStatus("archived")
  ];
  if (projectFilter) overdueConds.push(projectFilter);
  if (activeProjectFilter) overdueConds.push(activeProjectFilter);
  const overdue = await db
    .select()
    .from(entities)
    .where(and(...overdueConds))
    .orderBy(asc(entities.dueAt));

  let backlog: Entity[] = [];
  if (input.includeBacklog) {
    backlog = await db
      .select()
      .from(entities)
      .where(and(...baseConds, isNull(entities.dueAt)))
      .orderBy(desc(entities.createdAt))
      .limit(200);
  }

  const virtualOccurrences = await expandVirtualOccurrences(scope, db, input, scheduled, assignee);
  const taskIds = [...scheduled, ...overdue, ...backlog].map((t) => t.id);
  const [blockers, hierarchy] = await Promise.all([
    blockersFor(scope, db, taskIds),
    hierarchyFor(scope, db, taskIds)
  ]);
  const decorate = (rows: Entity[]): ListedTask[] =>
    rows.map((t) => ({
      ...t,
      blockedBy: blockers.get(t.id) ?? [],
      ...(hierarchy.get(t.id) ?? { parent: null, subtasks: null })
    }));
  return {
    scheduled: decorate(scheduled),
    overdue: decorate(overdue),
    backlog: decorate(backlog),
    virtualOccurrences
  };
}

/**
 * Compute "ghost" virtual occurrences for all active scheduled-anchor
 * recurrence rules within the query window.  These are NOT stored in the DB;
 * they are ephemeral previews of future materialization.
 *
 * HARD BOUNDARY: only called when input.includeVirtualRecurrences is true.
 * The window is clamped to [max(input.from, now), input.to) so only strictly
 * future ghosts are returned.
 */
async function expandVirtualOccurrences(
  scope: Scope,
  db: Database["db"],
  input: TasksRangeInput,
  realScheduled: Entity[],
  assignee: SQL | null
): Promise<VirtualOccurrence[]> {
  // Guard: feature must be explicitly requested and a horizon must be present.
  if (!input.includeVirtualRecurrences || !input.to) return [];

  const now = new Date();
  const windowStart = new Date(Math.max((input.from ? new Date(input.from).getTime() : now.getTime()), now.getTime()));
  const windowEnd = new Date(input.to);
  if (windowStart.getTime() >= windowEnd.getTime()) return [];

  // --- Query 1: candidate rules (enabled, scheduled, not ended before window) ---
  const candidateRules = await db
    .select()
    .from(recurrenceRules)
    .where(
      and(
        eq(recurrenceRules.workspaceId, scope.workspaceId),
        eq(recurrenceRules.enabled, true),
        eq(recurrenceRules.anchor, "scheduled"),
        lte(recurrenceRules.dtstart, windowEnd),
        or(
          isNull(recurrenceRules.endedAt),
          // endedAt >= windowStart means rule may still have occurrences in window
          gte(recurrenceRules.endedAt, windowStart)
        )!
      )
    );

  if (candidateRules.length === 0) return [];

  // --- Query 2: batch-fetch display-source entities ---
  // For each rule: display source = currentOccurrenceId ?? seriesId
  const displaySourceIds = candidateRules.map(
    (r) => r.currentOccurrenceId ?? r.seriesId
  );
  const uniqueDisplaySourceIds = [...new Set(displaySourceIds)];
  const displaySourceRows = await db
    .select()
    .from(entities)
    .where(
      and(
        entityInScope(scope),
        inArray(entities.id, uniqueDisplaySourceIds),
        ...(assignee ? [assignee] : [])
      )
    );
  const displaySourceById = new Map<string, Entity>(
    displaySourceRows.map((e) => [e.id, e])
  );

  // --- Query 3: batch-fetch this-only baselines for display sources ---
  // These are 'modified' exceptions where the baseline records what the
  // pre-edit value was; we apply them so a this-only edit on the current
  // occurrence is NOT reflected in the ghost (the ghost should show what
  // materialization will actually generate, which reverts this-only edits).
  const modifiedExceptions = await db
    .select()
    .from(recurrenceExceptions)
    .where(
      and(
        inArray(recurrenceExceptions.entityId, uniqueDisplaySourceIds),
        eq(recurrenceExceptions.action, "modified")
      )
    );
  // Map entityId → baseline (the pre-edit / series-default value)
  const baselineByEntityId = new Map<string, Record<string, unknown>>();
  for (const exc of modifiedExceptions) {
    if (!exc.entityId) continue;
    const meta = exc.metadata as Record<string, unknown>;
    const baseline = meta?.baseline;
    if (baseline && typeof baseline === "object" && !Array.isArray(baseline)) {
      baselineByEntityId.set(exc.entityId, baseline as Record<string, unknown>);
    }
  }

  // --- Query 4: batch-fetch exceptions for subtraction ---
  const ruleIds = candidateRules.map((r) => r.id);
  const exceptionRows = await db
    .select()
    .from(recurrenceExceptions)
    .where(
      and(
        inArray(recurrenceExceptions.ruleId, ruleIds),
        gte(recurrenceExceptions.occurrenceAt, windowStart),
        lt(recurrenceExceptions.occurrenceAt, windowEnd)
      )
    );
  // Group exceptions by ruleId; track the blocked occurrence timestamps on the
  // SAME normalized timeline used for the ghosts below (occurrenceAt is already
  // stored normalized, so re-normalizing is idempotent — but it keeps the
  // exception and materialized subtractions on one consistent timeline even for
  // extreme timezones where a raw RRule date and its normalized dueAt differ).
  const ruleById = new Map(candidateRules.map((r) => [r.id, r]));
  const blockedByRule = new Map<string, Set<number>>();
  for (const exc of exceptionRows) {
    if (exc.action === "skipped" || exc.action === "cancelled" || exc.action === "modified") {
      const rule = ruleById.get(exc.ruleId);
      if (!rule) continue;
      if (!blockedByRule.has(exc.ruleId)) blockedByRule.set(exc.ruleId, new Set());
      blockedByRule.get(exc.ruleId)!.add(normalizeOccurrenceDueAt(rule, exc.occurrenceAt).getTime());
    }
  }

  // Build a set of (ruleId, normalizedDueAt ms) that are already materialized
  // so we can subtract them from virtuals.
  const realByRule = new Map<string, Set<number>>();
  for (const e of realScheduled) {
    const meta = e.metadata as { recurrence?: { ruleId?: string } } | null;
    const ruleId = meta?.recurrence?.ruleId;
    if (!ruleId || !e.dueAt) continue;
    if (!realByRule.has(ruleId)) realByRule.set(ruleId, new Set());
    realByRule.get(ruleId)!.add(e.dueAt.getTime());
  }

  // --- Expand per rule ---
  const virtuals: VirtualOccurrence[] = [];

  for (const rule of candidateRules) {
    const displaySourceId = rule.currentOccurrenceId ?? rule.seriesId;
    const displaySource = displaySourceById.get(displaySourceId);
    if (!displaySource) continue;

    // Project filter
    if (input.projectIds?.length) {
      if (!displaySource.projectId || !input.projectIds.includes(displaySource.projectId)) continue;
    }

    // Resolve effective title and priority (apply baseline to revert this-only edits)
    const baseline = baselineByEntityId.get(displaySourceId);
    const effectiveTitle =
      baseline && "title" in baseline
        ? (baseline.title as string | null)
        : displaySource.title;
    const effectivePriority =
      baseline && "priority" in baseline
        ? ((baseline.priority as string) ?? "none")
        : displaySource.priority;

    // Expand RRule within window
    const rruleInstance = buildRRule(rule, rule.dtstart);
    const rawDates = rruleInstance.between(windowStart, windowEnd, true);

    const blockedTimes = blockedByRule.get(rule.id);
    const realTimes = realByRule.get(rule.id);

    for (const rawDate of rawDates) {
      const normalizedDate = normalizeOccurrenceDueAt(rule, rawDate);
      const normalizedMs = normalizedDate.getTime();

      // Subtract: blocked by a skip/cancel/modify exception (normalized timeline)
      if (blockedTimes?.has(normalizedMs)) continue;

      // Subtract: already materialized as a real entity (match by normalized dueAt)
      if (realTimes?.has(normalizedMs)) continue;

      const dueAtISO = normalizedDate.toISOString();
      virtuals.push({
        virtual: true,
        id: `virtual:${rule.id}:${dueAtISO}`,
        ruleId: rule.id,
        seriesId: rule.seriesId,
        occurrenceAt: rawDate.toISOString(),
        dueAt: dueAtISO,
        title: effectiveTitle,
        projectId: displaySource.projectId,
        priority: effectivePriority,
        allDay: rule.allDay,
        timezone: rule.timezone,
        rrule: rule.rrule
      });
    }
  }

  return virtuals;
}
