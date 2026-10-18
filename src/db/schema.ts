import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const VECTOR_DIMENSIONS = 384;

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return `vector(${VECTOR_DIMENSIONS})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    const trimmed = value.replace(/^\[/, "").replace(/\]$/, "");
    if (!trimmed) return [];
    return trimmed.split(",").map((s) => Number(s));
  }
});

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  }
});

export const ENTITY_KINDS = ["task", "note", "worklog", "feedback"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const FEEDBACK_CATEGORIES = ["bug", "feature", "friction", "idea"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const ACTOR_KINDS = ["human", "agent", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const EDGE_KINDS = ["blocks", "references", "parent_of", "supersedes"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

// The single workspace every row belongs to until multi-tenant mode lands.
// Fixed so migrations, defaults and code agree without a lookup.
export const DEFAULT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    slugIdx: uniqueIndex("workspaces_slug_idx").on(t.slug)
  })
);

const workspaceRef = () =>
  uuid("workspace_id")
    .notNull()
    .default(DEFAULT_WORKSPACE_ID)
    .references(() => workspaces.id);

export const PROJECT_STATUSES = ["planned", "active", "watching", "paused", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    color: text("color").notNull().default("#5e6ad2"),
    icon: text("icon").notNull().default("circle"),
    agentsMd: text("agents_md").notNull().default(""),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // Per-project sequence counter, advanced by the entities insert trigger
    // (migration 0026). Never written from application code.
    nextSeq: integer("next_seq").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    wsKeyIdx: uniqueIndex("projects_ws_key_unique").on(t.workspaceId, t.key)
  })
);

export const entities = pgTable(
  "entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    title: text("title"),
    body: text("body").notNull().default(""),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text("status").notNull().default("open"),
    actorKind: text("actor_kind").notNull().default("human"),
    // API token that performed the write, when the request carried one.
    // Resolves to a human-readable author label ("Claude Code @ MacBook").
    actorTokenId: uuid("actor_token_id").references(() => tokens.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key"),
    parentId: uuid("parent_id"),
    bodyTsv: tsvector("body_tsv"),
    bodyVec: vector("body_vec"),
    metadata: jsonb("metadata").notNull().default({}),
    dueAt: timestamp("due_at", { withTimezone: true }),
    priority: text("priority").notNull().default("none"),
    sequenceId: integer("sequence_id"),
    pinned: boolean("pinned").notNull().default(false),
    // Set automatically on a status transition into 'done', cleared on exit.
    // Drives the calendar's display-date logic: done tasks render on
    // completedAt rather than dueAt so the timeline reflects what actually
    // happened.
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Bumped on explicit reads (GET by id / by key); feeds a light boost
    // into hybrid search so frequently-recalled memories rank higher.
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    accessCount: integer("access_count").notNull().default(0),
    // Soft delete: non-null = in the trash. Read paths exclude trashed rows;
    // restore clears it; the retention purge hard-deletes expired rows.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    projectCreatedIdx: index("entities_project_created_idx").on(t.projectId, t.createdAt),
    projectKindCreatedIdx: index("entities_project_kind_created_idx").on(
      t.projectId,
      t.kind,
      t.createdAt
    ),
    parentIdx: index("entities_parent_idx").on(t.parentId),
    completedAtIdx: index("entities_completed_at_idx").on(t.completedAt),
    wsIdempotencyIdx: uniqueIndex("entities_ws_idem_unique")
      .on(t.workspaceId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    wsKindCreatedIdx: index("entities_ws_kind_created_idx").on(
      t.workspaceId,
      t.kind,
      t.createdAt
    )
  })
);

export const edges = pgTable(
  "edges",
  {
    fromId: uuid("from_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    toId: uuid("to_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.fromId, t.toId, t.kind] }),
    toIdx: index("edges_to_idx").on(t.toId, t.kind),
    fromIdx: index("edges_from_idx").on(t.fromId, t.kind)
  })
);

export const RECURRENCE_ANCHORS = ["scheduled", "completion"] as const;
export type RecurrenceAnchor = (typeof RECURRENCE_ANCHORS)[number];

export const RECURRENCE_EXCEPTION_ACTIONS = ["skipped", "cancelled", "modified"] as const;
export type RecurrenceExceptionAction = (typeof RECURRENCE_EXCEPTION_ACTIONS)[number];

export const recurrenceRules = pgTable(
  "recurrence_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    seriesId: uuid("series_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    currentOccurrenceId: uuid("current_occurrence_id").references(() => entities.id, {
      onDelete: "set null"
    }),
    enabled: boolean("enabled").notNull().default(true),
    rrule: text("rrule").notNull(),
    dtstart: timestamp("dtstart", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    allDay: boolean("all_day").notNull().default(true),
    anchor: text("anchor").notNull().default("scheduled"),
    maxInstancesAhead: integer("max_instances_ahead").notNull().default(1),
    generatedCount: integer("generated_count").notNull().default(1),
    lastOccurrenceAt: timestamp("last_occurrence_at", { withTimezone: true }),
    nextOccurrenceAt: timestamp("next_occurrence_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    // Partial unique: at most one ENABLED rule per series. A split keeps the old
    // rule as disabled history alongside the new enabled rule (same series_id).
    seriesIdx: uniqueIndex("recurrence_rules_series_idx")
      .on(t.seriesId)
      .where(sql`${t.enabled}`),
    currentOccurrenceIdx: index("recurrence_rules_current_occurrence_idx").on(
      t.currentOccurrenceId
    ),
    nextOccurrenceIdx: index("recurrence_rules_next_occurrence_idx").on(t.nextOccurrenceAt),
    enabledIdx: index("recurrence_rules_enabled_idx").on(t.enabled, t.nextOccurrenceAt)
  })
);

export const recurrenceExceptions = pgTable(
  "recurrence_exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => recurrenceRules.id, { onDelete: "cascade" }),
    occurrenceAt: timestamp("occurrence_at", { withTimezone: true }).notNull(),
    action: text("action").notNull(),
    entityId: uuid("entity_id").references(() => entities.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    ruleOccurrenceIdx: index("recurrence_exceptions_rule_occurrence_idx").on(
      t.ruleId,
      t.occurrenceAt
    ),
    entityIdx: index("recurrence_exceptions_entity_idx").on(t.entityId)
  })
);

export const tokens = pgTable(
  "tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    plaintext: text("plaintext"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    tokenHashIdx: uniqueIndex("tokens_token_hash_idx").on(t.tokenHash),
    createdIdx: index("tokens_created_idx").on(t.createdAt)
  })
);

// Content history. Row N holds the title/body/tags/priority/status as they
// were BEFORE the Nth content-changing update; actor_* is who made that
// update. The current values live on the entity itself.
export const entityRevisions = pgTable(
  "entity_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    title: text("title"),
    body: text("body").notNull().default(""),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    priority: text("priority").notNull().default("none"),
    status: text("status").notNull().default("open"),
    actorKind: text("actor_kind").notNull().default("human"),
    actorTokenId: uuid("actor_token_id").references(() => tokens.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    entityRevisionIdx: uniqueIndex("entity_revisions_entity_revision_idx").on(
      t.entityId,
      t.revision
    )
  })
);

export const embeddingSettings = pgTable("embedding_settings", {
  // Constant discriminator kept from the singleton era; the row key is the
  // workspace (migration 0029).
  id: text("id").notNull().default("default"),
  workspaceId: workspaceRef().primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  provider: text("provider").notNull().default("openai"),
  model: text("model").notNull().default("text-embedding-3-small"),
  baseUrl: text("base_url"),
  apiKey: text("api_key"),
  dimensions: integer("dimensions").notNull().default(VECTOR_DIMENSIONS),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const workspaceSettings = pgTable("workspace_settings", {
  id: text("id").notNull().default("default"),
  workspaceId: workspaceRef().primaryKey(),
  timezone: text("timezone").notNull().default("UTC"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

// Browser-facing session cookies. The plaintext is stored in an httpOnly
// cookie; the row stores sha256(plaintext). On login the user posts the master
// password (env BOTNOTE_PASSWORD) and we mint a row + set the cookie.
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: workspaceRef(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    tokenHashIdx: uniqueIndex("sessions_token_hash_idx").on(t.tokenHash),
    expiresIdx: index("sessions_expires_at_idx").on(t.expiresAt)
  })
);

export type Workspace = typeof workspaces.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Entity = typeof entities.$inferSelect;
export type Edge = typeof edges.$inferSelect;
export type RecurrenceRule = typeof recurrenceRules.$inferSelect;
export type RecurrenceException = typeof recurrenceExceptions.$inferSelect;
export type Token = typeof tokens.$inferSelect;
export type EntityRevision = typeof entityRevisions.$inferSelect;
export type EmbeddingSettings = typeof embeddingSettings.$inferSelect;
export type WorkspaceSettings = typeof workspaceSettings.$inferSelect;
export type Session = typeof sessions.$inferSelect;
