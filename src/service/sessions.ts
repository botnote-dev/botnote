import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { sessions, type Session } from "../db/schema.js";
import type { Scope } from "./scope.js";

const DEFAULT_TTL_DAYS = 30;

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Constant-time equality on UTF-8 strings of arbitrary length. */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Pad to equal length so timingSafeEqual doesn't throw. We compare lengths
  // separately — if lengths differ, the result is false. Both branches still
  // do a fixed-time compare of the same number of bytes.
  const len = Math.max(ab.length, bb.length);
  const a2 = Buffer.alloc(len);
  const b2 = Buffer.alloc(len);
  ab.copy(a2);
  bb.copy(b2);
  const same = timingSafeEqual(a2, b2);
  return same && ab.length === bb.length;
}

/** Verify a candidate master password against BOTNOTE_PASSWORD env. Returns
 *  false (not throws) when the env is unset, so callers can degrade safely. */
export function verifyMasterPassword(candidate: string): boolean {
  const expected = process.env.BOTNOTE_PASSWORD;
  if (!expected) return false;
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  return constantTimeEqual(candidate, expected);
}

export interface CreatedSession {
  session: Session;
  plaintext: string;
}

export async function createSession(
  scope: Scope,
  db: Database["db"],
  opts: { userAgent?: string | null; ttlDays?: number; userId?: string | null } = {}
): Promise<CreatedSession> {
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const plaintext = randomBytes(32).toString("hex");
  const tokenHash = hashToken(plaintext);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  const [row] = await db
    .insert(sessions)
    .values({
      workspaceId: scope.workspaceId,
      tokenHash,
      userId: opts.userId ?? null,
      expiresAt,
      userAgent: opts.userAgent ?? null
    })
    .returning();
  return { session: row!, plaintext };
}

/** Look up a session by cookie plaintext. Returns the row if it exists and
 *  has not expired; otherwise null. Bumps last_used_at on hit. Unscoped by
 *  design: the row's workspaceId becomes the request Scope. */
export async function consumeSession(
  db: Database["db"],
  plaintext: string
): Promise<Session | null> {
  if (typeof plaintext !== "string" || plaintext.length === 0) return null;
  const tokenHash = hashToken(plaintext);
  const now = new Date();
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .limit(1);
  if (!row) return null;
  await db
    .update(sessions)
    .set({ lastUsedAt: now })
    .where(eq(sessions.id, row.id));
  return row;
}

/** Revoke a single session by cookie plaintext. No-op when the cookie does
 *  not match any row. The plaintext is the credential, so no scope is needed. */
export async function revokeSession(
  db: Database["db"],
  plaintext: string
): Promise<boolean> {
  if (typeof plaintext !== "string" || plaintext.length === 0) return false;
  const tokenHash = hashToken(plaintext);
  const result = await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  // node-postgres returns rowCount on the result wrapper drizzle exposes via
  // .rowCount; fall back to true when shape is opaque.
  const r = result as unknown as { rowCount?: number };
  return r.rowCount === undefined ? true : r.rowCount > 0;
}

/** Daemon-level maintenance across all workspaces: deletes expired rows so
 *  the table doesn't bloat over months. */
export async function pruneExpiredSessions(db: Database["db"]): Promise<number> {
  const result = await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  const r = result as unknown as { rowCount?: number };
  return r.rowCount ?? 0;
}
