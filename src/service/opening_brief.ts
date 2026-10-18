import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { entities, type Entity, type Project } from "../db/schema.js";
import { blockersFor, type Blocker } from "./blockers.js";
import { getProject } from "./projects.js";
import type { Scope } from "./scope.js";
import { tokenLabels } from "./tokens.js";
import { DEFAULT_WORKSPACE_TIMEZONE, getWorkspaceSettings } from "./workspace_settings.js";
import type { OpeningBriefInput } from "./types.js";

export interface OpeningBrief {
  project: Project | null;
  agentsMd: string;
  pinnedNotes: Entity[];
  openTasks: Entity[];
  /** Latest worklog entry per in_progress task, so a resuming session sees
   *  where the previous one stopped. */
  latestWorklog: Entity[];
  /** Open task id → unfinished tasks that `blocks` it. Absent when unblocked. */
  blockedBy: Record<string, Blocker[]>;
  recent: Entity[];
  /** Token id -> token name for the authors of latestWorklog, so the
   *  worklog line can say who wrote it. */
  actorLabels: Record<string, string>;
  generatedAt: Date;
  timezone: string;
}

export async function openingBrief(
  scope: Scope,
  db: Database["db"],
  input: OpeningBriefInput
): Promise<OpeningBrief> {
  const project = input.projectId ? await getProject(scope, db, input.projectId) : null;

  const inWorkspace = eq(entities.workspaceId, scope.workspaceId);
  const projectFilter = and(
    inWorkspace,
    input.projectId ? eq(entities.projectId, input.projectId) : isNull(entities.projectId)
  )!;

  const [settings, pinnedNotes, openTasks, recentRows] = await Promise.all([
    getWorkspaceSettings(scope, db).catch(() => ({ timezone: DEFAULT_WORKSPACE_TIMEZONE })),
    db
      .select()
      .from(entities)
      .where(and(projectFilter, eq(entities.pinned, true), isNull(entities.deletedAt)))
      .orderBy(desc(entities.updatedAt))
      .limit(20),
    db
      .select()
      .from(entities)
      .where(
        and(
          projectFilter,
          eq(entities.kind, "task"),
          inArray(entities.status, ["open", "in_progress"]),
          isNull(entities.deletedAt)
        )
      )
      // in_progress first (that's what a resuming session needs), then by
      // urgency: earliest due date (overdue sorts first naturally), then
      // priority, then recency. Tasks without a due date rank after dated ones.
      .orderBy(
        sql`CASE WHEN ${entities.status} = 'in_progress' THEN 0 ELSE 1 END`,
        sql`CASE WHEN ${entities.dueAt} IS NULL THEN 1 ELSE 0 END`,
        asc(entities.dueAt),
        sql`CASE ${entities.priority} WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
        desc(entities.createdAt)
      )
      .limit(20),
    db
      .select()
      .from(entities)
      .where(and(projectFilter, isNull(entities.deletedAt)))
      .orderBy(desc(entities.createdAt))
      .limit(input.recentLimit)
  ]);

  const inProgressIds = openTasks
    .filter((t) => t.status === "in_progress")
    .map((t) => t.id);
  const blockedBy = Object.fromEntries(
    await blockersFor(
      scope,
      db,
      openTasks.map((t) => t.id)
    )
  );
  let latestWorklog: Entity[] = [];
  if (inProgressIds.length > 0) {
    const rows = await db
      .select()
      .from(entities)
      .where(
        and(
          inWorkspace,
          eq(entities.kind, "worklog"),
          inArray(entities.parentId, inProgressIds),
          isNull(entities.deletedAt)
        )
      )
      .orderBy(desc(entities.createdAt))
      .limit(inProgressIds.length * 10);
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.parentId || seen.has(row.parentId)) continue;
      seen.add(row.parentId);
      latestWorklog.push(row);
    }
  }

  const actorLabels: Record<string, string> = {};
  const authorTokenIds = latestWorklog.map((w) => w.actorTokenId).filter((id): id is string => !!id);
  if (authorTokenIds.length > 0) {
    const labels = await tokenLabels(scope, db);
    for (const id of authorTokenIds) {
      const name = labels.get(id);
      if (name) actorLabels[id] = name;
    }
  }

  return {
    project,
    agentsMd: project?.agentsMd ?? "",
    pinnedNotes,
    openTasks,
    latestWorklog,
    blockedBy,
    recent: recentRows,
    actorLabels,
    generatedAt: new Date(),
    timezone: settings.timezone
  };
}

/**
 * Human-readable reference: KEY-SEQ (e.g. BOT-55) when the project key is
 * known, otherwise kind/uuid-prefix. Both forms resolve as entity refs.
 */
function refFor(e: Entity, projectKey: string | null): string {
  if (projectKey && e.sequenceId != null) return `${projectKey}-${e.sequenceId}`;
  return `${e.kind}/${e.id.slice(0, 8)}`;
}

// Character budgets for pinned-note bodies. Pinned notes are injected into
// every session start, so an unbounded dump can eat a large slice of the
// agent's context window. Chars ≈ tokens × 4.
const PINNED_NOTE_CHAR_BUDGET = 2000;
const PINNED_TOTAL_CHAR_BUDGET = 8000;

function titleFor(e: Entity): string {
  if (e.title && e.title.trim()) return e.title;
  const firstLine = e.body.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (firstLine) return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
  return "(untitled)";
}

export function formatOpeningBrief(brief: OpeningBrief): string {
  const lines: string[] = [];
  const projectKey = brief.project?.key ?? null;
  if (brief.project) {
    lines.push(`# Project: ${brief.project.key} — ${brief.project.name}`);
  } else {
    lines.push(`# Workspace`);
  }
  lines.push("");
  // One-line temporal context so agents can resolve relative dates immediately.
  lines.push(`_Server time: ${brief.generatedAt.toISOString()} · timezone: ${brief.timezone}_`);
  lines.push("");

  if (brief.agentsMd) {
    lines.push("## AGENTS.md");
    lines.push(brief.agentsMd.trim());
    lines.push("");
  }

  if (brief.pinnedNotes.length) {
    lines.push(`## Pinned Notes (${brief.pinnedNotes.length})`);
    lines.push("_These are pinned by the user as always-relevant context for this project. Read them before acting._");
    lines.push("");
    let remaining = PINNED_TOTAL_CHAR_BUDGET;
    for (const n of brief.pinnedNotes) {
      const ref = refFor(n, projectKey);
      const body = n.body.trim();
      if (remaining <= 0) {
        lines.push(`### 📌 ${titleFor(n)}`);
        lines.push(`_[body omitted — pinned budget spent; fetch ${ref} to read it]_`);
        lines.push("");
        continue;
      }
      lines.push(`### 📌 ${titleFor(n)}`);
      if (body) {
        const cap = Math.min(PINNED_NOTE_CHAR_BUDGET, remaining);
        if (body.length > cap) {
          lines.push(body.slice(0, cap));
          lines.push(`_[truncated — fetch ${ref} for the full note]_`);
          remaining -= cap;
        } else {
          lines.push(body);
          remaining -= body.length;
        }
      }
      lines.push("");
    }
  }

  // Blocked tasks sink below unblocked ones within their group: a resuming
  // agent should not pick up work whose blocker is still open.
  const blockersOf = (t: Entity): Blocker[] => brief.blockedBy?.[t.id] ?? [];
  const unblockedFirst = (rows: Entity[]): Entity[] => [
    ...rows.filter((t) => blockersOf(t).length === 0),
    ...rows.filter((t) => blockersOf(t).length > 0)
  ];
  const inProgress = unblockedFirst(brief.openTasks.filter((t) => t.status === "in_progress"));
  const openOnly = unblockedFirst(brief.openTasks.filter((t) => t.status !== "in_progress"));

  const now = brief.generatedAt.getTime();
  const taskLine = (t: Entity): string => {
    const parts = [`- [${refFor(t, projectKey)}] ${titleFor(t)}`];
    if (t.dueAt) {
      const day = t.dueAt.toISOString().slice(0, 10);
      parts.push(t.dueAt.getTime() < now ? `(OVERDUE ${day})` : `(due ${day})`);
    }
    if (t.priority && t.priority !== "none") parts.push(`!${t.priority}`);
    if (t.tags.length) parts.push(`[${t.tags.join(", ")}]`);
    const blockers = blockersOf(t);
    if (blockers.length) parts.push(`(BLOCKED by ${blockers.map((b) => b.ref).join(", ")})`);
    return parts.join(" ");
  };

  if (inProgress.length) {
    const worklogByTask = new Map(
      brief.latestWorklog.map((w) => [w.parentId as string, w])
    );
    lines.push(`## In Progress (${inProgress.length})`);
    lines.push("_Work already started. Check these before picking up anything new._");
    for (const t of inProgress) {
      lines.push(taskLine(t));
      const log = worklogByTask.get(t.id);
      if (log) {
        const when = log.createdAt.toISOString().slice(0, 16).replace("T", " ");
        const who = (log.actorTokenId && brief.actorLabels[log.actorTokenId]) || log.actorKind;
        const excerpt = log.body.trim().replace(/\s+/g, " ");
        lines.push(
          `  ↳ last log ${when} by ${who}: ${excerpt.length > 300 ? `${excerpt.slice(0, 300)}…` : excerpt}`
        );
      }
    }
    lines.push("");
  }

  if (openOnly.length) {
    lines.push(`## Open Tasks (${openOnly.length})`);
    for (const t of openOnly) lines.push(taskLine(t));
    lines.push("");
  }

  if (brief.recent.length) {
    lines.push(`## Recent Activity (${brief.recent.length})`);
    for (const r of brief.recent) {
      const when = r.createdAt.toISOString().slice(0, 16).replace("T", " ");
      lines.push(`- ${when} · ${refFor(r, projectKey)} · ${titleFor(r)}`);
    }
    lines.push("");
  }

  lines.push(
    "_Reminders: when discussion turns into work, or new out-of-scope work appears mid-task, propose creating a task (confirm before creating; keep each task ≤1 focused session). Refer to entities by KEY-SEQ (e.g. BOT-55), never UUID._"
  );
  lines.push("");
  lines.push(
    "_Feedback: if botnote ITSELF misbehaves or gets in your way this session — a bug, a missing capability, an awkward workflow, a product idea — file it with submit_feedback before wrapping up (check list_feedback first to avoid duplicates)._"
  );
  lines.push("");
  lines.push(`_Generated at ${brief.generatedAt.toISOString()}_`);
  return lines.join("\n");
}
