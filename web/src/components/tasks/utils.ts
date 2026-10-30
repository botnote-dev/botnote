import {
  addDays,
  addMonths,
  addWeeks,
  endOfDay,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isToday,
  startOfDay,
  startOfMonth,
  startOfWeek
} from "date-fns";
import type { Entity, Project, VirtualOccurrence } from "../../api/types";

export type CalendarView = "day" | "week" | "month";

export function viewRange(view: CalendarView, anchor: Date): { from: Date; to: Date } {
  if (view === "day") {
    return { from: startOfDay(anchor), to: endOfDay(anchor) };
  }
  if (view === "week") {
    return {
      from: startOfWeek(anchor, { weekStartsOn: 1 }),
      to: endOfWeek(anchor, { weekStartsOn: 1 })
    };
  }
  // month — extend to full weeks for grid coverage
  const monthStart = startOfMonth(anchor);
  const monthEnd = endOfMonth(anchor);
  return {
    from: startOfWeek(monthStart, { weekStartsOn: 1 }),
    to: endOfWeek(monthEnd, { weekStartsOn: 1 })
  };
}

export function moveAnchor(view: CalendarView, anchor: Date, dir: -1 | 0 | 1): Date {
  if (dir === 0) return new Date();
  if (view === "day") return addDays(anchor, dir);
  if (view === "week") return addWeeks(anchor, dir);
  return addMonths(anchor, dir);
}

export function rangeLabel(view: CalendarView, anchor: Date): string {
  if (view === "day") return format(anchor, "EEEE · MMMM d, yyyy");
  if (view === "week") {
    const start = startOfWeek(anchor, { weekStartsOn: 1 });
    const end = endOfWeek(anchor, { weekStartsOn: 1 });
    if (start.getMonth() === end.getMonth()) {
      return `${format(start, "MMMM d")} – ${format(end, "d, yyyy")}`;
    }
    return `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")}`;
  }
  return format(anchor, "MMMM yyyy");
}

/**
 * Decide which calendar day a task should render on.
 *   - done            → its actual completion day (completedAt), so the
 *                       timeline reflects when work shipped, not when it was
 *                       originally planned for.
 *   - in_progress     → today, rolling — surfaces active work even when the
 *                       due date is in the past or far future.
 *   - everything else → the due date (the planned day).
 *
 * Done tasks missing completedAt (pre-migration rows or other oddities) fall
 * back to updatedAt; if even that's missing they fall through to dueAt.
 */
export function displayDate(t: Entity): Date | null {
  if (t.status === "in_progress") return new Date();
  if (t.status === "done") {
    if (t.completedAt) return new Date(t.completedAt);
    if (t.updatedAt) return new Date(t.updatedAt);
  }
  return t.dueAt ? new Date(t.dueAt) : null;
}

export function isTaskOverdue(t: Entity, now = new Date()): boolean {
  if (!t.dueAt) return false;
  if (t.status === "done" || t.status === "in_progress" || t.status === "rejected") {
    return false;
  }
  return new Date(t.dueAt).getTime() < startOfDay(now).getTime();
}

/**
 * A task belongs to a recurring series if it carries the recurrence marker the
 * backend writes in src/service/recurrence.ts (withRecurrenceMetadata when a
 * rule is attached, and inline on each generated occurrence). Every occurrence
 * — including the first task a rule is attached to — has
 * metadata.recurrence.role === "occurrence".
 */
export function isRecurring(t: Entity): boolean {
  const meta = t.metadata as { recurrence?: { role?: string } } | null | undefined;
  return meta?.recurrence?.role === "occurrence";
}

export function groupTasksByDay(
  tasks: Entity[]
): Map<string, Entity[]> {
  const m = new Map<string, Entity[]>();
  for (const t of tasks) {
    const d = displayDate(t);
    if (!d) continue;
    const key = format(d, "yyyy-MM-dd");
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(t);
  }
  return m;
}

/**
 * Group virtual (ghost) occurrences by calendar day key ("yyyy-MM-dd"),
 * using the same key format as groupTasksByDay / dayKey.
 * The dueAt field on each VirtualOccurrence is always a noon-UTC ISO string,
 * so format(new Date(v.dueAt), "yyyy-MM-dd") produces the correct local day.
 */
export function groupVirtualsByDay(
  virtuals: VirtualOccurrence[]
): Map<string, VirtualOccurrence[]> {
  const m = new Map<string, VirtualOccurrence[]>();
  for (const v of virtuals) {
    const key = format(new Date(v.dueAt), "yyyy-MM-dd");
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(v);
  }
  return m;
}

export function dayKey(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

export function daysBetween(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  let cur = startOfDay(from);
  const end = endOfDay(to);
  while (cur <= end) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

export function projectLookup(projects?: Project[]): Map<string, Project> {
  const m = new Map<string, Project>();
  projects?.forEach((p) => m.set(p.id, p));
  return m;
}

// Default sort order inside a calendar day cell: active work first
// (in_progress), then unstarted (open / "todo"), then completed (done),
// then everything else. Stable so any secondary order the backend chose
// (asc dueAt / asc completedAt) is preserved within a status group.
const STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  open: 1,
  done: 2
};

export function compareByStatus(a: Entity, b: Entity): number {
  const ra = STATUS_ORDER[a.status] ?? 3;
  const rb = STATUS_ORDER[b.status] ?? 3;
  return ra - rb;
}

export function isClosed(t: Entity): boolean {
  return t.status === "done" || t.status === "rejected";
}

/** Comparator that leaves an already-sorted list as it is. */
export const KEEP_ORDER = () => 0;

/** A day's tasks split into actionable ones (in progress first) and closed ones. */
export function partitionByStatus(
  tasks: Entity[],
  compare: (a: Entity, b: Entity) => number = compareByStatus
): { open: Entity[]; closed: Entity[] } {
  const sorted = tasks.slice().sort(compare);
  return { open: sorted.filter((t) => !isClosed(t)), closed: sorted.filter(isClosed) };
}

/**
 * How many of `count` chips to show in `slots` rows. When they don't all fit,
 * one row is given up for the "+N more" link so it never gets clipped.
 */
export function visibleChipCount(count: number, slots: number): number {
  if (count <= slots) return count;
  return Math.max(slots - 1, 0);
}

export { format, isSameDay, isToday };
