import { format } from "date-fns";
import { describe, expect, it } from "vitest";
import type { Entity } from "../../../api/types";
import {
  compareByStatus,
  dayKey,
  daysBetween,
  displayDate,
  groupTasksByDay,
  isClosed,
  isRecurring,
  isTaskOverdue,
  moveAnchor,
  partitionByStatus,
  projectLookup,
  rangeLabel,
  viewRange,
  visibleChipCount
} from "../utils";

// Helper: local date string (yyyy-MM-dd) for a Date without UTC conversion
function localDate(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Entity> = {}): Entity {
  return {
    id: "t1",
    projectId: "p1",
    kind: "task",
    title: "Test task",
    body: "",
    tags: [],
    status: "open",
    actorId: null,
    actorKind: "human",
    idempotencyKey: null,
    parentId: null,
    metadata: {},
    dueAt: null,
    priority: "none",
    sequenceId: null,
    pinned: false,
    completedAt: null,
    lastAccessedAt: null,
    accessCount: 0,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// viewRange
// ---------------------------------------------------------------------------

describe("viewRange", () => {
  const anchor = new Date("2024-06-26T12:00:00Z"); // Wednesday

  it("day view returns startOfDay / endOfDay", () => {
    const { from, to } = viewRange("day", anchor);
    // Use local-time accessors because date-fns operates in local time
    expect(from.getHours()).toBe(0);
    expect(from.getMinutes()).toBe(0);
    expect(to.getHours()).toBe(23);
    expect(to.getMinutes()).toBe(59);
    // Same calendar day
    expect(from.getFullYear()).toBe(anchor.getFullYear());
    expect(from.getMonth()).toBe(anchor.getMonth());
    expect(from.getDate()).toBe(anchor.getDate());
  });

  it("week view starts on Monday (weekStartsOn: 1)", () => {
    const { from, to } = viewRange("week", anchor);
    // 2024-06-26 is Wednesday → week start is Monday 2024-06-24, end Sunday 2024-06-30
    // Use local-date format (date-fns operates in local time)
    expect(localDate(from)).toBe("2024-06-24");
    expect(localDate(to)).toBe("2024-06-30");
    // to must be a Sunday (getDay() === 0)
    expect(to.getDay()).toBe(0);
  });

  it("month view extends to full weeks covering month boundaries", () => {
    const { from, to } = viewRange("month", anchor);
    const fromStr = localDate(from);
    const toStr = localDate(to);
    // from must be a Monday
    expect(from.getDay()).toBe(1);
    // to must be a Sunday
    expect(to.getDay()).toBe(0);
    // sanity: from is on or before June 1, to is on or after June 30
    expect(fromStr <= "2024-06-01").toBe(true);
    expect(toStr >= "2024-06-30").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// moveAnchor
// ---------------------------------------------------------------------------

describe("moveAnchor", () => {
  const base = new Date("2024-06-26T12:00:00Z");

  it("dir 0 returns today regardless of view or anchor", () => {
    const result = moveAnchor("week", base, 0);
    const today = new Date();
    expect(result.toISOString().slice(0, 10)).toBe(today.toISOString().slice(0, 10));
  });

  it("day view moves by 1 day forward", () => {
    const result = moveAnchor("day", base, 1);
    expect(result.toISOString().slice(0, 10)).toBe("2024-06-27");
  });

  it("day view moves by 1 day backward", () => {
    const result = moveAnchor("day", base, -1);
    expect(result.toISOString().slice(0, 10)).toBe("2024-06-25");
  });

  it("week view moves by 7 days", () => {
    const result = moveAnchor("week", base, 1);
    expect(result.toISOString().slice(0, 10)).toBe("2024-07-03");
  });

  it("month view moves by 1 month", () => {
    const result = moveAnchor("month", base, 1);
    expect(result.toISOString().slice(0, 10)).toBe("2024-07-26");
  });

  it("month view moves backward by 1 month", () => {
    const result = moveAnchor("month", base, -1);
    expect(result.toISOString().slice(0, 10)).toBe("2024-05-26");
  });
});

// ---------------------------------------------------------------------------
// rangeLabel
// ---------------------------------------------------------------------------

describe("rangeLabel", () => {
  it("day view shows full weekday + date", () => {
    const label = rangeLabel("day", new Date("2024-06-26T12:00:00Z"));
    // Should include "Wednesday" (UTC day; local time might differ – be flexible)
    expect(label).toMatch(/2024/);
    expect(label).toMatch(/26/);
  });

  it("week view with same month shows condensed format", () => {
    // Use a date where the whole week is in the same month
    const anchor = new Date("2024-07-10T12:00:00Z"); // July week: July 8–14
    const label = rangeLabel("week", anchor);
    // Single month range should not repeat the month name twice
    expect(label).toMatch(/July/);
    expect(label).toMatch(/–/);
  });

  it("month view shows only month and year", () => {
    const label = rangeLabel("month", new Date("2024-06-26T12:00:00Z"));
    expect(label).toMatch(/June 2024|Jun 2024/);
  });
});

// ---------------------------------------------------------------------------
// displayDate
// ---------------------------------------------------------------------------

describe("displayDate", () => {
  it("returns null when task has no dueAt and status is open", () => {
    const t = makeTask({ status: "open", dueAt: null });
    expect(displayDate(t)).toBeNull();
  });

  it("returns dueAt as Date for open task", () => {
    const t = makeTask({ status: "open", dueAt: "2024-06-26T00:00:00Z" });
    const d = displayDate(t);
    expect(d?.toISOString()).toBe("2024-06-26T00:00:00.000Z");
  });

  it("in_progress task always returns today", () => {
    const t = makeTask({ status: "in_progress", dueAt: "2020-01-01T00:00:00Z" });
    const d = displayDate(t);
    const today = new Date().toISOString().slice(0, 10);
    expect(d?.toISOString().slice(0, 10)).toBe(today);
  });

  it("done task returns completedAt when available", () => {
    const t = makeTask({
      status: "done",
      completedAt: "2024-05-10T10:00:00Z",
      dueAt: "2024-06-01T00:00:00Z"
    });
    const d = displayDate(t);
    expect(d?.toISOString()).toBe("2024-05-10T10:00:00.000Z");
  });

  it("done task falls back to updatedAt when completedAt is null", () => {
    const t = makeTask({
      status: "done",
      completedAt: null,
      updatedAt: "2024-05-11T12:00:00Z",
      dueAt: "2024-06-01T00:00:00Z"
    });
    const d = displayDate(t);
    expect(d?.toISOString()).toBe("2024-05-11T12:00:00.000Z");
  });

  it("done task with no completedAt or updatedAt falls through to dueAt", () => {
    const t = makeTask({
      status: "done",
      completedAt: null,
      updatedAt: "",
      dueAt: "2024-06-20T00:00:00Z"
    });
    // updatedAt falsy → no date from it; falls back to dueAt
    const d = displayDate(t);
    // updatedAt is "" which is falsy, so it falls through to dueAt
    expect(d?.toISOString()).toBe("2024-06-20T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// isTaskOverdue
// ---------------------------------------------------------------------------

describe("isTaskOverdue", () => {
  const now = new Date("2024-06-26T15:00:00Z");

  it("returns false when task has no dueAt", () => {
    const t = makeTask({ status: "open", dueAt: null });
    expect(isTaskOverdue(t, now)).toBe(false);
  });

  it("returns false for done tasks regardless of dueAt", () => {
    const t = makeTask({ status: "done", dueAt: "2020-01-01T00:00:00Z" });
    expect(isTaskOverdue(t, now)).toBe(false);
  });

  it("returns true for in_progress task with past dueAt", () => {
    const t = makeTask({ status: "in_progress", dueAt: "2020-01-01T00:00:00Z" });
    expect(isTaskOverdue(t, now)).toBe(true);
  });

  it("returns false for in_progress task with future dueAt", () => {
    const t = makeTask({ status: "in_progress", dueAt: "2024-12-31T00:00:00Z" });
    expect(isTaskOverdue(t, now)).toBe(false);
  });

  it("returns false for rejected tasks", () => {
    const t = makeTask({ status: "rejected", dueAt: "2020-01-01T00:00:00Z" });
    expect(isTaskOverdue(t, now)).toBe(false);
  });

  it("returns true for open task with past dueAt", () => {
    const t = makeTask({ status: "open", dueAt: "2024-06-25T00:00:00Z" });
    expect(isTaskOverdue(t, now)).toBe(true);
  });

  it("returns false for open task with same-day dueAt (not yet past startOfDay)", () => {
    // dueAt is same day as `now` → not overdue (startOfDay(now) is not > dueAt)
    const t = makeTask({ status: "open", dueAt: "2024-06-26T12:00:00Z" });
    expect(isTaskOverdue(t, now)).toBe(false);
  });

  it("returns false for open task with future dueAt", () => {
    const t = makeTask({ status: "open", dueAt: "2024-12-31T00:00:00Z" });
    expect(isTaskOverdue(t, now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isRecurring
// ---------------------------------------------------------------------------

describe("isRecurring", () => {
  it("returns false for task with no metadata", () => {
    const t = makeTask({ metadata: {} });
    expect(isRecurring(t)).toBe(false);
  });

  it("returns false when recurrence role is not 'occurrence'", () => {
    const t = makeTask({ metadata: { recurrence: { role: "rule" } } });
    expect(isRecurring(t)).toBe(false);
  });

  it("returns true when recurrence.role === 'occurrence'", () => {
    const t = makeTask({ metadata: { recurrence: { role: "occurrence" } } });
    expect(isRecurring(t)).toBe(true);
  });

  it("returns false when metadata.recurrence is undefined", () => {
    const t = makeTask({ metadata: { other: "data" } });
    expect(isRecurring(t)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// groupTasksByDay
// ---------------------------------------------------------------------------

describe("groupTasksByDay", () => {
  it("skips tasks with no displayable date", () => {
    const t = makeTask({ status: "open", dueAt: null });
    const map = groupTasksByDay([t]);
    expect(map.size).toBe(0);
  });

  it("groups tasks by their display date key", () => {
    // Use noon UTC so local date matches UTC date in most timezones
    const t1 = makeTask({ id: "a", dueAt: "2024-06-26T12:00:00Z" });
    const t2 = makeTask({ id: "b", dueAt: "2024-06-26T14:00:00Z" });
    const t3 = makeTask({ id: "c", dueAt: "2024-06-27T12:00:00Z" });
    const map = groupTasksByDay([t1, t2, t3]);
    // All buckets; find the ones that contain our tasks
    const entries = Array.from(map.entries());
    const t1Key = localDate(new Date("2024-06-26T12:00:00Z"));
    const t3Key = localDate(new Date("2024-06-27T12:00:00Z"));
    const june26Bucket = entries.find(([k]) => k === t1Key)?.[1];
    const june27Bucket = entries.find(([k]) => k === t3Key)?.[1];
    expect(june26Bucket?.map((t) => t.id)).toEqual(["a", "b"]);
    expect(june27Bucket?.map((t) => t.id)).toEqual(["c"]);
  });
});

// ---------------------------------------------------------------------------
// dayKey
// ---------------------------------------------------------------------------

describe("dayKey", () => {
  it("returns yyyy-MM-dd string for a Date", () => {
    const d = new Date("2024-06-26T15:00:00Z");
    // Output format should always be yyyy-MM-dd regardless of timezone
    expect(dayKey(d)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is consistent with localDate helper (format from date-fns)", () => {
    const d = new Date("2024-06-26T15:00:00Z");
    expect(dayKey(d)).toBe(localDate(d));
  });
});

// ---------------------------------------------------------------------------
// daysBetween
// ---------------------------------------------------------------------------

describe("daysBetween", () => {
  it("returns a single date when from and to are the same day", () => {
    const d = new Date("2024-06-26T12:00:00Z");
    const days = daysBetween(d, d);
    expect(days.length).toBe(1);
  });

  it("returns correct number of dates for a range", () => {
    const from = new Date("2024-06-24T00:00:00Z");
    const to = new Date("2024-06-26T00:00:00Z");
    const days = daysBetween(from, to);
    expect(days.length).toBe(3); // June 24, 25, 26
  });
});

// ---------------------------------------------------------------------------
// projectLookup
// ---------------------------------------------------------------------------

describe("projectLookup", () => {
  it("returns an empty map for undefined input", () => {
    expect(projectLookup(undefined).size).toBe(0);
  });

  it("indexes projects by id", () => {
    const p = {
      id: "proj1",
      key: "P",
      name: "My Project",
      status: "active" as const,
      color: "#000",
      icon: "📁",
      agentsMd: "",
      archivedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const map = projectLookup([p]);
    expect(map.get("proj1")).toEqual(p);
    expect(map.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// compareByStatus
// ---------------------------------------------------------------------------

describe("compareByStatus", () => {
  it("in_progress sorts before open", () => {
    const a = makeTask({ status: "in_progress" });
    const b = makeTask({ status: "open" });
    expect(compareByStatus(a, b)).toBeLessThan(0);
  });

  it("open sorts before done", () => {
    const a = makeTask({ status: "open" });
    const b = makeTask({ status: "done" });
    expect(compareByStatus(a, b)).toBeLessThan(0);
  });

  it("unknown status sorts last", () => {
    const a = makeTask({ status: "rejected" });
    const b = makeTask({ status: "done" });
    expect(compareByStatus(a, b)).toBeGreaterThan(0);
  });

  it("equal statuses return 0", () => {
    const a = makeTask({ status: "open" });
    const b = makeTask({ status: "open" });
    expect(compareByStatus(a, b)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isClosed / partitionByStatus
// ---------------------------------------------------------------------------

describe("isClosed", () => {
  it("treats done and rejected as closed", () => {
    expect(isClosed(makeTask({ status: "done" }))).toBe(true);
    expect(isClosed(makeTask({ status: "rejected" }))).toBe(true);
  });

  it("treats open and in_progress as not closed", () => {
    expect(isClosed(makeTask({ status: "open" }))).toBe(false);
    expect(isClosed(makeTask({ status: "in_progress" }))).toBe(false);
  });
});

describe("partitionByStatus", () => {
  it("splits open from closed and puts in_progress first", () => {
    const tasks = [
      makeTask({ id: "a", status: "open" }),
      makeTask({ id: "b", status: "done" }),
      makeTask({ id: "c", status: "in_progress" }),
      makeTask({ id: "d", status: "rejected" })
    ];
    const { open, closed } = partitionByStatus(tasks);
    expect(open.map((t) => t.id)).toEqual(["c", "a"]);
    expect(closed.map((t) => t.id)).toEqual(["b", "d"]);
  });

  it("does not reorder the input array", () => {
    const tasks = [makeTask({ id: "a", status: "done" }), makeTask({ id: "b", status: "open" })];
    partitionByStatus(tasks);
    expect(tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// visibleChipCount
// ---------------------------------------------------------------------------

describe("visibleChipCount", () => {
  it("shows every chip when they all fit", () => {
    expect(visibleChipCount(3, 3)).toBe(3);
    expect(visibleChipCount(2, 5)).toBe(2);
  });

  it("gives up one row for the +N more link when they don't fit", () => {
    expect(visibleChipCount(6, 4)).toBe(3);
  });

  it("never goes negative before the cell is measured", () => {
    expect(visibleChipCount(4, 0)).toBe(0);
    expect(visibleChipCount(0, 0)).toBe(0);
  });
});
