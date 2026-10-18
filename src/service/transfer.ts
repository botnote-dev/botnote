import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import {
  ACTOR_KINDS,
  EDGE_KINDS,
  VECTOR_DIMENSIONS,
  edges,
  entities,
  entityRevisions,
  projects,
  recurrenceExceptions,
  recurrenceRules,
  tokens,
  workspaceSettings,
  workspaces
} from "../db/schema.js";
import { VERSION } from "../version.js";
import type { Scope } from "./scope.js";
import { EntityKindEnum, Uuid } from "./types.js";

/**
 * JSON Lines workspace dump. Line 1 is the header; every later line is one
 * record whose `type` names the table it came from. Records are written in
 * dependency order (projects before entities before edges, ...) so the
 * importer can stream them without buffering the whole file.
 *
 * Bump FORMAT_VERSION only for changes an older importer could not read.
 * Adding optional fields is not such a change.
 */
export const FORMAT_VERSION = 1;

export const RECORD_TYPES = [
  "project",
  "entity",
  "edge",
  "recurrence_rule",
  "recurrence_exception",
  "entity_revision",
  "settings"
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

const BATCH = 500;
const MAX_REPORTED_CONFLICTS = 100;

export interface ExportHeader {
  type: "header";
  formatVersion: number;
  botnoteVersion: string;
  exportedAt: string;
  workspace: { id: string; slug: string; name: string };
  includesVectors: boolean;
}

export interface ExportOptions {
  /** Include `bodyVec` on entities. Off by default: vectors are large and the importer re-embeds. */
  includeVectors?: boolean;
}

function clientError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

function line(type: RecordType, row: Record<string, unknown>): string {
  return `${JSON.stringify({ type, ...row })}\n`;
}

async function* pages<T>(
  fetch: (after: string | null) => Promise<T[]>,
  cursorOf: (row: T) => string
): AsyncGenerator<T[]> {
  let after: string | null = null;
  for (;;) {
    const rows = await fetch(after);
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < BATCH) return;
    after = cursorOf(rows[rows.length - 1]!);
  }
}

export async function* exportWorkspace(
  scope: Scope,
  db: Database["db"],
  opts: ExportOptions = {}
): AsyncGenerator<string> {
  const wsId = scope.workspaceId;
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, wsId)).limit(1);
  if (!ws) throw clientError(`workspace ${wsId} not found`, 404);

  const header: ExportHeader = {
    type: "header",
    formatVersion: FORMAT_VERSION,
    botnoteVersion: VERSION,
    exportedAt: new Date().toISOString(),
    workspace: { id: ws.id, slug: ws.slug, name: ws.name },
    includesVectors: Boolean(opts.includeVectors)
  };
  yield `${JSON.stringify(header)}\n`;

  for await (const rows of pages(
    (after) =>
      db
        .select()
        .from(projects)
        .where(and(eq(projects.workspaceId, wsId), after ? gt(projects.id, after) : undefined))
        .orderBy(asc(projects.id))
        .limit(BATCH),
    (r) => r.id
  )) {
    for (const { workspaceId: _ws, ...p } of rows) yield line("project", p);
  }

  for await (const rows of pages(
    (after) =>
      db
        .select()
        .from(entities)
        .where(and(eq(entities.workspaceId, wsId), after ? gt(entities.id, after) : undefined))
        .orderBy(asc(entities.id))
        .limit(BATCH),
    (r) => r.id
  )) {
    for (const { workspaceId: _ws, bodyTsv: _tsv, bodyVec, ...e } of rows) {
      yield line("entity", opts.includeVectors && bodyVec ? { ...e, bodyVec } : e);
    }
  }

  type EdgeRow = { from_id: string; to_id: string; kind: string; created_at: Date };
  let edgeCursor: { fromId: string; toId: string; kind: string } | null = null;
  for (;;) {
    const rows: EdgeRow[] = (
      await db.execute<EdgeRow>(sql`
        SELECT e.from_id, e.to_id, e.kind, e.created_at
        FROM edges e
        JOIN entities f ON f.id = e.from_id
        WHERE f.workspace_id = ${wsId}::uuid
          ${
            edgeCursor
              ? sql`AND (e.from_id, e.to_id, e.kind) > (${edgeCursor.fromId}::uuid, ${edgeCursor.toId}::uuid, ${edgeCursor.kind})`
              : sql``
          }
        ORDER BY e.from_id, e.to_id, e.kind
        LIMIT ${BATCH}
      `)
    ).rows;
    for (const r of rows) {
      yield line("edge", { fromId: r.from_id, toId: r.to_id, kind: r.kind, createdAt: new Date(r.created_at) });
    }
    if (rows.length < BATCH) break;
    const last: EdgeRow = rows[rows.length - 1]!;
    edgeCursor = { fromId: last.from_id, toId: last.to_id, kind: last.kind };
  }

  for await (const rows of pages(
    (after) =>
      db
        .select()
        .from(recurrenceRules)
        .where(
          and(eq(recurrenceRules.workspaceId, wsId), after ? gt(recurrenceRules.id, after) : undefined)
        )
        .orderBy(asc(recurrenceRules.id))
        .limit(BATCH),
    (r) => r.id
  )) {
    for (const { workspaceId: _ws, ...r } of rows) yield line("recurrence_rule", r);
  }

  for await (const rows of pages(
    async (after) =>
      (
        await db
          .select({ ex: recurrenceExceptions })
          .from(recurrenceExceptions)
          .innerJoin(recurrenceRules, eq(recurrenceRules.id, recurrenceExceptions.ruleId))
          .where(
            and(
              eq(recurrenceRules.workspaceId, wsId),
              after ? gt(recurrenceExceptions.id, after) : undefined
            )
          )
          .orderBy(asc(recurrenceExceptions.id))
          .limit(BATCH)
      ).map((r) => r.ex),
    (r) => r.id
  )) {
    for (const r of rows) yield line("recurrence_exception", r);
  }

  for await (const rows of pages(
    async (after) =>
      (
        await db
          .select({ rev: entityRevisions })
          .from(entityRevisions)
          .innerJoin(entities, eq(entities.id, entityRevisions.entityId))
          .where(and(eq(entities.workspaceId, wsId), after ? gt(entityRevisions.id, after) : undefined))
          .orderBy(asc(entityRevisions.id))
          .limit(BATCH)
      ).map((r) => r.rev),
    (r) => r.id
  )) {
    for (const r of rows) yield line("entity_revision", r);
  }

  const [settings] = await db
    .select({ timezone: workspaceSettings.timezone })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, wsId))
    .limit(1);
  if (settings) yield line("settings", { timezone: settings.timezone });
}

// ----- import -----

const Iso = z.coerce.date();
const IsoNull = z.coerce.date().nullable().default(null);
const UuidNull = Uuid.nullable().default(null);

const HeaderRecord = z.object({
  type: z.literal("header"),
  formatVersion: z.number().int().positive(),
  botnoteVersion: z.string().default("unknown"),
  exportedAt: z.string().default(""),
  workspace: z
    .object({ id: z.string(), slug: z.string().default(""), name: z.string().default("") })
    .default({ id: "", slug: "", name: "" }),
  includesVectors: z.boolean().default(false)
});

const ProjectRecord = z.object({
  id: Uuid,
  key: z.string().min(1),
  name: z.string().default(""),
  status: z.string().default("active"),
  color: z.string().default("#5e6ad2"),
  icon: z.string().default("circle"),
  agentsMd: z.string().default(""),
  archivedAt: IsoNull,
  nextSeq: z.number().int().min(1).default(1),
  createdAt: Iso,
  updatedAt: Iso
});

const EntityRecord = z.object({
  id: Uuid,
  projectId: UuidNull,
  kind: EntityKindEnum,
  title: z.string().nullable().default(null),
  body: z.string().default(""),
  tags: z.array(z.string()).default([]),
  status: z.string().default("open"),
  actorKind: z.enum(ACTOR_KINDS).default("human"),
  actorTokenId: UuidNull,
  idempotencyKey: z.string().nullable().default(null),
  parentId: UuidNull,
  bodyVec: z.array(z.number()).nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
  dueAt: IsoNull,
  priority: z.string().default("none"),
  sequenceId: z.number().int().nullable().default(null),
  pinned: z.boolean().default(false),
  completedAt: IsoNull,
  lastAccessedAt: IsoNull,
  accessCount: z.number().int().default(0),
  deletedAt: IsoNull,
  createdAt: Iso,
  updatedAt: Iso
});

const EdgeRecord = z.object({
  fromId: Uuid,
  toId: Uuid,
  kind: z.enum(EDGE_KINDS),
  createdAt: Iso
});

const RuleRecord = z.object({
  id: Uuid,
  seriesId: Uuid,
  currentOccurrenceId: UuidNull,
  enabled: z.boolean().default(true),
  rrule: z.string().min(1),
  dtstart: Iso,
  timezone: z.string().default("UTC"),
  allDay: z.boolean().default(true),
  anchor: z.string().default("scheduled"),
  maxInstancesAhead: z.number().int().default(1),
  generatedCount: z.number().int().default(1),
  lastOccurrenceAt: IsoNull,
  nextOccurrenceAt: IsoNull,
  endedAt: IsoNull,
  createdAt: Iso,
  updatedAt: Iso
});

const ExceptionRecord = z.object({
  id: Uuid,
  ruleId: Uuid,
  occurrenceAt: Iso,
  action: z.string(),
  entityId: UuidNull,
  metadata: z.record(z.unknown()).default({}),
  createdAt: Iso
});

const RevisionRecord = z.object({
  id: Uuid,
  entityId: Uuid,
  revision: z.number().int().positive(),
  title: z.string().nullable().default(null),
  body: z.string().default(""),
  tags: z.array(z.string()).default([]),
  priority: z.string().default("none"),
  status: z.string().default("open"),
  actorKind: z.enum(ACTOR_KINDS).default("human"),
  actorTokenId: UuidNull,
  createdAt: Iso
});

const SettingsRecord = z.object({
  timezone: z.string().min(1).max(80)
});

export interface ImportCounts {
  imported: number;
  skipped: number;
  conflicts: number;
}

export interface ImportConflict {
  type: RecordType;
  id: string;
  reason: string;
}

export interface ImportReport {
  formatVersion: number;
  botnoteVersion: string;
  exportedAt: string;
  sourceWorkspace: { id: string; slug: string; name: string };
  counts: Record<RecordType, ImportCounts>;
  /** First MAX_REPORTED_CONFLICTS conflicts; `conflictsTotal` has the full count. */
  conflicts: ImportConflict[];
  conflictsTotal: number;
  /** Entities inserted without a vector; run the embedding backfill to search them. */
  entitiesWithoutVector: number;
}

type Db = Database["db"];

async function existingRows(
  db: Db,
  table: "projects" | "entities" | "recurrence_rules",
  ids: string[]
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = (
    await db.execute<{ id: string; ws: string }>(sql`
      SELECT id::text AS id, workspace_id::text AS ws
      FROM ${sql.identifier(table)}
      WHERE id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `
      )})
    `)
  ).rows;
  return new Map(rows.map((r) => [r.id, r.ws]));
}

async function existingIds(
  db: Db,
  table: "recurrence_exceptions" | "entity_revisions",
  ids: string[]
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = (
    await db.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM ${sql.identifier(table)}
      WHERE id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `
      )})
    `)
  ).rows;
  return new Set(rows.map((r) => r.id));
}

async function entityIdsInScope(scope: Scope, db: Db, ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.workspaceId, scope.workspaceId), inArray(entities.id, unique)));
  return new Set(rows.map((r) => r.id));
}

async function tokenIdsInScope(scope: Scope, db: Db, ids: Array<string | null>): Promise<Set<string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Set();
  const rows = await db
    .select({ id: tokens.id })
    .from(tokens)
    .where(and(eq(tokens.workspaceId, scope.workspaceId), inArray(tokens.id, unique)));
  return new Set(rows.map((r) => r.id));
}

class Importer {
  readonly counts = Object.fromEntries(
    RECORD_TYPES.map((t) => [t, { imported: 0, skipped: 0, conflicts: 0 }])
  ) as Record<RecordType, ImportCounts>;
  readonly conflicts: ImportConflict[] = [];
  conflictsTotal = 0;
  entitiesWithoutVector = 0;
  private readonly importedProjectStamps = new Map<string, Date>();

  constructor(
    private readonly scope: Scope,
    private readonly db: Db
  ) {}

  private conflict(type: RecordType, id: string, reason: string): void {
    this.counts[type].conflicts++;
    this.conflictsTotal++;
    if (this.conflicts.length < MAX_REPORTED_CONFLICTS) this.conflicts.push({ type, id, reason });
  }

  /** Rows that exist in this workspace are skipped; rows owned elsewhere are conflicts. */
  private async partitionExisting<T extends { id: string }>(
    type: RecordType,
    table: "projects" | "entities" | "recurrence_rules",
    rows: T[]
  ): Promise<T[]> {
    const existing = await existingRows(
      this.db,
      table,
      rows.map((r) => r.id)
    );
    return rows.filter((r) => {
      const ws = existing.get(r.id);
      if (ws === undefined) return true;
      if (ws === this.scope.workspaceId) this.counts[type].skipped++;
      else this.conflict(type, r.id, "id already exists in another workspace");
      return false;
    });
  }

  private settle(type: RecordType, attempted: string[], inserted: Set<string>, reason: string): void {
    for (const id of attempted) {
      if (inserted.has(id)) this.counts[type].imported++;
      else this.conflict(type, id, reason);
    }
  }

  async projects(rows: z.infer<typeof ProjectRecord>[]): Promise<void> {
    let fresh = await this.partitionExisting("project", "projects", rows);
    if (fresh.length === 0) return;
    const taken = await this.db
      .select({ id: projects.id, key: projects.key })
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, this.scope.workspaceId),
          inArray(
            projects.key,
            fresh.map((p) => p.key)
          )
        )
      );
    const takenKeys = new Map(taken.map((p) => [p.key, p.id]));
    fresh = fresh.filter((p) => {
      const owner = takenKeys.get(p.key);
      if (!owner) return true;
      this.conflict("project", p.id, `key ${p.key} already belongs to project ${owner}`);
      return false;
    });
    if (fresh.length === 0) return;
    const inserted = await this.db
      .insert(projects)
      .values(fresh.map((p) => ({ ...p, workspaceId: this.scope.workspaceId })))
      .onConflictDoNothing()
      .returning({ id: projects.id });
    const insertedIds = new Set(inserted.map((r) => r.id));
    for (const p of fresh) if (insertedIds.has(p.id)) this.importedProjectStamps.set(p.id, p.updatedAt);
    this.settle("project", fresh.map((p) => p.id), insertedIds, "rejected by a unique constraint");
  }

  /**
   * The KEY-SEQ trigger bumps projects.next_seq for every imported entity,
   * and that UPDATE stamps updated_at. Put the exported timestamps back.
   */
  async finish(): Promise<void> {
    const stamps = [...this.importedProjectStamps];
    for (let i = 0; i < stamps.length; i += BATCH) {
      const chunk = stamps.slice(i, i + BATCH);
      await this.db.execute(sql`
        UPDATE projects p
        SET updated_at = v.ts
        FROM (VALUES ${sql.join(
          chunk.map(([id, ts]) => sql`(${id}::uuid, ${ts.toISOString()}::timestamptz)`),
          sql`, `
        )}) AS v(id, ts)
        WHERE p.id = v.id AND p.updated_at <> v.ts
      `);
    }
  }

  async entities(rows: z.infer<typeof EntityRecord>[]): Promise<void> {
    let fresh = await this.partitionExisting("entity", "entities", rows);
    if (fresh.length === 0) return;
    const projectIds = [...new Set(fresh.map((e) => e.projectId).filter((id): id is string => Boolean(id)))];
    const knownProjects = new Set(
      projectIds.length === 0
        ? []
        : (
            await this.db
              .select({ id: projects.id })
              .from(projects)
              .where(and(eq(projects.workspaceId, this.scope.workspaceId), inArray(projects.id, projectIds)))
          ).map((p) => p.id)
    );
    fresh = fresh.filter((e) => {
      if (!e.projectId || knownProjects.has(e.projectId)) return true;
      this.conflict("entity", e.id, `project ${e.projectId} is not in the target workspace`);
      return false;
    });
    if (fresh.length === 0) return;
    const knownTokens = await tokenIdsInScope(
      this.scope,
      this.db,
      fresh.map((e) => e.actorTokenId)
    );
    const values = fresh.map(({ bodyVec, ...e }) => {
      const vec = bodyVec && bodyVec.length === VECTOR_DIMENSIONS ? bodyVec : null;
      if (!vec) this.entitiesWithoutVector++;
      return {
        ...e,
        workspaceId: this.scope.workspaceId,
        actorTokenId: e.actorTokenId && knownTokens.has(e.actorTokenId) ? e.actorTokenId : null,
        bodyVec: vec
      };
    });
    const inserted = await this.db
      .insert(entities)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: entities.id });
    const insertedIds = new Set(inserted.map((r) => r.id));
    this.entitiesWithoutVector -= values.filter((v) => !v.bodyVec && !insertedIds.has(v.id)).length;
    this.settle(
      "entity",
      fresh.map((e) => e.id),
      insertedIds,
      "rejected by a unique constraint (idempotency key or KEY-SEQ already taken)"
    );
  }

  async edges(rows: z.infer<typeof EdgeRecord>[]): Promise<void> {
    const known = await entityIdsInScope(
      this.scope,
      this.db,
      rows.flatMap((e) => [e.fromId, e.toId])
    );
    const fresh = rows.filter((e) => {
      if (known.has(e.fromId) && known.has(e.toId)) return true;
      this.conflict("edge", `${e.fromId}->${e.toId}:${e.kind}`, "an endpoint is not in the target workspace");
      return false;
    });
    if (fresh.length === 0) return;
    const inserted = await this.db
      .insert(edges)
      .values(fresh)
      .onConflictDoNothing()
      .returning({ fromId: edges.fromId, toId: edges.toId, kind: edges.kind });
    this.counts.edge.imported += inserted.length;
    this.counts.edge.skipped += fresh.length - inserted.length;
  }

  async rules(rows: z.infer<typeof RuleRecord>[]): Promise<void> {
    let fresh = await this.partitionExisting("recurrence_rule", "recurrence_rules", rows);
    if (fresh.length === 0) return;
    const known = await entityIdsInScope(
      this.scope,
      this.db,
      fresh.flatMap((r) => [r.seriesId, ...(r.currentOccurrenceId ? [r.currentOccurrenceId] : [])])
    );
    fresh = fresh.filter((r) => {
      if (known.has(r.seriesId)) return true;
      this.conflict("recurrence_rule", r.id, `series task ${r.seriesId} is not in the target workspace`);
      return false;
    });
    if (fresh.length === 0) return;
    const inserted = await this.db
      .insert(recurrenceRules)
      .values(
        fresh.map((r) => ({
          ...r,
          workspaceId: this.scope.workspaceId,
          currentOccurrenceId:
            r.currentOccurrenceId && known.has(r.currentOccurrenceId) ? r.currentOccurrenceId : null
        }))
      )
      .onConflictDoNothing()
      .returning({ id: recurrenceRules.id });
    this.settle(
      "recurrence_rule",
      fresh.map((r) => r.id),
      new Set(inserted.map((r) => r.id)),
      "series already has an enabled rule"
    );
  }

  async exceptions(rows: z.infer<typeof ExceptionRecord>[]): Promise<void> {
    const existing = await existingIds(
      this.db,
      "recurrence_exceptions",
      rows.map((r) => r.id)
    );
    let fresh = rows.filter((r) => {
      if (!existing.has(r.id)) return true;
      this.counts.recurrence_exception.skipped++;
      return false;
    });
    if (fresh.length === 0) return;
    const ruleIds = [...new Set(fresh.map((r) => r.ruleId))];
    const knownRules = new Set(
      (
        await this.db
          .select({ id: recurrenceRules.id })
          .from(recurrenceRules)
          .where(and(eq(recurrenceRules.workspaceId, this.scope.workspaceId), inArray(recurrenceRules.id, ruleIds)))
      ).map((r) => r.id)
    );
    fresh = fresh.filter((r) => {
      if (knownRules.has(r.ruleId)) return true;
      this.conflict("recurrence_exception", r.id, `rule ${r.ruleId} is not in the target workspace`);
      return false;
    });
    if (fresh.length === 0) return;
    const knownEntities = await entityIdsInScope(
      this.scope,
      this.db,
      fresh.map((r) => r.entityId).filter((id): id is string => Boolean(id))
    );
    const inserted = await this.db
      .insert(recurrenceExceptions)
      .values(
        fresh.map((r) => ({
          ...r,
          entityId: r.entityId && knownEntities.has(r.entityId) ? r.entityId : null
        }))
      )
      .onConflictDoNothing()
      .returning({ id: recurrenceExceptions.id });
    this.settle(
      "recurrence_exception",
      fresh.map((r) => r.id),
      new Set(inserted.map((r) => r.id)),
      "rejected by a unique constraint"
    );
  }

  async revisions(rows: z.infer<typeof RevisionRecord>[]): Promise<void> {
    const existing = await existingIds(
      this.db,
      "entity_revisions",
      rows.map((r) => r.id)
    );
    let fresh = rows.filter((r) => {
      if (!existing.has(r.id)) return true;
      this.counts.entity_revision.skipped++;
      return false;
    });
    if (fresh.length === 0) return;
    const known = await entityIdsInScope(
      this.scope,
      this.db,
      fresh.map((r) => r.entityId)
    );
    fresh = fresh.filter((r) => {
      if (known.has(r.entityId)) return true;
      this.conflict("entity_revision", r.id, `entity ${r.entityId} is not in the target workspace`);
      return false;
    });
    if (fresh.length === 0) return;
    const knownTokens = await tokenIdsInScope(
      this.scope,
      this.db,
      fresh.map((r) => r.actorTokenId)
    );
    const inserted = await this.db
      .insert(entityRevisions)
      .values(
        fresh.map((r) => ({
          ...r,
          actorTokenId: r.actorTokenId && knownTokens.has(r.actorTokenId) ? r.actorTokenId : null
        }))
      )
      .onConflictDoNothing()
      .returning({ id: entityRevisions.id });
    this.settle(
      "entity_revision",
      fresh.map((r) => r.id),
      new Set(inserted.map((r) => r.id)),
      "revision number already taken for that entity"
    );
  }

  async settings(rows: z.infer<typeof SettingsRecord>[]): Promise<void> {
    const last = rows[rows.length - 1];
    if (!last) return;
    await this.db
      .insert(workspaceSettings)
      .values({ workspaceId: this.scope.workspaceId, timezone: last.timezone })
      .onConflictDoUpdate({
        target: workspaceSettings.workspaceId,
        set: { timezone: last.timezone, updatedAt: new Date() }
      });
    this.counts.settings.imported += rows.length;
  }
}

const RECORD_SCHEMAS = {
  project: ProjectRecord,
  entity: EntityRecord,
  edge: EdgeRecord,
  recurrence_rule: RuleRecord,
  recurrence_exception: ExceptionRecord,
  entity_revision: RevisionRecord,
  settings: SettingsRecord
} as const;

function parseRecord(type: RecordType, raw: unknown, lineNo: number): unknown {
  const parsed = RECORD_SCHEMAS[type].safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw clientError(
      `line ${lineNo}: invalid ${type} record${issue ? ` (${issue.path.join(".")}: ${issue.message})` : ""}`,
      400
    );
  }
  return parsed.data;
}

/**
 * Import a dump produced by exportWorkspace into `scope`. Idempotent: rows
 * whose id already exists here are skipped, so a partial import can simply be
 * re-run. Rows owned by another workspace, or whose parent row is missing,
 * are reported as conflicts and left out rather than aborting the import.
 */
export async function importWorkspace(
  scope: Scope,
  db: Database["db"],
  lines: AsyncIterable<string> | Iterable<string>
): Promise<ImportReport> {
  const importer = new Importer(scope, db);
  let header: z.infer<typeof HeaderRecord> | null = null;
  let lineNo = 0;
  let bufferType: RecordType | null = null;
  let buffer: unknown[] = [];

  const flush = async () => {
    if (!bufferType || buffer.length === 0) return;
    const rows = buffer as never[];
    switch (bufferType) {
      case "project":
        await importer.projects(rows);
        break;
      case "entity":
        await importer.entities(rows);
        break;
      case "edge":
        await importer.edges(rows);
        break;
      case "recurrence_rule":
        await importer.rules(rows);
        break;
      case "recurrence_exception":
        await importer.exceptions(rows);
        break;
      case "entity_revision":
        await importer.revisions(rows);
        break;
      case "settings":
        await importer.settings(rows);
        break;
    }
    buffer = [];
  };

  for await (const rawLine of lines) {
    lineNo++;
    const text = rawLine.trim();
    if (!text) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw clientError(`line ${lineNo}: not valid JSON`, 400);
    }
    if (!header) {
      const parsed = HeaderRecord.safeParse(raw);
      if (!parsed.success) throw clientError("line 1 must be the export header", 400);
      if (parsed.data.formatVersion > FORMAT_VERSION) {
        throw clientError(
          `dump uses formatVersion ${parsed.data.formatVersion}; this botnote reads up to ${FORMAT_VERSION}`,
          400
        );
      }
      header = parsed.data;
      continue;
    }
    const type = (raw as { type?: unknown })?.type;
    if (typeof type !== "string" || !(RECORD_TYPES as readonly string[]).includes(type)) {
      throw clientError(`line ${lineNo}: unknown record type ${JSON.stringify(type)}`, 400);
    }
    const record = parseRecord(type as RecordType, raw, lineNo);
    if (bufferType !== type || buffer.length >= BATCH) {
      await flush();
      bufferType = type as RecordType;
    }
    buffer.push(record);
  }
  await flush();
  if (!header) throw clientError("empty dump: expected a header line", 400);
  await importer.finish();

  return {
    formatVersion: header.formatVersion,
    botnoteVersion: header.botnoteVersion,
    exportedAt: header.exportedAt,
    sourceWorkspace: header.workspace,
    counts: importer.counts,
    conflicts: importer.conflicts,
    conflictsTotal: importer.conflictsTotal,
    entitiesWithoutVector: importer.entitiesWithoutVector
  };
}
