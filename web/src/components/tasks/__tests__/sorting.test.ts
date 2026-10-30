import { describe, expect, it } from "vitest";
import type { Entity, Project } from "../../../api/types";
import { groupTasks, sortTasks } from "../sorting";

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

const projectMap = new Map<string, Project>([
  ["pa", { id: "pa", key: "AAA", name: "Alpha" } as Project],
  ["pz", { id: "pz", key: "ZZZ", name: "Zulu" } as Project]
]);

const tasks: Entity[] = [
  makeTask({ id: "done-urgent", status: "done", priority: "urgent", projectId: "pa" }),
  makeTask({ id: "open-low", status: "open", priority: "low", projectId: "pa" }),
  makeTask({ id: "open-high", status: "open", priority: "high", projectId: "pz" }),
  makeTask({ id: "wip-none", status: "in_progress", priority: "none", projectId: null }),
  makeTask({ id: "open-high-due", status: "open", priority: "high", projectId: "pa", dueAt: "2026-01-01T12:00:00Z" })
];
const ids = (list: Entity[]) => list.map((t) => t.id);

describe("sortTasks", () => {
  it("status: in progress first, then priority, closed last", () => {
    expect(ids(sortTasks(tasks, "status", projectMap))).toEqual([
      "wip-none",
      "open-high-due",
      "open-high",
      "open-low",
      "done-urgent"
    ]);
  });

  it("priority: most urgent open work first, closed still sinks", () => {
    expect(ids(sortTasks(tasks, "priority", projectMap))).toEqual([
      "open-high-due",
      "open-high",
      "open-low",
      "wip-none",
      "done-urgent"
    ]);
  });

  it("project: by project key, tasks without a project last", () => {
    expect(ids(sortTasks(tasks, "project", projectMap))).toEqual([
      "open-high-due",
      "open-low",
      "open-high",
      "wip-none",
      "done-urgent"
    ]);
  });
});

describe("groupTasks", () => {
  it("orders status groups by workflow and priority groups by urgency", () => {
    const sorted = sortTasks(tasks, "status", projectMap);
    expect(groupTasks(sorted, "status", projectMap).map((g) => g.key)).toEqual(["in_progress", "open", "done"]);
    expect(groupTasks(sorted, "priority", projectMap).map((g) => g.key)).toEqual(["urgent", "high", "low", "none"]);
    expect(groupTasks(sorted, "project", projectMap).map((g) => g.label)).toEqual(["Alpha", "Zulu", "No project"]);
    expect(groupTasks(sorted, "none", projectMap)).toHaveLength(1);
  });
});
