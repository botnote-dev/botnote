import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { tokens, type Token } from "../db/schema.js";
import { isAdmin, type Scope } from "./scope.js";

const TOKEN_PREFIX = "bn_";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface CreatedToken {
  token: Token;
  /** Returned once at creation. Only its hash is stored. */
  plaintext: string;
}

export async function createToken(
  scope: Scope,
  db: Database["db"],
  input: { name: string }
): Promise<CreatedToken> {
  const plaintext = `${TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
  const tokenHash = sha256(plaintext);
  const prefix = plaintext.slice(0, 11); // bn_ + first 8 hex
  const [row] = await db
    .insert(tokens)
    .values({
      workspaceId: scope.workspaceId,
      name: input.name,
      tokenHash,
      prefix,
      userId: scope.userId ?? null
    })
    .returning();
  if (!row) throw new Error("token insert returned no row");
  labelCache.delete(scope.workspaceId);
  return { token: row, plaintext };
}

// Token id -> name, per workspace. Every entity response resolves its author
// through this map, so it is cached briefly instead of queried per request.
// Writes through createToken/revokeToken invalidate it; a rename path would
// have to do the same.
const LABEL_CACHE_TTL_MS = 30_000;
const labelCache = new Map<string, { at: number; labels: Map<string, string> }>();

export async function tokenLabels(scope: Scope, db: Database["db"]): Promise<Map<string, string>> {
  const cached = labelCache.get(scope.workspaceId);
  if (cached && Date.now() - cached.at < LABEL_CACHE_TTL_MS) return cached.labels;
  const rows = await db
    .select({ id: tokens.id, name: tokens.name })
    .from(tokens)
    .where(eq(tokens.workspaceId, scope.workspaceId));
  const labels = new Map(rows.map((r) => [r.id, r.name]));
  labelCache.set(scope.workspaceId, { at: Date.now(), labels });
  return labels;
}

export function resetTokenLabelCache(): void {
  labelCache.clear();
}

/**
 * A member sees their own tokens; an owner or admin sees everyone's, so a
 * leaked or forgotten one can be revoked. The plaintext some older tokens
 * still carry is only ever returned to the token's own person.
 */
export async function listTokens(scope: Scope, db: Database["db"]): Promise<Token[]> {
  const inWorkspace = eq(tokens.workspaceId, scope.workspaceId);
  const rows = await db
    .select()
    .from(tokens)
    .where(
      scope.userId && !isAdmin(scope) ? and(inWorkspace, eq(tokens.userId, scope.userId)) : inWorkspace
    )
    .orderBy(desc(tokens.createdAt));
  if (!scope.userId) return rows;
  return rows.map((t) => (t.userId === scope.userId ? t : { ...t, plaintext: null }));
}

export async function revokeToken(scope: Scope, db: Database["db"], id: string): Promise<boolean> {
  const res = await db
    .delete(tokens)
    .where(
      and(
        eq(tokens.id, id),
        eq(tokens.workspaceId, scope.workspaceId),
        scope.userId && !isAdmin(scope) ? eq(tokens.userId, scope.userId) : undefined
      )
    )
    .returning({ id: tokens.id });
  labelCache.delete(scope.workspaceId);
  return res.length > 0;
}

/**
 * Look up a token by its plaintext. Returns null if not found. Bumps
 * last_used_at on success. Unscoped by design: the returned row's workspaceId
 * is what the transport turns into the request Scope.
 */
export async function consumeToken(
  db: Database["db"],
  plaintext: string
): Promise<Token | null> {
  const tokenHash = sha256(plaintext);
  const rows = await db.select().from(tokens).where(eq(tokens.tokenHash, tokenHash)).limit(1);
  const row = rows[0];
  if (!row) return null;
  await db.update(tokens).set({ lastUsedAt: new Date() }).where(eq(tokens.id, row.id));
  return row;
}
