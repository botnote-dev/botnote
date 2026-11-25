import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  entities,
  projects,
  sessions,
  tokens,
  users,
  workspaceInvites,
  workspaceMembers,
  type MemberRole,
  type WorkspaceInvite
} from "../db/schema.js";
import { assertAdmin, type Scope } from "./scope.js";
import { avatarPath, defaultName, hashPassword, normalizeEmail, type Account } from "./users.js";

/**
 * People in a workspace: who is a member, how they get in (invite links, no
 * email needed), and what happens when they leave.
 */

const INVITE_TTL_DAYS = 7;

export type InvitableRole = Exclude<MemberRole, "owner">;

function clientError(message: string, statusCode: number, code: string): Error {
  const err = new Error(message) as Error & { statusCode: number; code: string };
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * The membership behind a credential, or null when the person is not (or no
 * longer) an active member. Unscoped by design: the transport calls it to
 * build the request Scope.
 */
export async function resolveMember(
  db: Database["db"],
  workspaceId: string,
  userId: string
): Promise<{ userId: string; role: MemberRole } | null> {
  const [row] = await db
    .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        isNull(users.disabledAt)
      )
    )
    .limit(1);
  return row ?? null;
}

/** The workspace owner, whom a trusted connection from the daemon host acts as. */
export async function ownerMember(
  db: Database["db"],
  workspaceId: string
): Promise<{ userId: string; role: MemberRole } | null> {
  const [row] = await db
    .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner")))
    .limit(1);
  return row ?? null;
}

export interface Member extends Account {
  joinedAt: Date;
}

export async function listMembers(scope: Scope, db: Database["db"]): Promise<Member[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.createdAt,
      avatarUpdatedAt: users.avatarUpdatedAt
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, scope.workspaceId), isNull(users.disabledAt)))
    .orderBy(asc(workspaceMembers.createdAt));
  return rows.map(({ avatarUpdatedAt, ...member }) => ({
    ...member,
    avatar: avatarPath(member.id, avatarUpdatedAt)
  }));
}

export interface CreatedInvite {
  invite: WorkspaceInvite;
  /** Shown once. Only its hash is stored. */
  token: string;
}

export async function createInvite(
  scope: Scope,
  db: Database["db"],
  input: { role?: InvitableRole; email?: string | null }
): Promise<CreatedInvite> {
  assertAdmin(scope);
  const token = randomBytes(24).toString("base64url");
  const [invite] = await db
    .insert(workspaceInvites)
    .values({
      workspaceId: scope.workspaceId,
      tokenHash: hashToken(token),
      role: input.role ?? "member",
      email: input.email ? normalizeEmail(input.email) : null,
      createdBy: scope.userId ?? null,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000)
    })
    .returning();
  if (!invite) throw new Error("invite insert returned no row");
  return { invite, token };
}

/** Invites that can still be accepted, newest first. */
export async function listInvites(scope: Scope, db: Database["db"]): Promise<WorkspaceInvite[]> {
  assertAdmin(scope);
  return db
    .select()
    .from(workspaceInvites)
    .where(
      and(
        eq(workspaceInvites.workspaceId, scope.workspaceId),
        isNull(workspaceInvites.acceptedAt),
        gt(workspaceInvites.expiresAt, new Date())
      )
    )
    .orderBy(desc(workspaceInvites.createdAt));
}

export async function revokeInvite(scope: Scope, db: Database["db"], id: string): Promise<boolean> {
  assertAdmin(scope);
  const rows = await db
    .delete(workspaceInvites)
    .where(
      and(
        eq(workspaceInvites.id, id),
        eq(workspaceInvites.workspaceId, scope.workspaceId),
        isNull(workspaceInvites.acceptedAt)
      )
    )
    .returning({ id: workspaceInvites.id });
  return rows.length > 0;
}

async function findOpenInvite(db: Database["db"], token: string): Promise<WorkspaceInvite | null> {
  if (!token) return null;
  const [invite] = await db
    .select()
    .from(workspaceInvites)
    .where(
      and(
        eq(workspaceInvites.tokenHash, hashToken(token)),
        isNull(workspaceInvites.acceptedAt),
        gt(workspaceInvites.expiresAt, new Date())
      )
    )
    .limit(1);
  return invite ?? null;
}

/** What the accept page shows. Unscoped: the token is the credential. */
export async function describeInvite(
  db: Database["db"],
  token: string
): Promise<{ email: string | null; role: MemberRole; invitedBy: string | null; expiresAt: Date } | null> {
  const invite = await findOpenInvite(db, token);
  if (!invite) return null;
  const [inviter] = invite.createdBy
    ? await db.select({ name: users.name }).from(users).where(eq(users.id, invite.createdBy)).limit(1)
    : [];
  return {
    email: invite.email,
    role: invite.role,
    invitedBy: inviter?.name ?? null,
    expiresAt: invite.expiresAt
  };
}

const INVALID_INVITE = "This invite link is not valid any more. Ask for a new one.";

/**
 * Turn an invite into a member. Unscoped: the token is the credential, and it
 * names the workspace. A person who was removed earlier gets their account
 * back with the new password.
 */
export async function acceptInvite(
  db: Database["db"],
  input: { token: string; email: string; name?: string | null; password: string }
): Promise<Account & { workspaceId: string }> {
  const email = normalizeEmail(input.email);
  const name = input.name?.trim() || defaultName(email);
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(workspaceInvites)
      .where(
        and(
          eq(workspaceInvites.tokenHash, hashToken(input.token)),
          isNull(workspaceInvites.acceptedAt),
          gt(workspaceInvites.expiresAt, new Date())
        )
      )
      .limit(1)
      .for("update");
    if (!invite) throw clientError(INVALID_INVITE, 404, "invalid_invite");
    if (invite.email && invite.email !== email) {
      throw clientError("This invite was made for a different email address.", 403, "email_mismatch");
    }

    const [existing] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
    let userId: string;
    if (existing) {
      if (!existing.disabledAt) {
        throw clientError("That email already has an account here. Sign in instead.", 409, "email_taken");
      }
      await tx
        .update(users)
        .set({ name, passwordHash, disabledAt: null })
        .where(eq(users.id, existing.id));
      userId = existing.id;
    } else {
      const [created] = await tx.insert(users).values({ email, name, passwordHash }).returning();
      userId = created!.id;
    }
    await tx
      .insert(workspaceMembers)
      .values({ workspaceId: invite.workspaceId, userId, role: invite.role })
      .onConflictDoNothing();
    await tx
      .update(workspaceInvites)
      .set({ acceptedAt: new Date(), acceptedBy: userId })
      .where(eq(workspaceInvites.id, invite.id));
    // A returning person starts without a picture, like a new one.
    await tx
      .update(users)
      .set({ avatarData: null, avatarType: null, avatarUpdatedAt: null })
      .where(eq(users.id, userId));
    return {
      id: userId,
      email,
      name,
      role: invite.role,
      avatar: null,
      workspaceId: invite.workspaceId
    };
  });
}

/** Change a member's role. Only the owner may, and never their own. */
export async function setMemberRole(
  scope: Scope,
  db: Database["db"],
  userId: string,
  role: InvitableRole
): Promise<void> {
  if (scope.userId && scope.role !== "owner") {
    throw clientError("Only the owner can change roles.", 403, "forbidden");
  }
  const rows = await db
    .update(workspaceMembers)
    .set({ role })
    .where(
      and(
        eq(workspaceMembers.workspaceId, scope.workspaceId),
        eq(workspaceMembers.userId, userId),
        sql`${workspaceMembers.role} <> 'owner'`
      )
    )
    .returning({ userId: workspaceMembers.userId });
  if (rows.length === 0) throw clientError("member not found", 404, "not_found");
}

/**
 * Remove a member. Their account stops working, their tokens and sessions are
 * revoked, and what they wrote stays. Their projects pass to the workspace
 * owner with the same visibility, so shared work is not orphaned; an admin
 * cannot remove another admin or the owner.
 */
export async function removeMember(scope: Scope, db: Database["db"], userId: string): Promise<void> {
  assertAdmin(scope);
  if (scope.userId === userId) {
    throw clientError("You cannot remove yourself.", 400, "cannot_remove_self");
  }
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, scope.workspaceId), eq(workspaceMembers.userId, userId))
      )
      .limit(1);
    if (!target) throw clientError("member not found", 404, "not_found");
    if (target.role === "owner") {
      throw clientError("The owner cannot be removed.", 403, "forbidden");
    }
    if (target.role === "admin" && scope.userId && scope.role !== "owner") {
      throw clientError("Only the owner can remove an admin.", 403, "forbidden");
    }
    const [owner] = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, scope.workspaceId), eq(workspaceMembers.role, "owner"))
      )
      .limit(1);

    await tx
      .delete(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, scope.workspaceId), eq(workspaceMembers.userId, userId))
      );
    await tx
      .delete(tokens)
      .where(and(eq(tokens.workspaceId, scope.workspaceId), eq(tokens.userId, userId)));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId));
    await tx
      .update(entities)
      .set({
        assigneeUserId: null,
        updatedAt: sql`${entities.updatedAt} + interval '1 microsecond'`
      })
      .where(and(eq(entities.workspaceId, scope.workspaceId), eq(entities.assigneeUserId, userId)));
    if (owner) {
      await tx
        .update(projects)
        .set({ ownerUserId: owner.userId })
        .where(and(eq(projects.workspaceId, scope.workspaceId), eq(projects.ownerUserId, userId)));
    }
  });
}

/** id → display name for every person who ever belonged to the workspace's data. */
export async function userNames(db: Database["db"], ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(sql`${users.id} IN (${sql.join(
      unique.map((id) => sql`${id}::uuid`),
      sql`, `
    )})`);
  return new Map(rows.map((r) => [r.id, r.name]));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turn an assignee reference ("me", "none", a user id, an email, or a display
 * name) into a member's user id, or null for unassigned.
 */
export async function resolveAssignee(
  scope: Scope,
  db: Database["db"],
  ref: string | null
): Promise<string | null> {
  const value = ref?.trim() ?? "";
  if (!value || value.toLowerCase() === "none" || value.toLowerCase() === "unassigned") return null;
  if (value.toLowerCase() === "me") {
    if (!scope.userId) return null;
    return scope.userId;
  }
  const members = await listMembers(scope, db);
  const lowered = value.toLowerCase();
  const matches = UUID_RE.test(value)
    ? members.filter((m) => m.id === lowered)
    : members.filter((m) => m.email === lowered || m.name.toLowerCase() === lowered);
  if (matches.length === 1) return matches[0]!.id;
  throw clientError(
    matches.length > 1
      ? `More than one member is called "${value}". Use their email.`
      : `No member matches "${value}". Use "me", an email, or a name from the members list.`,
    400,
    "unknown_assignee"
  );
}

/**
 * Whether `userId` could see a task at `projectId`: an assignee must be able
 * to open their own task. Outside a project that is the author alone.
 */
export async function canSeeLocation(
  scope: Scope,
  db: Database["db"],
  userId: string,
  projectId: string | null,
  authorUserId: string | null
): Promise<boolean> {
  if (projectId === null) return authorUserId === userId;
  const [project] = await db
    .select({ ownerUserId: projects.ownerUserId, visibility: projects.visibility })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, scope.workspaceId)))
    .limit(1);
  return Boolean(project) && (project!.visibility === "shared" || project!.ownerUserId === userId);
}
