import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  entities,
  projects,
  sessions,
  tokens,
  users,
  workspaceMembers,
  type MemberRole,
  type User
} from "../db/schema.js";
import type { Scope } from "./scope.js";

/**
 * Accounts. A daemon with no users is in single-password mode; the first
 * account created through `createOwner` owns the workspace, and from then on
 * people sign in with email and password.
 */

// scrypt cost. N=2^15 with r=8 needs about 32 MB per hash, which a 1 GB host
// can afford under the login rate limit. The parameters are stored with each
// hash, so they can be raised later without invalidating old passwords.
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

// Serializes account creation so two first visitors cannot both become owner.
const SETUP_LOCK_KEY = 4280_0035;

function clientError(message: string, statusCode: number, code: string): Error {
  const err = new Error(message) as Error & { statusCode: number; code: string };
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      KEY_BYTES,
      { N: n, r, p, maxmem: 256 * n * r },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, n, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Display name for someone who gave none: the part of the email before @. */
export function defaultName(email: string): string {
  return normalizeEmail(email).split("@")[0] || "user";
}

export interface Account {
  id: string;
  email: string;
  name: string;
  role: MemberRole;
  /** Path of the profile picture, or null when the person has none. */
  avatar: string | null;
}

/** Largest stored picture. The browser sends a 256px square, far below this. */
export const AVATAR_MAX_BYTES = 200 * 1024;

/**
 * The address of a person's picture. The version changes with every upload,
 * so the response can be cached for good.
 */
export function avatarPath(userId: string, updatedAt: Date | null): string | null {
  return updatedAt ? `/v1/users/${userId}/avatar?v=${updatedAt.getTime()}` : null;
}

/** The image type by its leading bytes; what the client claims is not trusted. */
function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** Store a profile picture given as a `data:image/...;base64,` URL. */
export async function setAvatar(db: Database["db"], userId: string, dataUrl: string): Promise<void> {
  const match = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
  if (!match) throw clientError("Send the picture as a base64 image data URL.", 400, "invalid_avatar");
  const bytes = Buffer.from(match[1]!, "base64");
  if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) {
    throw clientError("The picture is too large.", 413, "avatar_too_large");
  }
  const type = sniffImageType(bytes);
  if (!type) throw clientError("Use a PNG, JPEG or WebP picture.", 400, "invalid_avatar");
  await db
    .update(users)
    .set({ avatarData: bytes.toString("base64"), avatarType: type, avatarUpdatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function clearAvatar(db: Database["db"], userId: string): Promise<void> {
  await db
    .update(users)
    .set({ avatarData: null, avatarType: null, avatarUpdatedAt: null })
    .where(eq(users.id, userId));
}

/** A member's picture, or null when they have none or are not in this workspace. */
export async function getAvatar(
  scope: Scope,
  db: Database["db"],
  userId: string
): Promise<{ type: string; bytes: Buffer } | null> {
  const [row] = await db
    .select({ data: users.avatarData, type: users.avatarType })
    .from(users)
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
    .where(and(eq(users.id, userId), eq(workspaceMembers.workspaceId, scope.workspaceId)))
    .limit(1);
  if (!row?.data || !row.type) return null;
  return { type: row.type, bytes: Buffer.from(row.data, "base64") };
}

export async function hasUsers(db: Database["db"]): Promise<boolean> {
  const rows = await db.select({ id: users.id }).from(users).limit(1);
  return rows.length > 0;
}

/**
 * Create the first account and make it the owner of the scope's workspace.
 * Refused once any user exists. Tokens created before accounts existed become
 * the owner's, and password-mode sessions are dropped so every browser signs
 * in again as a person.
 */
export async function createOwner(
  scope: Scope,
  db: Database["db"],
  input: { email: string; name?: string | null; password: string }
): Promise<Account> {
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);
    const existing = await tx.select({ id: users.id }).from(users).limit(1);
    if (existing.length > 0) {
      throw clientError("This instance already has an owner. Sign in instead.", 409, "setup_done");
    }
    const [user] = await tx
      .insert(users)
      .values({ email, name: input.name?.trim() || defaultName(email), passwordHash })
      .returning();
    await tx
      .insert(workspaceMembers)
      .values({ workspaceId: scope.workspaceId, userId: user!.id, role: "owner" });
    await tx
      .update(tokens)
      .set({ userId: user!.id })
      .where(and(eq(tokens.workspaceId, scope.workspaceId), isNull(tokens.userId)));
    await tx.delete(sessions).where(isNull(sessions.userId));
    // Everything written before accounts existed is the owner's. Projects
    // keep their default visibility (private) until the owner shares them.
    await tx
      .update(projects)
      .set({ ownerUserId: user!.id, updatedAt: sql`${projects.updatedAt} + interval '1 microsecond'` })
      .where(and(eq(projects.workspaceId, scope.workspaceId), isNull(projects.ownerUserId)));
    await tx
      .update(entities)
      .set({ authorUserId: user!.id, updatedAt: sql`${entities.updatedAt} + interval '1 microsecond'` })
      .where(and(eq(entities.workspaceId, scope.workspaceId), isNull(entities.authorUserId)));
    return { id: user!.id, email: user!.email, name: user!.name, role: "owner" as const, avatar: null };
  });
}

// A fixed hash to burn the same CPU when the email is unknown, so response
// time does not reveal which addresses have accounts.
let decoyHash: Promise<string> | null = null;

/** Check an email and password. Returns the user, or null for any failure. */
export async function authenticate(
  db: Database["db"],
  email: string,
  password: string
): Promise<User | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  if (!user || !user.passwordHash || user.disabledAt) {
    decoyHash ??= hashPassword(randomBytes(16).toString("hex"));
    await verifyPassword(password, await decoyHash);
    return null;
  }
  return (await verifyPassword(password, user.passwordHash)) ? user : null;
}

export async function getAccount(
  scope: Scope,
  db: Database["db"],
  userId: string
): Promise<Account | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: workspaceMembers.role,
      avatarUpdatedAt: users.avatarUpdatedAt
    })
    .from(users)
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
    .where(
      and(
        eq(users.id, userId),
        eq(workspaceMembers.workspaceId, scope.workspaceId),
        isNull(users.disabledAt)
      )
    )
    .limit(1);
  if (!row) return null;
  const { avatarUpdatedAt, ...account } = row;
  return { ...account, avatar: avatarPath(row.id, avatarUpdatedAt) };
}

export async function updateProfile(
  db: Database["db"],
  userId: string,
  input: { name: string }
): Promise<void> {
  await db.update(users).set({ name: input.name.trim() }).where(eq(users.id, userId));
}

/**
 * Change a user's own password. Every other session of that user is signed
 * out; `keepSessionId` is the browser making the change.
 */
export async function changePassword(
  db: Database["db"],
  input: { userId: string; currentPassword: string; newPassword: string; keepSessionId?: string | null }
): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!user || !(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw clientError("The current password is wrong.", 403, "invalid_password");
  }
  const passwordHash = await hashPassword(input.newPassword);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    await tx
      .delete(sessions)
      .where(
        input.keepSessionId
          ? and(eq(sessions.userId, user.id), sql`${sessions.id} <> ${input.keepSessionId}`)
          : eq(sessions.userId, user.id)
      );
  });
}

/**
 * Operator recovery, run from the daemon host: set a new random password and
 * sign the user out everywhere. Returns the password, or null when no user has
 * that email.
 */
export async function resetPassword(db: Database["db"], email: string): Promise<string | null> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  if (!user) return null;
  const password = randomBytes(12).toString("base64url");
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
  });
  return password;
}
