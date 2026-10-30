import type { Entity, Project } from "../../api/types";

export type TaskSort = "status" | "priority" | "project" | "due";
export type TaskGroup = "project" | "status" | "priority" | "none";

export const TASK_SORT_LABEL: Record<TaskSort, string> = {
  status: "Status",
  priority: "Priority",
  project: "Project",
  due: "Due date"
};

export const TASK_GROUP_LABEL: Record<TaskGroup, string> = {
  project: "Project",
  status: "Status",
  priority: "Priority",
  none: "No grouping"
};

const STATUS_RANK: Record<string, number> = { in_progress: 0, open: 1, done: 2, rejected: 3 };
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

export const STATUS_GROUP_LABEL: Record<string, string> = {
  in_progress: "In Progress",
  open: "Todo",
  done: "Done",
  rejected: "Cancelled"
};

export const PRIORITY_GROUP_LABEL: Record<string, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "No priority"
};

const statusRank = (t: Entity) => STATUS_RANK[t.status] ?? 4;
const priorityRank = (t: Entity) => PRIORITY_RANK[t.priority] ?? 4;
const closedRank = (t: Entity) => (t.status === "done" || t.status === "rejected" ? 1 : 0);
const dueTime = (t: Entity) => (t.dueAt ? new Date(t.dueAt).getTime() : Number.POSITIVE_INFINITY);

type Compare = (a: Entity, b: Entity) => number;

/** Each mode is a primary key followed by tiebreakers. Closed tasks always sink. */
export function taskComparator(sort: TaskSort, projectMap: Map<string, Project>): Compare {
  const projectKey = (t: Entity) =>
    (t.projectId ? projectMap.get(t.projectId)?.key : undefined) ?? "￿";
  const byStatus: Compare = (a, b) => statusRank(a) - statusRank(b);
  const byPriority: Compare = (a, b) => priorityRank(a) - priorityRank(b);
  const byProject: Compare = (a, b) => projectKey(a).localeCompare(projectKey(b));
  const byDue: Compare = (a, b) => {
    const da = dueTime(a);
    const db = dueTime(b);
    return da === db ? 0 : da < db ? -1 : 1;
  };
  const chains: Record<TaskSort, Compare[]> = {
    status: [byStatus, byPriority, byDue, byProject],
    priority: [byPriority, byStatus, byDue, byProject],
    project: [byProject, byStatus, byPriority, byDue],
    due: [byDue, byStatus, byPriority, byProject]
  };
  const chain = chains[sort];
  return (a, b) => {
    const closed = closedRank(a) - closedRank(b);
    if (closed !== 0) return closed;
    for (const cmp of chain) {
      const r = cmp(a, b);
      if (r !== 0) return r;
    }
    return 0;
  };
}

export function sortTasks(tasks: Entity[], sort: TaskSort, projectMap: Map<string, Project>): Entity[] {
  return tasks.slice().sort(taskComparator(sort, projectMap));
}

export type TaskBucket = {
  key: string;
  label: string;
  project?: Project;
  tasks: Entity[];
};

/** Group already-sorted tasks; groups come out in a fixed, meaningful order. */
export function groupTasks(
  tasks: Entity[],
  group: TaskGroup,
  projectMap: Map<string, Project>
): TaskBucket[] {
  if (group === "none") return tasks.length ? [{ key: "all", label: "", tasks }] : [];
  const buckets = new Map<string, TaskBucket>();
  for (const t of tasks) {
    let key: string;
    let label: string;
    let project: Project | undefined;
    if (group === "project") {
      project = t.projectId ? projectMap.get(t.projectId) : undefined;
      key = project?.id ?? "_none";
      label = project?.name ?? "No project";
    } else if (group === "status") {
      key = t.status;
      label = STATUS_GROUP_LABEL[t.status] ?? t.status;
    } else {
      key = t.priority;
      label = PRIORITY_GROUP_LABEL[t.priority] ?? t.priority;
    }
    const bucket = buckets.get(key);
    if (bucket) bucket.tasks.push(t);
    else buckets.set(key, { key, label, project, tasks: [t] });
  }
  const order = (b: TaskBucket): string | number => {
    if (group === "status") return STATUS_RANK[b.key] ?? 9;
    if (group === "priority") return PRIORITY_RANK[b.key] ?? 9;
    return b.project?.key ?? "￿";
  };
  return [...buckets.values()].sort((a, b) => {
    const oa = order(a);
    const ob = order(b);
    if (typeof oa === "number" && typeof ob === "number") return oa - ob;
    return String(oa).localeCompare(String(ob));
  });
}
