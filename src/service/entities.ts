import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { edges, entities, projects, type Entity, type EdgeKind } from "../db/schema.js";
import { normalizeDueAt } from "./dates.js";
import {
  advanceRecurrenceOnCompletion,
  clearModifiedExceptionFields,
  findRuleForTask,
  recurrenceMarker,
  upsertModifiedExceptionBaseline,
  type ContentFieldKey
} from "./recurrence.js";
import { recordRevision, type RevisionSnapshot } from "./revisions.js";
import type { Scope } from "./scope.js";
import type {
  CreateWorklogEntryInput,
  GetLinksInput,
  LinkInput,
  ListTagsInput,
  RecentInput,
  UpdateInput,
  WriteInput,
  WriteAttribution
} from "./types.js";

function clientError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/** Writes against a trashed entity are refused until it is restored. */
function inTrash(): Error {
  return clientError("entity is in trash; restore first", 409);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_PREFIX_RE = /^[0-9a-f-]{8,36}$/i;

function normalizeStatus(value: string): string {
  return value === "delayed" || value === "archived" ? "done" : value;
}

function inScope(scope: Scope) {
  return eq(entities.workspaceId, scope.workspaceId);
}

function activeProjectVisibility(scope: Scope) {
  return sql`(${entities.projectId} IS NULL OR ${entities.projectId} IN (
    SELECT id FROM projects
    WHERE status <> 'archived' AND workspace_id = ${scope.workspaceId}::uuid
  ))`;
}

/**
 * Resolve a full UUID or a unique prefix to an entity id. A full UUID passes
 * through without a lookup, so every caller still filters its own query by
 * scope; prefixes are matched only inside the scope.
 */
export async function resolveEntityId(
  scope: Scope,
  db: Database["db"],
  idOrPrefix: string
): Promise<string | null> {
  if (UUID_RE.test(idOrPrefix)) return idOrPrefix;
  if (!UUID_PREFIX_RE.test(idOrPrefix)) return null;

  const rows = (
    await db.execute<{ id: string }>(sql`
      SELECT id::text AS id
      FROM entities
      WHERE workspace_id = ${scope.workspaceId}::uuid
        AND id::text LIKE ${`${idOrPrefix.toLowerCase()}%`}
      LIMIT 2
    `)
  ).rows;

  if (rows.length === 1) return rows[0]!.id;
  if (rows.length > 1) throw new Error(`entity id prefix ${idOrPrefix} is ambiguous`);
  return null;
}

async function existsInScope(scope: Scope, db: Database["db"], id: string): Promise<boolean> {
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.id, id), inScope(scope)))
    .limit(1);
  return rows.length > 0;
}

/**
 * A parent link must never point back at the entity itself, directly or via
 * the parent's own parent. listChildren would otherwise list an entity as its
 * own child (the Letheia import did exactly this; see migration 0027).
 */
async function assertParentAllowed(
  scope: Scope,
  db: Database["db"],
  entityId: string,
  parentId: string
): Promise<void> {
  if (parentId === entityId) {
    throw clientError("an entity cannot be its own parent", 400);
  }
  const [parent] = await db
    .select({ parentId: entities.parentId })
    .from(entities)
    .where(and(eq(entities.id, parentId), inScope(scope)))
    .limit(1);
  if (!parent) throw clientError(`parent entity ${parentId} not found`, 404);
  if (parent.parentId === entityId) {
    throw clientError("parentId would create a parent cycle (the parent is already a child of this entity)", 400);
  }
}

export async function write(scope: Scope, db: Database["db"], input: WriteInput): Promise<Entity> {
  if (input.idempotencyKey) {
    const existing = await db
      .select()
      .from(entities)
      .where(and(eq(entities.idempotencyKey, input.idempotencyKey), inScope(scope)))
      .limit(1);
    if (existing.length > 0) return existing[0]!;
  }

  const status = normalizeStatus(input.status);
  if (input.completedAt != null && !(input.kind === "task" && status === "done")) {
    throw clientError("completedAt is only valid on a task created with status 'done'", 400);
  }
  if (input.parentId && !(await existsInScope(scope, db, input.parentId))) {
    throw clientError(`parent entity ${input.parentId} not found`, 404);
  }
  const [row] = await db
    .insert(entities)
    .values({
      workspaceId: scope.workspaceId,
      kind: input.kind,
      projectId: input.projectId ?? null,
      title: input.title ?? null,
      body: input.body,
      tags: input.tags,
      status,
      parentId: input.parentId ?? null,
      actorKind: input.actorKind,
      actorTokenId: input.actorTokenId ?? null,
      metadata: input.metadata,
      dueAt: normalizeDueAt(input.dueAt),
      priority: input.priority,
      pinned: input.pinned,
      // Mirror the PATCH path: a task created already-done gets a
      // completedAt stamp so the calendar renders it on the right day.
      // An explicit completedAt (backdated completion) wins over the stamp.
      // Non-task kinds never carry a stamp, even when created done.
      completedAt:
        input.completedAt ?? (input.kind === "task" && status === "done" ? new Date() : null),
      idempotencyKey: input.idempotencyKey ?? null
    })
    .returning();

  if (!row) throw new Error("entities insert returned no row");

  if (input.parentId) {
    await db
      .insert(edges)
      .values({ fromId: input.parentId, toId: row.id, kind: "parent_of" })
      .onConflictDoNothing();
  }
  return row;
}

/**
 * Append a worklog entry to a task or note. The entry inherits the parent's
 * projectId so project-scoped search/recent include it, but never gets a
 * KEY-SEQ number (the sequence trigger skips kind='worklog').
 */
export async function addWorklogEntry(
  scope: Scope,
  db: Database["db"],
  parentIdOrPrefix: string,
  input: CreateWorklogEntryInput,
  attribution: WriteAttribution = {}
): Promise<Entity> {
  const parent = await get(scope, db, parentIdOrPrefix);
  if (!parent) throw clientError(`entity ${parentIdOrPrefix} not found`, 404);
  if (parent.deletedAt) throw inTrash();
  if (parent.kind === "worklog") {
    throw clientError("worklog entries cannot be nested; log on the task itself", 400);
  }
  return write(scope, db, {
    kind: "worklog",
    projectId: parent.projectId,
    title: null,
    body: input.body,
    tags: [],
    status: "open",
    parentId: parent.id,
    actorKind: input.actorKind,
    actorTokenId: attribution.actorTokenId ?? null,
    metadata: input.metadata,
    dueAt: null,
    priority: "none",
    pinned: false,
    idempotencyKey: input.idempotencyKey
  });
}

/** Worklog entries for one parent entity, oldest first. */
export async function listWorklog(
  scope: Scope,
  db: Database["db"],
  parentIdOrPrefix: string,
  limit = 50
): Promise<Entity[]> {
  const entityId = await resolveEntityId(scope, db, parentIdOrPrefix);
  if (!entityId) return [];
  return db
    .select()
    .from(entities)
    .where(
      and(
        inScope(scope),
        eq(entities.parentId, entityId),
        eq(entities.kind, "worklog"),
        isNull(entities.deletedAt)
      )
    )
    .orderBy(entities.createdAt)
    .limit(limit);
}

const CONTENT_FIELDS: ContentFieldKey[] = ["title", "body", "tags", "priority"];

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

export async function update(
  scope: Scope,
  db: Database["db"],
  id: string,
  fields: UpdateInput,
  attribution: WriteAttribution = {}
): Promise<Entity> {
  const entityId = await resolveEntityId(scope, db, id);
  if (!entityId) throw new Error(`entity ${id} not found`);
  if (fields.parentId) await assertParentAllowed(scope, db, entityId, fields.parentId);

  const normalizedFields: UpdateInput = { ...fields };
  if (fields.status !== undefined) {
    normalizedFields.status = normalizeStatus(fields.status) as NonNullable<UpdateInput["status"]>;
  }
  const set: Record<string, unknown> = { ...normalizedFields, updatedAt: new Date() };
  // recurrenceScope is not a DB column — remove it before the UPDATE
  delete set.recurrenceScope;
  // bodyAppend is handled via a SQL expression below — remove it from the plain set
  delete set.bodyAppend;
  if (fields.dueAt !== undefined) {
    set.dueAt = normalizeDueAt(fields.dueAt);
  }

  // Determine which content fields are being changed and capture pre-edit snapshot
  // if recurrenceScope is set (we need preEditSnapshot for this-only writes).
  const changedContentFields = CONTENT_FIELDS.filter(
    (f) => f in fields && fields[f] !== undefined
  );
  if (fields.bodyAppend !== undefined && !changedContentFields.includes("body")) {
    changedContentFields.push("body");
  }
  // Which changed fields stay on this occurrence only. An explicit
  // recurrenceScope wins. Without one, body edits (meeting notes, appended
  // worklog) are occurrence-only so the next occurrence starts from the
  // series baseline, while title/tags/priority keep carrying forward.
  const thisOnlyFields =
    fields.recurrenceScope === "this"
      ? changedContentFields
      : fields.recurrenceScope === undefined
        ? changedContentFields.filter((f) => f === "body")
        : [];
  const futureFields = fields.recurrenceScope === "future" ? changedContentFields : [];
  const needsSnapshot = thisOnlyFields.length > 0;

  // Maintain completedAt as a side effect of status transitions. We need the
  // prior status to know whether this is an entry into or exit from 'done',
  // so do a tiny read first — cheaper than a CASE expression on UPDATE and
  // keeps the SQL the same shape as other writes.
  let enteredDone = false;
  let preEditSnapshot: Partial<Record<ContentFieldKey, unknown>> | null = null;
  let revision: RevisionSnapshot | null = null;

  {
    const prior = await db
      .select({
        kind: entities.kind,
        status: entities.status,
        title: entities.title,
        body: entities.body,
        tags: entities.tags,
        priority: entities.priority,
        deletedAt: entities.deletedAt
      })
      .from(entities)
      .where(and(eq(entities.id, entityId), inScope(scope)))
      .limit(1);
    if (!prior[0]) throw new Error(`entity ${id} not found`);
    if (prior[0].deletedAt) throw inTrash();
    if (prior[0].kind === "worklog") {
      throw clientError("worklog entries are append-only; add a new entry instead of editing", 400);
    }
    // Only touch completedAt when the status itself is changing — an unrelated
    // field update on an already-done task must not clear its completion stamp.
    // Only tasks earn a stamp; leaving-done always clears it, so a stray stamp
    // on a non-task heals itself.
    if (normalizedFields.status !== undefined) {
      const wasDone = prior[0].status === "done";
      const isDone = normalizedFields.status === "done";
      enteredDone = isDone && !wasDone;
      if (isDone && !wasDone) {
        if (prior[0].kind === "task") set.completedAt = new Date();
      } else if (!isDone && wasDone) set.completedAt = null;
    }
    // An explicit completedAt always wins over the automatic stamp, but only
    // makes sense on a task that is (or is becoming) done. Clearing it (null)
    // is allowed on any kind — removing a value must never be more restricted
    // than setting it, or a stray stamp would be impossible to undo.
    if (fields.completedAt !== undefined) {
      if (fields.completedAt !== null) {
        if (prior[0].kind !== "task") {
          throw clientError("completedAt applies to tasks only", 400);
        }
        const statusAfter = normalizedFields.status ?? prior[0].status;
        if (statusAfter !== "done") {
          throw clientError("completedAt can only be set on a done task", 400);
        }
      }
      set.completedAt = fields.completedAt;
    }
    if (needsSnapshot) {
      preEditSnapshot = {
        title: prior[0].title,
        body: prior[0].body,
        tags: prior[0].tags,
        priority: prior[0].priority
      };
    }
    // History: snapshot the content a human might want to audit, but only when
    // something in it actually changes. Due-date, pin and parent edits are not
    // content and leave no revision.
    const contentChanges =
      (fields.title !== undefined && fields.title !== prior[0].title) ||
      (fields.body !== undefined && fields.body !== prior[0].body) ||
      (fields.bodyAppend !== undefined && fields.bodyAppend !== "") ||
      (fields.tags !== undefined && !sameTags(fields.tags, prior[0].tags)) ||
      (fields.priority !== undefined && fields.priority !== prior[0].priority) ||
      (normalizedFields.status !== undefined && normalizedFields.status !== prior[0].status);
    if (contentChanges) {
      revision = {
        entityId,
        title: prior[0].title,
        body: prior[0].body,
        tags: prior[0].tags,
        priority: prior[0].priority,
        status: prior[0].status,
        actorKind: attribution.actorTokenId ? "agent" : "human",
        actorTokenId: attribution.actorTokenId ?? null
      };
    }
  }

  // Apply bodyAppend atomically: separate from existing content with a blank
  // line only when current body is non-empty; no read-back needed.
  if (fields.bodyAppend !== undefined) {
    set.body = sql`CASE WHEN ${entities.body} = '' THEN ${fields.bodyAppend} ELSE ${entities.body} || ${"\n\n"} || ${fields.bodyAppend} END`;
  }

  const snapshot = revision;
  const [row] = await db.transaction(async (tx) => {
    if (snapshot) await recordRevision(tx, snapshot);
    return tx
      .update(entities)
      .set(set)
      .where(and(eq(entities.id, entityId), inScope(scope)))
      .returning();
  });
  if (!row) throw new Error(`entity ${id} not found`);
  if (fields.parentId !== undefined && fields.parentId !== null) {
    await db
      .insert(edges)
      .values({ fromId: fields.parentId, toId: row.id, kind: "parent_of" })
      .onConflictDoNothing();
  }

  // Record occurrence-only edits (baseline snapshot) or clear them for
  // going-forward edits on recurring task occurrences.
  if (row.kind === "task" && (thisOnlyFields.length > 0 || futureFields.length > 0)) {
    const marker = recurrenceMarker(row);
    if (marker?.role === "occurrence" && marker.ruleId) {
      const rule = await findRuleForTask(db, row);
      if (rule) {
        if (thisOnlyFields.length > 0 && preEditSnapshot) {
          const preEdit = preEditSnapshot as Record<string, unknown>;
          const preEditValues = Object.fromEntries(
            thisOnlyFields.map((f) => [f, preEdit[f]])
          ) as { title?: string | null; body?: string; tags?: string[]; priority?: string };
          await upsertModifiedExceptionBaseline(db, rule, row, preEditValues, thisOnlyFields);
        }
        if (futureFields.length > 0) {
          await clearModifiedExceptionFields(db, rule, row, futureFields);
        }
      }
    }
  }

  if (enteredDone && row.kind === "task") {
    await advanceRecurrenceOnCompletion(db, row);
  }
  return row;
}

export async function listRelated(
  scope: Scope,
  db: Database["db"],
  parentId: string
): Promise<Entity[]> {
  const entityId = await resolveEntityId(scope, db, parentId);
  if (!entityId) return [];

  return db
    .select()
    .from(entities)
    .where(and(inScope(scope), eq(entities.parentId, entityId), isNull(entities.deletedAt)))
    .orderBy(desc(entities.createdAt));
}

/**
 * Record an explicit read of an entity. Called from the REST get-by-id and
 * get-by-key handlers (not from internal lookups) so access stats reflect
 * deliberate recalls; search gives frequently-recalled entities a light boost.
 */
export async function bumpAccess(scope: Scope, db: Database["db"], id: string): Promise<void> {
  await db
    .update(entities)
    .set({
      accessCount: sql`${entities.accessCount} + 1`,
      lastAccessedAt: new Date()
    })
    .where(and(eq(entities.id, id), inScope(scope)));
}

/**
 * Mark `oldIdOrPrefix` as superseded by `newId` (kind='supersedes' edge from
 * the replacement to the outdated entity). Superseded entities stay readable
 * but are downweighted in search.
 */
export async function markSuperseded(
  scope: Scope,
  db: Database["db"],
  newId: string,
  oldIdOrPrefix: string
): Promise<string> {
  // get() (not resolveEntityId) so a full-UUID reference to a deleted or
  // never-existing row still 404s instead of tripping the FK constraint.
  const old = await get(scope, db, oldIdOrPrefix);
  if (!old) throw clientError(`supersedes target ${oldIdOrPrefix} not found`, 404);
  if (old.id === newId) throw clientError("an entity cannot supersede itself", 400);
  await db
    .insert(edges)
    .values({ fromId: newId, toId: old.id, kind: "supersedes" })
    .onConflictDoNothing();
  return old.id;
}

/**
 * Direct lookups return trashed rows too, with `deletedAt` set, so a client
 * holding an id or KEY-SEQ can tell "in trash" apart from "gone". List and
 * search paths hide them; writes refuse them with 409 until restored.
 */
export async function get(scope: Scope, db: Database["db"], id: string): Promise<Entity | null> {
  const entityId = await resolveEntityId(scope, db, id);
  if (!entityId) return null;

  const rows = await db
    .select()
    .from(entities)
    .where(and(eq(entities.id, entityId), inScope(scope)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Look up an entity by its human-readable identifier — e.g. project key `DEMO`
 * + sequence id `12` resolves to the entity displayed as `DEMO-12`.
 */
export async function getByKey(
  scope: Scope,
  db: Database["db"],
  projectKey: string,
  sequenceId: number
): Promise<Entity | null> {
  const rows = await db
    .select({ e: entities })
    .from(entities)
    .innerJoin(projects, eq(entities.projectId, projects.id))
    .where(
      and(
        eq(projects.workspaceId, scope.workspaceId),
        eq(projects.key, projectKey),
        eq(entities.sequenceId, sequenceId)
      )
    )
    .limit(1);
  return rows[0]?.e ?? null;
}

/**
 * Soft delete: move the entity to the trash. Read paths hide trashed rows;
 * restore() brings them back, purge()/purgeExpired() hard-delete them.
 * Idempotent — re-deleting a trashed entity keeps its original trash time.
 */
export async function remove(scope: Scope, db: Database["db"], id: string): Promise<boolean> {
  const entityId = await resolveEntityId(scope, db, id);
  if (!entityId) return false;

  const res = await db
    .update(entities)
    .set({ deletedAt: new Date() })
    .where(and(eq(entities.id, entityId), inScope(scope), isNull(entities.deletedAt)))
    .returning({ id: entities.id });
  if (res.length > 0) return true;

  return existsInScope(scope, db, entityId);
}

/** Bring a trashed entity back. Returns null when the id resolves to nothing. */
export async function restore(scope: Scope, db: Database["db"], id: string): Promise<Entity | null> {
  const entityId = await resolveEntityId(scope, db, id);
  if (!entityId) return null;

  const [row] = await db
    .update(entities)
    .set({ deletedAt: null })
    .where(and(eq(entities.id, entityId), inScope(scope)))
    .returning();
  return row ?? null;
}

/**
 * Hard-delete a trashed entity ("delete forever"). Refuses to touch live
 * rows — an entity must go through the trash first.
 */
export async function purge(scope: Scope, db: Database["db"], id: string): Promise<boolean> {
  const entityId = await resolveEntityId(scope, db, id);
  if (!entityId) return false;

  const res = await db
    .delete(entities)
    .where(and(eq(entities.id, entityId), inScope(scope), isNotNull(entities.deletedAt)))
    .returning({ id: entities.id });
  return res.length > 0;
}

/** Trashed entities, most recently deleted first. */
export async function listTrash(scope: Scope, db: Database["db"], limit = 100): Promise<Entity[]> {
  return db
    .select()
    .from(entities)
    .where(and(inScope(scope), isNotNull(entities.deletedAt)))
    .orderBy(desc(entities.deletedAt))
    .limit(limit);
}

/**
 * Hard-delete trash older than the retention window across every workspace.
 * Daemon-level maintenance, hence no scope. Returns rows purged.
 */
export async function purgeExpired(db: Database["db"], retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const res = await db
    .delete(entities)
    .where(and(isNotNull(entities.deletedAt), sql`${entities.deletedAt} < ${cutoff}`))
    .returning({ id: entities.id });
  return res.length;
}

export async function recent(
  scope: Scope,
  db: Database["db"],
  input: RecentInput
): Promise<Entity[]> {
  const conds = [inScope(scope)];
  if (input.projectId) conds.push(eq(entities.projectId, input.projectId));
  else if (input.projectId === null) conds.push(isNull(entities.projectId));
  else conds.push(activeProjectVisibility(scope));
  conds.push(isNull(entities.deletedAt));
  if (input.since) conds.push(gte(entities.createdAt, input.since));
  if (input.kinds?.length) conds.push(inArray(entities.kind, input.kinds));
  const where = conds.length ? and(...conds) : undefined;
  return db
    .select()
    .from(entities)
    .where(where)
    .orderBy(desc(entities.createdAt))
    .limit(input.limit);
}

export async function link(
  scope: Scope,
  db: Database["db"],
  input: LinkInput
): Promise<{ fromId: string; toId: string; kind: string; created: boolean }> {
  if (input.fromId === input.toId) {
    throw clientError("an entity cannot be linked to itself", 400);
  }
  const endpoints = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(inArray(entities.id, [input.fromId, input.toId]), inScope(scope)));
  const found = new Set(endpoints.map((e) => e.id));
  for (const id of [input.fromId, input.toId]) {
    if (!found.has(id)) throw clientError(`entity ${id} not found`, 404);
  }
  const result = await db
    .insert(edges)
    .values({ fromId: input.fromId, toId: input.toId, kind: input.kind })
    .onConflictDoNothing()
    .returning();
  return {
    fromId: input.fromId,
    toId: input.toId,
    kind: input.kind,
    created: result.length > 0
  };
}

export async function listChildren(
  scope: Scope,
  db: Database["db"],
  parentId: string
): Promise<Entity[]> {
  // Children arrive via two linkage styles that both count: the entities.parentId
  // column (create_task / update_entity parentId) and explicit parent_of edges
  // (the link tool). Worklog entries also live on entities.parentId but are
  // not child work items, so they are excluded.
  const childIds = await db
    .select({ toId: edges.toId })
    .from(edges)
    .where(and(eq(edges.fromId, parentId), eq(edges.kind, "parent_of")));
  const linkage = childIds.length
    ? or(
        eq(entities.parentId, parentId),
        inArray(
          entities.id,
          childIds.map((c) => c.toId)
        )
      )!
    : eq(entities.parentId, parentId);
  return db
    .select()
    .from(entities)
    .where(and(inScope(scope), linkage, ne(entities.kind, "worklog"), isNull(entities.deletedAt)))
    .orderBy(asc(entities.createdAt));
}

export async function setBodyVec(
  db: Database["db"],
  id: string,
  vec: number[]
): Promise<void> {
  await db.execute(
    sql`UPDATE entities SET body_vec = ${`[${vec.join(",")}]`}::vector WHERE id = ${id}`
  );
}

export interface TagCount {
  tag: string;
  count: number;
}

/**
 * Return distinct tags across entities.tags (unnested) with their occurrence
 * counts, ordered by count DESC then tag ASC.  Pass projectId to scope to one
 * project; omit (or pass null/undefined) for workspace-wide results.
 */
export async function listTags(
  scope: Scope,
  db: Database["db"],
  input: ListTagsInput
): Promise<TagCount[]> {
  const projectFilter = input.projectId
    ? sql`AND project_id = ${input.projectId}::uuid`
    : sql``;

  const rows = await db.execute<{ tag: string; count: string }>(sql`
    SELECT tag, COUNT(*)::int AS count
    FROM entities, unnest(tags) AS tag
    WHERE deleted_at IS NULL
      AND workspace_id = ${scope.workspaceId}::uuid ${projectFilter}
    GROUP BY tag
    ORDER BY count DESC, tag ASC
  `);
  return rows.rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
}

export interface LinkResult {
  kind: EdgeKind;
  direction: "outgoing" | "incoming";
  entity: Entity;
}

/**
 * Read graph edges for an entity by kind and/or direction.
 * direction='outgoing' → edges where fromId = id
 * direction='incoming' → edges where toId = id
 * direction='both'     → union of both directions (default)
 * Returns the OTHER endpoint entity alongside the edge kind and direction.
 */
export async function getLinks(
  scope: Scope,
  db: Database["db"],
  input: GetLinksInput
): Promise<LinkResult[]> {
  const { id, kind, direction } = input;
  const results: LinkResult[] = [];

  if (direction === "outgoing" || direction === "both") {
    const kindCond = kind ? sql` AND e.kind = ${kind}` : sql``;
    const rows = await db.execute<{
      kind: string;
      to_id: string;
    }>(sql`
      SELECT e.kind, e.to_id
      FROM edges e
      WHERE e.from_id = ${id}::uuid${kindCond}
    `);
    if (rows.rows.length > 0) {
      const toIds = rows.rows.map((r) => r.to_id);
      const entityRows = await db
        .select()
        .from(entities)
        .where(and(inScope(scope), inArray(entities.id, toIds), isNull(entities.deletedAt)));
      const entityById = new Map(entityRows.map((en) => [en.id, en]));
      for (const row of rows.rows) {
        const entity = entityById.get(row.to_id);
        if (entity) {
          results.push({ kind: row.kind as EdgeKind, direction: "outgoing", entity });
        }
      }
    }
  }

  if (direction === "incoming" || direction === "both") {
    const kindCond = kind ? sql` AND e.kind = ${kind}` : sql``;
    const rows = await db.execute<{
      kind: string;
      from_id: string;
    }>(sql`
      SELECT e.kind, e.from_id
      FROM edges e
      WHERE e.to_id = ${id}::uuid${kindCond}
    `);
    if (rows.rows.length > 0) {
      const fromIds = rows.rows.map((r) => r.from_id);
      const entityRows = await db
        .select()
        .from(entities)
        .where(and(inScope(scope), inArray(entities.id, fromIds), isNull(entities.deletedAt)));
      const entityById = new Map(entityRows.map((en) => [en.id, en]));
      for (const row of rows.rows) {
        const entity = entityById.get(row.from_id);
        if (entity) {
          results.push({ kind: row.kind as EdgeKind, direction: "incoming", entity });
        }
      }
    }
  }

  return results;
}
