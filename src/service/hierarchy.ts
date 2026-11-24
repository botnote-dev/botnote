import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { toEntityRef, type EntityRef, type RefRow } from "./blockers.js";
import { entityInScope, type Scope } from "./scope.js";

/** Sub-task tallies for a parent task. Closed means done or rejected. */
export interface SubtaskCounts {
  total: number;
  closed: number;
  inProgress: number;
}

export interface Hierarchy {
  /** The entity this task hangs under, or null for a top-level task. */
  parent: EntityRef | null;
  /** Null when the task has no sub-tasks. */
  subtasks: SubtaskCounts | null;
}

export type WithHierarchy<T> = T & Hierarchy;

/**
 * Parent refs and sub-task counts for the given tasks, in two queries total.
 * Both linkage styles count, matching listChildren: the parentId column and
 * parent_of edges. When a task has both, parentId wins; among several edges,
 * the oldest wins. Deleted parents and deleted sub-tasks are ignored.
 */
export async function hierarchyFor(
  scope: Scope,
  db: Database["db"],
  taskIds: string[]
): Promise<Map<string, Hierarchy>> {
  const out = new Map<string, Hierarchy>();
  if (taskIds.length === 0) return out;
  for (const id of taskIds) out.set(id, { parent: null, subtasks: null });

  const idList = sql.join(
    taskIds.map((id) => sql`${id}::uuid`),
    sql`, `
  );

  const parents = await db.execute<RefRow & { child_id: string }>(sql`
    SELECT DISTINCT ON (x.child_id)
      x.child_id, p.id, p.kind, p.title, p.body, p.status, p.sequence_id, pr.key AS project_key
    FROM (
      SELECT c.id AS child_id, c.parent_id, 0 AS via, c.created_at AS linked_at
      FROM entities c
      WHERE c.id IN (${idList}) AND c.parent_id IS NOT NULL
      UNION ALL
      SELECT e.to_id, e.from_id, 1, e.created_at
      FROM edges e
      WHERE e.kind = 'parent_of' AND e.to_id IN (${idList})
    ) x
    JOIN entities p ON p.id = x.parent_id
    LEFT JOIN projects pr ON pr.id = p.project_id
    WHERE ${entityInScope(scope, sql`p`)}
      AND p.deleted_at IS NULL
    ORDER BY x.child_id, x.via, x.linked_at
  `);
  for (const r of parents.rows) out.get(r.child_id)!.parent = toEntityRef(r);

  const counts = await db.execute<{
    parent_id: string;
    total: number;
    closed: number;
    in_progress: number;
  }>(sql`
    SELECT l.parent_id,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE c.status IN ('done', 'rejected'))::int AS closed,
      COUNT(*) FILTER (WHERE c.status = 'in_progress')::int AS in_progress
    FROM (
      SELECT parent_id, id AS child_id
      FROM entities
      WHERE parent_id IN (${idList})
      UNION
      SELECT from_id, to_id
      FROM edges
      WHERE kind = 'parent_of' AND from_id IN (${idList})
    ) l
    JOIN entities c ON c.id = l.child_id
    WHERE c.kind = 'task'
      AND ${entityInScope(scope, sql`c`)}
      AND c.deleted_at IS NULL
    GROUP BY l.parent_id
  `);
  for (const r of counts.rows) {
    out.get(r.parent_id)!.subtasks = {
      total: r.total,
      closed: r.closed,
      inProgress: r.in_progress
    };
  }
  return out;
}

/**
 * Decorate rows with additive `parent` and `subtasks` fields. Only task rows
 * are looked up; other kinds pass through unchanged.
 */
export async function attachHierarchy<T extends { id: string; kind: string }>(
  scope: Scope,
  db: Database["db"],
  rows: T[]
): Promise<Array<T | WithHierarchy<T>>> {
  const hierarchy = await hierarchyFor(
    scope,
    db,
    rows.filter((r) => r.kind === "task").map((r) => r.id)
  );
  return rows.map((r) => {
    const h = hierarchy.get(r.id);
    return h ? { ...r, ...h } : r;
  });
}
