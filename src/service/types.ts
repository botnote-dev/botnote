import { z } from "zod";
import {
  ACTOR_KINDS,
  EDGE_KINDS,
  ENTITY_KINDS,
  FEEDBACK_CATEGORIES,
  PROJECT_STATUSES,
  RECURRENCE_ANCHORS
} from "../db/schema.js";

/** Also accepts "comment", the pre-0.2.16 name for worklog entries, so older
 *  plugins and export files keep working against this daemon. */
export const EntityKindEnum = z.preprocess(
  (value) => (value === "comment" ? "worklog" : value),
  z.enum(ENTITY_KINDS)
);
export const ActorKindEnum = z.enum(ACTOR_KINDS);
export const EdgeKindEnum = z.enum(EDGE_KINDS);
export const ProjectStatusEnum = z.enum(PROJECT_STATUSES);

export const PriorityEnum = z.enum(["urgent", "high", "medium", "low", "none"]);
export const RecurrenceAnchorEnum = z.enum(RECURRENCE_ANCHORS);
export const RecurrenceFrequencyEnum = z.enum(["hourly", "daily", "weekly", "monthly", "yearly"]);
export const WeekdayEnum = z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
export const CanonicalTaskStatusEnum = z.enum([
  "open",
  "in_progress",
  "done",
  "rejected"
]);
export const TaskStatusEnum = z.preprocess(
  (value) => (value === "delayed" || value === "archived" ? "done" : value),
  CanonicalTaskStatusEnum
);

export const Uuid = z.string().uuid();

/** Internal write input — used by entities.write(). REST/MCP entry points
 *  validate against the kind-specific schemas below first. */
export const WriteInput = z.object({
  kind: EntityKindEnum,
  projectId: Uuid.nullish(),
  title: z.string().max(500).nullish(),
  body: z.string().default(""),
  tags: z.array(z.string()).default([]),
  status: z.string().default("open"),
  parentId: Uuid.nullish(),
  actorKind: ActorKindEnum.default("human"),
  /** Token that authenticated the write. Set by the transport from the
   *  request credential, never accepted from a request body. */
  actorTokenId: Uuid.nullish(),
  metadata: z.record(z.unknown()).default({}),
  dueAt: z.coerce.date().nullish(),
  priority: PriorityEnum.default("none"),
  pinned: z.boolean().default(false),
  /** Explicit completion timestamp; only valid on a task written with status 'done'. */
  completedAt: z.coerce.date().nullish(),
  idempotencyKey: z.string().min(1).max(200).nullish()
});
export type WriteInput = z.infer<typeof WriteInput>;

/** Request-derived attribution passed alongside kind-specific create inputs. */
export interface WriteAttribution {
  actorTokenId?: string | null;
}

/** Create a task. Title required, body optional, dueAt + priority + status
 *  apply natively. */
export const CreateTaskInput = z.object({
  projectId: Uuid.nullish(),
  title: z.string().min(1).max(500),
  body: z.string().default(""),
  tags: z.array(z.string()).default([]),
  status: TaskStatusEnum.default("open"),
  parentId: Uuid.nullish(),
  actorKind: ActorKindEnum.default("human"),
  metadata: z.record(z.unknown()).default({}),
  dueAt: z.coerce.date().nullish(),
  priority: PriorityEnum.default("none"),
  /** Backdated completion timestamp; only valid together with status 'done'. */
  completedAt: z.coerce.date().nullish(),
  idempotencyKey: z.string().min(1).max(200).nullish()
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

/** Capture a note. Title is optional (body's first line acts as label).
 *  Status / due / priority don't apply. parentId links a note to a task. */
export const CreateNoteInput = z.object({
  projectId: Uuid.nullish(),
  title: z.string().max(500).nullish(),
  body: z.string().default(""),
  tags: z.array(z.string()).default([]),
  parentId: Uuid.nullish(),
  actorKind: ActorKindEnum.default("human"),
  metadata: z.record(z.unknown()).default({}),
  pinned: z.boolean().default(false),
  /** Id (or unambiguous prefix) of an existing entity this note replaces.
   *  A 'supersedes' edge is created and the old entity is downweighted in search. */
  supersedes: z.string().min(4).max(64).nullish(),
  idempotencyKey: z.string().min(1).max(200).nullish()
});
export type CreateNoteInput = z.infer<typeof CreateNoteInput>;

/** Append a worklog entry to a task or note. Entries are append-only: they
 *  cannot be updated afterwards, only added or deleted. */
export const CreateWorklogEntryInput = z.object({
  body: z.string().min(1),
  actorKind: ActorKindEnum.default("human"),
  metadata: z.record(z.unknown()).default({}),
  idempotencyKey: z.string().min(1).max(200).nullish()
});
export type CreateWorklogEntryInput = z.infer<typeof CreateWorklogEntryInput>;

export const FeedbackCategoryEnum = z.enum(FEEDBACK_CATEGORIES);

/** Product feedback about botnote itself, filed by agents (or humans) while
 *  using it: bugs hit, missing features, workflow friction, improvement ideas. */
export const CreateFeedbackInput = z.object({
  category: FeedbackCategoryEnum,
  title: z.string().min(1).max(500),
  body: z.string().default(""),
  /** Project the reporter was working in when the issue surfaced (context, optional). */
  projectId: Uuid.nullish(),
  /** Tool or surface involved, e.g. "search", "opening_brief", "web-ui". */
  tool: z.string().max(100).nullish(),
  actorKind: ActorKindEnum.default("agent"),
  metadata: z.record(z.unknown()).default({}),
  idempotencyKey: z.string().min(1).max(200).nullish()
});
export type CreateFeedbackInput = z.infer<typeof CreateFeedbackInput>;

export const ListFeedbackInput = z.object({
  category: FeedbackCategoryEnum.nullish(),
  status: CanonicalTaskStatusEnum.nullish(),
  limit: z.number().int().min(1).max(100).default(20)
});
export type ListFeedbackInput = z.infer<typeof ListFeedbackInput>;

export const GetByKeyInput = z.object({
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  sequenceId: z.number().int().positive()
});
export type GetByKeyInput = z.infer<typeof GetByKeyInput>;

export const UpdateInput = z
  .object({
    projectId: Uuid.nullable().optional(),
    title: z.string().max(500).nullable().optional(),
    body: z.string().optional(),
    bodyAppend: z.string().optional(),
    tags: z.array(z.string()).optional(),
    status: TaskStatusEnum.optional(),
    metadata: z.record(z.unknown()).optional(),
    parentId: Uuid.nullable().optional(),
    dueAt: z.coerce.date().nullable().optional(),
    priority: PriorityEnum.optional(),
    pinned: z.boolean().optional(),
    /** Override the completion timestamp of a done task; null clears it. */
    completedAt: z.coerce.date().nullable().optional(),
    recurrenceScope: z.enum(["this", "future"]).optional()
  })
  .refine((v) => !(v.body !== undefined && v.bodyAppend !== undefined), {
    message: "body and bodyAppend are mutually exclusive"
  });
export type UpdateInput = z.infer<typeof UpdateInput>;

const PositiveInterval = z.number().int().min(1).max(999);

const RecurrenceFields = z.object({
  rrule: z.string().min(1).max(1000).optional(),
  preset: RecurrenceFrequencyEnum.optional(),
  interval: PositiveInterval.default(1),
  byWeekday: z.array(WeekdayEnum).optional(),
  byMonthDay: z.array(z.number().int().min(1).max(31)).optional(),
  bySetPos: z.number().int().min(-5).max(5).optional(),
  byMonth: z.array(z.number().int().min(1).max(12)).optional(),
  until: z.coerce.date().nullable().optional(),
  count: z.number().int().min(1).max(10000).nullable().optional(),
  dtstart: z.coerce.date().optional(),
  timezone: z.string().min(1).max(80).optional(),
  allDay: z.boolean().default(true),
  anchor: RecurrenceAnchorEnum.default("scheduled")
});

export const RecurrenceInput = RecurrenceFields
  .refine((value) => value.rrule || value.preset, {
    message: "Provide either rrule or preset"
  })
  .refine((value) => !(value.until && value.count), {
    message: "Use either until or count, not both"
});
export type RecurrenceInput = z.infer<typeof RecurrenceInput>;

export const UpdateRecurrenceInput = RecurrenceFields.partial().extend({
  enabled: z.boolean().optional()
});
export type UpdateRecurrenceInput = z.infer<typeof UpdateRecurrenceInput>;

export const StopRecurrenceInput = z.object({
  reason: z.string().max(500).optional()
});
export type StopRecurrenceInput = z.infer<typeof StopRecurrenceInput>;

/** Fork a recurrence series at its current occurrence: freeze the old rule and
 *  apply a new cadence going forward. No dtstart — the fork point is derived
 *  from the current occurrence. allDay/timezone/anchor inherit the old rule when
 *  omitted. */
export const SplitRecurrenceInput = z
  .object({
    rrule: z.string().min(1).max(1000).optional(),
    preset: RecurrenceFrequencyEnum.optional(),
    interval: PositiveInterval.default(1),
    byWeekday: z.array(WeekdayEnum).optional(),
    byMonthDay: z.array(z.number().int().min(1).max(31)).optional(),
    bySetPos: z.number().int().min(-5).max(5).optional(),
    byMonth: z.array(z.number().int().min(1).max(12)).optional(),
    until: z.coerce.date().nullable().optional(),
    count: z.number().int().min(1).max(10000).nullable().optional(),
    timezone: z.string().min(1).max(80).optional(),
    allDay: z.boolean().optional(),
    anchor: RecurrenceAnchorEnum.optional()
  })
  .refine((value) => value.rrule || value.preset, {
    message: "Provide either rrule or preset"
  })
  .refine((value) => !(value.until && value.count), {
    message: "Use either until or count, not both"
  });
export type SplitRecurrenceInput = z.infer<typeof SplitRecurrenceInput>;

export const SkipOccurrenceInput = z.object({
  reason: z.string().max(500).optional(),
  actorKind: ActorKindEnum.default("human")
});
export type SkipOccurrenceInput = z.infer<typeof SkipOccurrenceInput>;

export const SearchInput = z.object({
  query: z.string().min(1),
  projectId: Uuid.nullish(),
  kind: EntityKindEnum.nullish(),
  limit: z.number().int().min(1).max(100).default(10)
});
export type SearchInput = z.infer<typeof SearchInput>;

export const RecentInput = z.object({
  projectId: Uuid.nullish(),
  since: z.coerce.date().nullish(),
  kinds: z.array(EntityKindEnum).nullish(),
  limit: z.number().int().min(1).max(100).default(20)
});
export type RecentInput = z.infer<typeof RecentInput>;

export const TasksRangeInput = z.object({
  from: z.coerce.date().nullish(),
  to: z.coerce.date().nullish(),
  projectIds: z.array(Uuid).nullish(),
  includeBacklog: z.boolean().default(true),
  includeDone: z.boolean().default(false),
  includeVirtualRecurrences: z.boolean().default(false)
});
export type TasksRangeInput = z.infer<typeof TasksRangeInput>;

export const LinkInput = z.object({
  fromId: Uuid,
  toId: Uuid,
  kind: EdgeKindEnum
});
export type LinkInput = z.infer<typeof LinkInput>;

export const OpeningBriefInput = z.object({
  projectId: Uuid.nullish(),
  recentLimit: z.number().int().min(1).max(50).default(10)
});
export type OpeningBriefInput = z.infer<typeof OpeningBriefInput>;

const HexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "color must be a 6-digit hex color, e.g. #5e6ad2");

const IconName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9_-]+$/, "icon must be a lowercase identifier");

export const CreateProjectInput = z
  .object({
    key: z
      .string()
      .min(1)
      .max(20)
      .regex(/^[A-Z][A-Z0-9_]*$/),
    name: z.string().min(1).max(200),
    status: ProjectStatusEnum.default("active"),
    color: HexColor.default("#5e6ad2"),
    icon: IconName.default("circle"),
    agentsMd: z.string().default("")
  })
  .strict();
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const UpdateProjectInput = z
  .object({
    name: z.string().min(1).max(200).optional(),
    status: ProjectStatusEnum.optional(),
    color: HexColor.optional(),
    icon: IconName.optional(),
    agentsMd: z.string().optional()
  })
  .strict();
export type UpdateProjectInput = z.infer<typeof UpdateProjectInput>;

export const ListProjectsInput = z.object({
  includeArchived: z.boolean().default(false)
});
export type ListProjectsInput = z.infer<typeof ListProjectsInput>;

export const CreateTokenInput = z.object({
  name: z.string().min(1).max(200)
});
export type CreateTokenInput = z.infer<typeof CreateTokenInput>;

export const EmbeddingProviderEnum = z.enum(["openai", "openai_compatible"]);
export type EmbeddingProvider = z.infer<typeof EmbeddingProviderEnum>;

export const UpdateEmbeddingSettingsInput = z.object({
  enabled: z.boolean().optional(),
  provider: EmbeddingProviderEnum.optional(),
  model: z.string().min(1).max(200).optional(),
  baseUrl: z.string().url().nullable().optional(),
  apiKey: z.string().max(1000).nullable().optional()
});
export type UpdateEmbeddingSettingsInput = z.infer<typeof UpdateEmbeddingSettingsInput>;

export const UpdateWorkspaceSettingsInput = z.object({
  timezone: z.string().min(1).max(80).optional()
});
export type UpdateWorkspaceSettingsInput = z.infer<typeof UpdateWorkspaceSettingsInput>;

export const EmbeddingBackfillInput = z.object({
  limit: z.number().int().min(1).max(100000).optional()
});
export type EmbeddingBackfillInput = z.infer<typeof EmbeddingBackfillInput>;

export const ListTagsInput = z.object({
  projectId: Uuid.nullish()
});
export type ListTagsInput = z.infer<typeof ListTagsInput>;

export const GetLinksInput = z.object({
  id: z.string().uuid(),
  kind: z.enum(EDGE_KINDS).nullish(),
  direction: z.enum(["outgoing", "incoming", "both"]).default("both")
});
export type GetLinksInput = z.infer<typeof GetLinksInput>;
