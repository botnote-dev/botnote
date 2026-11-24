import { eq, sql, type SQL } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { DEFAULT_WORKSPACE_ID, workspaces, type MemberRole } from "../db/schema.js";

/**
 * The tenant boundary every service call runs under. Single-user builds use
 * DEFAULT_SCOPE for everything; the hosted build resolves it per request from
 * the token or session. Service functions take it as their first argument and
 * MUST filter every read and stamp every write with it.
 */
export interface Scope {
  workspaceId: string;
  /**
   * The person the request acts for: the signed-in user, or the owner of the
   * API token. Absent or null means unrestricted: background jobs, and an
   * instance that has no accounts yet. The transport MUST set it for every
   * request once accounts exist.
   */
  userId?: string | null;
  role?: MemberRole | null;
}

export const DEFAULT_SCOPE: Scope = Object.freeze({ workspaceId: DEFAULT_WORKSPACE_ID });

export function scopeFor(
  workspaceId: string,
  member?: { userId: string; role: MemberRole }
): Scope {
  return member ? { workspaceId, userId: member.userId, role: member.role } : { workspaceId };
}

const UNQUALIFIED_PROJECTS = sql`projects`;
const UNQUALIFIED_ENTITIES = sql`entities`;

/**
 * SQL condition: the project row `p` is one this scope may see. A project is
 * visible to its owner, and to every member once it is shared. `p` is the
 * table name or alias the surrounding query uses.
 */
export function projectVisible(scope: Scope, p: SQL = UNQUALIFIED_PROJECTS): SQL {
  if (!scope.userId) return sql`TRUE`;
  return sql`(${p}.visibility = 'shared' OR ${p}.owner_user_id = ${scope.userId}::uuid)`;
}

/**
 * SQL condition: the entity row `e` is one this scope may see. An entity in a
 * project follows the project; one outside any project belongs to its author.
 * Every read and every write lookup in the service layer MUST apply this (or
 * go through a helper that does) next to the workspace filter.
 */
export function entityVisible(scope: Scope, e: SQL = UNQUALIFIED_ENTITIES): SQL {
  if (!scope.userId) return sql`TRUE`;
  return sql`(CASE WHEN ${e}.project_id IS NULL
      THEN ${e}.author_user_id = ${scope.userId}::uuid
      ELSE ${e}.project_id IN (
        SELECT vp.id FROM projects vp
        WHERE vp.workspace_id = ${scope.workspaceId}::uuid
          AND (vp.visibility = 'shared' OR vp.owner_user_id = ${scope.userId}::uuid)
      ) END)`;
}

/** Workspace filter plus visibility for the entity row `e`. */
export function entityInScope(scope: Scope, e: SQL = UNQUALIFIED_ENTITIES): SQL {
  return sql`(${e}.workspace_id = ${scope.workspaceId}::uuid AND ${entityVisible(scope, e)})`;
}

export function isAdmin(scope: Scope): boolean {
  return !scope.userId || scope.role === "owner" || scope.role === "admin";
}

function forbidden(message: string): Error {
  const err = new Error(message) as Error & { statusCode: number; code: string };
  err.statusCode = 403;
  err.code = "forbidden";
  return err;
}

/**
 * Export and import move the whole workspace, including what other members
 * keep private, so only the instance owner may run them.
 */
export function assertOwner(scope: Scope): void {
  if (!scope.userId || scope.role === "owner") return;
  throw forbidden("Only the owner can do this.");
}

/** Throws 403 unless the scope is unrestricted or an owner/admin. */
export function assertAdmin(scope: Scope): void {
  if (isAdmin(scope)) return;
  throw forbidden("Only an owner or admin can do this.");
}

/** Verify the default workspace row exists (migration 0028 seeds it). */
export async function resolveDefaultScope(db: Database["db"]): Promise<Scope> {
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID))
    .limit(1);
  if (!rows[0]) {
    throw new Error(
      `default workspace ${DEFAULT_WORKSPACE_ID} missing; run migrations before starting the daemon`
    );
  }
  return DEFAULT_SCOPE;
}
