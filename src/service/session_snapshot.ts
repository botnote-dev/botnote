import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { entities, type Entity } from "../db/schema.js";
import { get, getByKey } from "./entities.js";
import type { Scope } from "./scope.js";
import type { SessionSnapshotInput, WriteAttribution } from "./types.js";

/** Stored under `metadata.sessionSnapshot` on a task. */
export interface SessionSnapshot {
  sessionId: string;
  client: string;
  summary: string;
  changedFiles: string;
  cwd: string | null;
  at: string;
  actorKind: string;
  actorTokenId: string | null;
  idempotencyKey: string | null;
}

const TASK_KEY_RE = /^([A-Z][A-Z0-9_]*)-(\d+)$/;

function clientError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

async function resolveTask(scope: Scope, db: Database["db"], ref: string): Promise<Entity | null> {
  const key = TASK_KEY_RE.exec(ref);
  if (key) return getByKey(scope, db, key[1]!, Number(key[2]));
  return get(scope, db, ref);
}

export function readSessionSnapshot(entity: Pick<Entity, "metadata">): SessionSnapshot | null {
  const raw = (entity.metadata as Record<string, unknown> | null)?.sessionSnapshot;
  if (!raw || typeof raw !== "object") return null;
  const snap = raw as Partial<SessionSnapshot>;
  if (typeof snap.sessionId !== "string" || typeof snap.at !== "string") return null;
  return snap as SessionSnapshot;
}

/**
 * Replace the task's session snapshot. It lives in metadata rather than as a
 * worklog entry so mechanical capture never crowds out written worklog, and it
 * records no revision because it is not an edit to the task's content.
 */
export async function setSessionSnapshot(
  scope: Scope,
  db: Database["db"],
  taskRef: string,
  input: SessionSnapshotInput,
  attribution: WriteAttribution = {}
): Promise<Entity> {
  const task = await resolveTask(scope, db, taskRef);
  if (!task) throw clientError(`task ${taskRef} not found`, 404);
  if (task.deletedAt) throw clientError("entity is in trash; restore first", 409);
  if (task.kind !== "task") throw clientError("session snapshots attach to tasks only", 400);

  const current = readSessionSnapshot(task);
  if (input.idempotencyKey && current?.idempotencyKey === input.idempotencyKey) return task;

  const snapshot: SessionSnapshot = {
    sessionId: input.sessionId,
    client: input.client,
    summary: input.summary,
    changedFiles: input.changedFiles,
    cwd: input.cwd ?? null,
    at: (input.at ?? new Date()).toISOString(),
    actorKind: input.actorKind,
    actorTokenId: attribution.actorTokenId ?? null,
    idempotencyKey: input.idempotencyKey ?? null
  };

  const [row] = await db
    .update(entities)
    .set({
      metadata: sql`jsonb_set(coalesce(${entities.metadata}, '{}'::jsonb), '{sessionSnapshot}', ${JSON.stringify(snapshot)}::jsonb, true)`
    })
    .where(eq(entities.id, task.id))
    .returning();
  return row!;
}
