import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { projects, type Project } from "../db/schema.js";
import { projectVisible, type Scope } from "./scope.js";
import type { CreateProjectInput, ListProjectsInput, UpdateProjectInput } from "./types.js";

function forbidden(message: string): Error {
  const err = new Error(message) as Error & { statusCode: number; code: string };
  err.statusCode = 403;
  err.code = "forbidden";
  return err;
}

export async function createProject(
  scope: Scope,
  db: Database["db"],
  input: CreateProjectInput
): Promise<Project> {
  const [row] = await db
    .insert(projects)
    .values({
      workspaceId: scope.workspaceId,
      key: input.key,
      name: input.name,
      status: input.status,
      color: input.color,
      icon: input.icon,
      agentsMd: input.agentsMd,
      ownerUserId: scope.userId ?? null,
      visibility: input.visibility ?? "private",
      archivedAt: input.status === "archived" ? new Date() : null
    })
    .returning()
    .catch((err: unknown) => {
      // Keys are unique across the instance, including projects this person
      // cannot see, so the message does not say whose project holds it.
      const e = err as { code?: string; cause?: { code?: string } };
      if ((e.code ?? e.cause?.code) === "23505") {
        const conflict = new Error(`project key ${input.key} is already in use`) as Error & {
          statusCode: number;
          code: string;
        };
        conflict.statusCode = 409;
        conflict.code = "key_taken";
        throw conflict;
      }
      throw err;
    });
  if (!row) throw new Error("project insert returned no row");
  return row;
}

export async function updateProject(
  scope: Scope,
  db: Database["db"],
  id: string,
  input: UpdateProjectInput
): Promise<Project> {
  const set: Record<string, unknown> = { ...input, updatedAt: new Date() };
  if (input.status === "archived") {
    set.archivedAt = sql`COALESCE(${projects.archivedAt}, now())`;
  } else if (input.status !== undefined) {
    set.archivedAt = null;
  }
  const visible = and(
    eq(projects.id, id),
    eq(projects.workspaceId, scope.workspaceId),
    projectVisible(scope)
  );
  if (input.visibility !== undefined && scope.userId) {
    const [current] = await db
      .select({ ownerUserId: projects.ownerUserId, visibility: projects.visibility })
      .from(projects)
      .where(visible)
      .limit(1);
    if (!current) throw new Error(`project ${id} not found`);
    if (current.visibility !== input.visibility && current.ownerUserId !== scope.userId) {
      throw forbidden("Only the project's owner can change who it is shared with.");
    }
  }
  const [row] = await db.update(projects).set(set).where(visible).returning();
  if (!row) throw new Error(`project ${id} not found`);
  return row;
}

export async function getProjectByKey(
  scope: Scope,
  db: Database["db"],
  key: string
): Promise<Project | null> {
  const rows = await db
    .select()
    .from(projects)
    .where(
      and(eq(projects.key, key), eq(projects.workspaceId, scope.workspaceId), projectVisible(scope))
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getProject(
  scope: Scope,
  db: Database["db"],
  id: string
): Promise<Project | null> {
  const rows = await db
    .select()
    .from(projects)
    .where(
      and(eq(projects.id, id), eq(projects.workspaceId, scope.workspaceId), projectVisible(scope))
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listProjects(
  scope: Scope,
  db: Database["db"],
  input: ListProjectsInput = { includeArchived: false }
): Promise<Project[]> {
  const inScope = and(eq(projects.workspaceId, scope.workspaceId), projectVisible(scope));
  const where = input.includeArchived ? inScope : and(inScope, ne(projects.status, "archived"));
  return db.select().from(projects).where(where).orderBy(projects.key);
}
