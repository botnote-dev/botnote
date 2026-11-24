import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { entities, type Entity, type FeedbackCategory } from "../db/schema.js";
import { write } from "./entities.js";
import { entityInScope, type Scope } from "./scope.js";
import type { CreateFeedbackInput, ListFeedbackInput, WriteAttribution } from "./types.js";

/**
 * File product feedback about botnote itself. Feedback is a first-class
 * entity kind so it shows up in search/recent, but its lifecycle is a triage
 * queue: open (new) → in_progress (accepted) → done (shipped/resolved) or
 * rejected (won't fix). The category lives in metadata.category.
 */
export async function submitFeedback(
  scope: Scope,
  db: Database["db"],
  input: CreateFeedbackInput,
  attribution: WriteAttribution = {}
): Promise<Entity> {
  return write(scope, db, {
    kind: "feedback",
    projectId: input.projectId ?? null,
    title: input.title,
    body: input.body,
    tags: [input.category],
    status: "open",
    actorKind: input.actorKind,
    actorTokenId: attribution.actorTokenId ?? null,
    metadata: {
      ...input.metadata,
      category: input.category,
      ...(input.tool ? { tool: input.tool } : {})
    },
    dueAt: null,
    priority: "none",
    pinned: false,
    idempotencyKey: input.idempotencyKey
  });
}

/** Feedback entries for triage, newest first, filterable by category/status. */
export async function listFeedback(
  scope: Scope,
  db: Database["db"],
  input: ListFeedbackInput
): Promise<Entity[]> {
  const conds = [
    entityInScope(scope),
    eq(entities.kind, "feedback"),
    isNull(entities.deletedAt)
  ];
  if (input.status) conds.push(eq(entities.status, input.status));
  if (input.category) {
    conds.push(
      sql`${entities.metadata} ->> 'category' = ${input.category as FeedbackCategory}`
    );
  }
  return db
    .select()
    .from(entities)
    .where(and(...conds))
    .orderBy(desc(entities.createdAt))
    .limit(input.limit);
}
