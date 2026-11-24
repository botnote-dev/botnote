/**
 * Tests for virtual-occurrence helpers and the GhostChip component.
 *
 * groupVirtualsByDay: groups VirtualOccurrence[] by the local calendar day
 *   derived from dueAt (noon-UTC ISO), using the same "yyyy-MM-dd" key format
 *   as groupTasksByDay / dayKey.
 *
 * GhostChip: renders a dimmed, non-interactive chip for a future ghost
 *   occurrence. Must have no interactive affordances.
 */
import { render, screen } from "@testing-library/react";
import { format } from "date-fns";
import { describe, expect, it } from "vitest";
import type { VirtualOccurrence } from "../../../api/types";
import { GhostChip } from "../TaskChip";
import { groupVirtualsByDay } from "../utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVirtual(overrides: Partial<VirtualOccurrence> = {}): VirtualOccurrence {
  return {
    virtual: true,
    id: "virtual:rule-1:2026-06-26T12:00:00.000Z",
    ruleId: "rule-1",
    seriesId: "series-1",
    occurrenceAt: "2026-06-26T00:00:00.000Z",
    dueAt: "2026-06-26T12:00:00.000Z",
    title: "Weekly review",
    projectId: "proj-1",
    priority: "none",
    allDay: true,
    timezone: "UTC",
    rrule: "FREQ=WEEKLY;INTERVAL=1",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// groupVirtualsByDay
// ---------------------------------------------------------------------------

describe("groupVirtualsByDay", () => {
  it("returns an empty map for an empty array", () => {
    const map = groupVirtualsByDay([]);
    expect(map.size).toBe(0);
  });

  it("groups virtuals by the yyyy-MM-dd key of their dueAt (local date-fns format)", () => {
    // Both noon-UTC dates produce the same local day key via date-fns format()
    const v1 = makeVirtual({ id: "v1", dueAt: "2026-06-26T12:00:00.000Z" });
    const v2 = makeVirtual({ id: "v2", dueAt: "2026-06-26T12:00:00.000Z" });
    const v3 = makeVirtual({ id: "v3", dueAt: "2026-06-27T12:00:00.000Z" });

    const map = groupVirtualsByDay([v1, v2, v3]);

    // Key for June 26 in local time
    const key26 = format(new Date("2026-06-26T12:00:00.000Z"), "yyyy-MM-dd");
    const key27 = format(new Date("2026-06-27T12:00:00.000Z"), "yyyy-MM-dd");

    expect(map.get(key26)?.map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(map.get(key27)?.map((v) => v.id)).toEqual(["v3"]);
  });

  it("preserves insertion order within a day bucket", () => {
    const v1 = makeVirtual({ id: "a", dueAt: "2026-07-01T12:00:00.000Z" });
    const v2 = makeVirtual({ id: "b", dueAt: "2026-07-01T12:00:00.000Z" });
    const v3 = makeVirtual({ id: "c", dueAt: "2026-07-01T12:00:00.000Z" });
    const map = groupVirtualsByDay([v1, v2, v3]);
    const key = format(new Date("2026-07-01T12:00:00.000Z"), "yyyy-MM-dd");
    expect(map.get(key)?.map((v) => v.id)).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// GhostChip
// ---------------------------------------------------------------------------

describe("GhostChip", () => {
  it("renders the virtual title", () => {
    const v = makeVirtual({ title: "Weekly review" });
    render(<GhostChip virtual={v} />);
    expect(screen.getByText("Weekly review")).toBeInTheDocument();
  });

  it("falls back to 'Untitled' when title is null", () => {
    const v = makeVirtual({ title: null });
    render(<GhostChip virtual={v} />);
    expect(screen.getByText("Untitled")).toBeInTheDocument();
  });

  it("falls back to 'Untitled' when title is an empty string", () => {
    const v = makeVirtual({ title: "" });
    render(<GhostChip virtual={v} />);
    expect(screen.getByText("Untitled")).toBeInTheDocument();
  });

  it("has an aria-label mentioning 'Upcoming — will be created automatically'", () => {
    const v = makeVirtual({ title: "Weekly review" });
    render(<GhostChip virtual={v} />);
    const el = screen.getByLabelText(/Upcoming — will be created automatically/i);
    expect(el).toBeInTheDocument();
  });

  it("is NOT a button (non-interactive: no role=button)", () => {
    const v = makeVirtual();
    render(<GhostChip virtual={v} />);
    // No button role in the document
    const buttons = document.querySelectorAll('[role="button"]');
    expect(buttons).toHaveLength(0);
  });

  it("has no tabIndex (non-focusable)", () => {
    const v = makeVirtual();
    render(<GhostChip virtual={v} />);
    const chip = screen.getByLabelText(/Upcoming/i);
    // tabIndex is absent or -1 means not in tab order; the element should have no tabIndex attribute
    expect(chip.hasAttribute("tabindex")).toBe(false);
  });

  it("has pointer-events-none class (not clickable)", () => {
    const v = makeVirtual();
    render(<GhostChip virtual={v} />);
    const chip = screen.getByLabelText(/Upcoming/i);
    expect(chip.className).toContain("pointer-events-none");
  });

  it("is not draggable", () => {
    const v = makeVirtual();
    render(<GhostChip virtual={v} />);
    const chip = screen.getByLabelText(/Upcoming/i);
    expect(chip.getAttribute("draggable")).not.toBe("true");
  });

  it("uses project color as the accent bar color when project is provided", () => {
    const v = makeVirtual();
    const project = {
      id: "proj-1",
      key: "P",
      name: "My Project",
      status: "active" as const,
      color: "#ff6600",
      icon: "circle",
      agentsMd: "",
    ownerUserId: null,
    visibility: "private" as const,
      archivedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const { container } = render(<GhostChip virtual={v} project={project} />);
    // The color bar span has inline backgroundColor.
    // jsdom normalizes hex colors to rgb(...) in style attributes.
    const bar = container.querySelector('span[style]');
    const style = bar?.getAttribute("style") ?? "";
    // Accept either the original hex or jsdom's rgb() normalization
    expect(style).toMatch(/#ff6600|rgb\(255,\s*102,\s*0\)/);
  });
});
