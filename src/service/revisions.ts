import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { entities, entityRevisions, type EntityRevision } from "../db/schema.js";
import { resolveEntityId } from "./entities.js";
import { entityInScope, type Scope } from "./scope.js";

type Db = Database["db"];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

/** Snapshots kept per entity; older ones are dropped as new ones arrive. */
export const REVISION_RETENTION = 50;

export interface RevisionSnapshot {
  entityId: string;
  title: string | null;
  body: string;
  tags: string[];
  priority: string;
  status: string;
  /** Who is making the change that replaces this snapshot. */
  actorKind: string;
  actorTokenId: string | null;
  authorUserId: string | null;
}

/**
 * Store the pre-update content as the next revision of the entity and trim
 * history to REVISION_RETENTION rows. Call inside the update's transaction so a
 * failed update leaves no orphan snapshot.
 */
export async function recordRevision(exec: Executor, snap: RevisionSnapshot): Promise<void> {
  await exec.insert(entityRevisions).values({
    entityId: snap.entityId,
    revision: sql`(SELECT COALESCE(MAX(revision), 0) + 1 FROM entity_revisions WHERE entity_id = ${snap.entityId}::uuid)`,
    title: snap.title,
    body: snap.body,
    tags: snap.tags,
    priority: snap.priority,
    status: snap.status,
    actorKind: snap.actorKind,
    actorTokenId: snap.actorTokenId,
    authorUserId: snap.authorUserId
  });
  await exec.execute(sql`
    DELETE FROM entity_revisions
    WHERE entity_id = ${snap.entityId}::uuid
      AND revision <= (
        SELECT MAX(revision) FROM entity_revisions WHERE entity_id = ${snap.entityId}::uuid
      ) - ${REVISION_RETENTION}
  `);
}

/**
 * Revision history of an entity, newest first. Returns null when the entity
 * does not exist in this scope; an empty array when it was never edited.
 */
export async function listRevisions(
  scope: Scope,
  db: Db,
  idOrPrefix: string,
  limit = REVISION_RETENTION
): Promise<EntityRevision[] | null> {
  const entityId = await resolveEntityId(scope, db, idOrPrefix);
  if (!entityId) return null;
  const exists = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.id, entityId), entityInScope(scope)))
    .limit(1);
  if (exists.length === 0) return null;
  return db
    .select()
    .from(entityRevisions)
    .where(eq(entityRevisions.entityId, entityId))
    .orderBy(desc(entityRevisions.revision))
    .limit(limit);
}
