export type EntityKind = "task" | "note" | "worklog" | "feedback";
export const ENTITY_KINDS: EntityKind[] = ["task", "note", "worklog", "feedback"];

export type FeedbackCategory = "bug" | "feature" | "friction" | "idea";
export const FEEDBACK_CATEGORIES: FeedbackCategory[] = ["bug", "feature", "friction", "idea"];

// Kinds the UI offers in QuickCreate. Worklog entries are created from a task's
// drawer / by agents via MCP, not from the global quick-create.
export const CREATABLE_KINDS: EntityKind[] = ["task", "note"];

export type ActorKind = "human" | "agent" | "system";
export const ACTOR_KINDS: ActorKind[] = ["human", "agent", "system"];

export type EdgeKind = "blocks" | "references" | "parent_of" | "supersedes";
export type ProjectStatus = "planned" | "active" | "watching" | "paused" | "archived";
export const PROJECT_STATUSES: ProjectStatus[] = [
  "planned",
  "active",
  "watching",
  "paused",
  "archived"
];

export interface Project {
  id: string;
  key: string;
  name: string;
  status: ProjectStatus;
  color: string;
  icon: string;
  agentsMd: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type Priority = "urgent" | "high" | "medium" | "low" | "none";
export const PRIORITY_LEVELS: Priority[] = ["urgent", "high", "medium", "low", "none"];

export interface Entity {
  id: string;
  projectId: string | null;
  kind: EntityKind;
  title: string | null;
  body: string;
  tags: string[];
  status: string;
  actorId: string | null;
  actorKind: ActorKind;
  actorTokenId?: string | null;
  /** Resolved author: the API token's name when written through one, else actorKind. */
  actor?: { kind: string; label: string };
  idempotencyKey: string | null;
  parentId: string | null;
  metadata: Record<string, unknown>;
  dueAt: string | null;
  priority: Priority;
  sequenceId: number | null;
  pinned: boolean;
  completedAt: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present on tasks from /v1/tasks/range: unfinished tasks that block this one. */
  blockedBy?: Blocker[];
  /** Present on tasks from list endpoints: the entity this task hangs under. */
  parent?: EntityRef | null;
  /** Present on tasks from list endpoints; null when the task has no sub-tasks. */
  subtasks?: SubtaskCounts | null;
}

/** Content of an entity as it was BEFORE update number `revision`. */
export interface EntityRevision {
  id: string;
  entityId: string;
  revision: number;
  title: string | null;
  body: string;
  tags: string[];
  priority: Priority;
  status: string;
  actorKind: ActorKind;
  actorTokenId: string | null;
  /** Who made the update that replaced this snapshot. */
  actor?: { kind: string; label: string };
  createdAt: string;
}

/** A compact pointer to another entity: KEY-SEQ (or kind/uuid-prefix) plus a display title. */
export interface EntityRef {
  id: string;
  ref: string;
  title: string;
  status: string | null;
}

export type Blocker = EntityRef;

/** Closed means done or rejected. */
export interface SubtaskCounts {
  total: number;
  closed: number;
  inProgress: number;
}

export interface VirtualOccurrence {
  virtual: true;
  id: string;
  ruleId: string;
  seriesId: string;
  occurrenceAt: string;
  dueAt: string;
  title: string | null;
  projectId: string | null;
  priority: string;
  allDay: boolean;
  timezone: string;
  rrule: string;
}

export interface TasksRangeInput {
  from?: string | null;
  to?: string | null;
  projectIds?: string[] | null;
  includeBacklog?: boolean;
  includeDone?: boolean;
  includeVirtualRecurrences?: boolean;
}

export interface TasksRangeResult {
  scheduled: Entity[];
  overdue: Entity[];
  backlog: Entity[];
  virtualOccurrences: VirtualOccurrence[];
}

export type RecurrencePreset = "hourly" | "daily" | "weekly" | "monthly" | "yearly";
export type RecurrenceAnchor = "scheduled" | "completion";
export type RecurrenceWeekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export interface RecurrenceInput {
  rrule?: string;
  preset?: RecurrencePreset;
  interval?: number;
  byWeekday?: RecurrenceWeekday[];
  byMonthDay?: number[];
  bySetPos?: number;
  byMonth?: number[];
  until?: string | null;
  count?: number | null;
  dtstart?: string;
  timezone?: string;
  allDay?: boolean;
  anchor?: RecurrenceAnchor;
}

// Split forks at the current occurrence; the fork point is derived server-side,
// so there is no dtstart.
export type SplitRecurrenceInput = Omit<RecurrenceInput, "dtstart">;

export interface RecurrenceRule {
  id: string;
  seriesId: string;
  currentOccurrenceId: string | null;
  enabled: boolean;
  rrule: string;
  dtstart: string;
  timezone: string;
  allDay: boolean;
  anchor: RecurrenceAnchor;
  maxInstancesAhead: number;
  generatedCount: number;
  lastOccurrenceAt: string | null;
  nextOccurrenceAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecurrenceDetails {
  rule: RecurrenceRule;
  currentOccurrence: Entity | null;
}

export interface SkipOccurrenceResult {
  skipped: Entity;
  next: Entity | null;
  rule: RecurrenceRule;
}

export interface SearchHit {
  entity: Entity;
  score: number;
  components: {
    bm25?: number;
    cosine?: number;
    timeDecay?: number;
    accessBoost?: number;
  };
  superseded?: boolean;
}

export interface SearchResponse {
  hits: SearchHit[];
  embeddingUsed: boolean;
}

export type EmbeddingProvider = "openai" | "openai_compatible";
export type EmbeddingApiKeySource = "settings" | "environment" | "injected" | null;
export type EmbeddingStatusReason =
  | "ready"
  | "disabled"
  | "missing_api_key"
  | "missing_base_url"
  | "injected"
  | "not_loaded";

export interface EmbeddingSettings {
  enabled: boolean;
  effectiveEnabled: boolean;
  provider: EmbeddingProvider;
  model: string;
  baseUrl: string | null;
  dimensions: number;
  apiKeyConfigured: boolean;
  settingsApiKeyConfigured: boolean;
  apiKeySource: EmbeddingApiKeySource;
  apiKeyPreview: string | null;
  statusReason: EmbeddingStatusReason;
  pendingCount: number;
  totalCount: number;
  embeddedCount: number;
  missingCount: number;
  updatedAt: string;
}

export interface UpdateEmbeddingSettingsInput {
  enabled?: boolean;
  provider?: EmbeddingProvider;
  model?: string;
  baseUrl?: string | null;
  apiKey?: string | null;
}

export interface EmbeddingBackfillResponse {
  enqueued: number;
  pendingCount: number;
  settings: EmbeddingSettings;
}

export interface OpeningBriefResponse {
  project: Project | null;
  agentsMd: string;
  pinnedNotes: Entity[];
  openTasks: Entity[];
  recent: Entity[];
  generatedAt: string;
  markdown: string;
}

export interface CreateTaskInput {
  projectId?: string | null;
  title: string;
  body?: string;
  tags?: string[];
  status?: string;
  parentId?: string | null;
  actorKind?: ActorKind;
  metadata?: Record<string, unknown>;
  dueAt?: string | null;
  priority?: Priority;
  idempotencyKey?: string | null;
}

export interface CreateNoteInput {
  projectId?: string | null;
  title?: string | null;
  body?: string;
  tags?: string[];
  parentId?: string | null;
  actorKind?: ActorKind;
  metadata?: Record<string, unknown>;
  pinned?: boolean;
  /** Existing note this one replaces (downweighted in search). */
  supersedes?: string | null;
  idempotencyKey?: string | null;
}

export interface CreateWorklogEntryInput {
  body: string;
  actorKind?: ActorKind;
  idempotencyKey?: string | null;
}

/** Convenience: the union the QuickCreate modal builds, with `kind` to route
 *  to /v1/tasks or /v1/notes. The client helper splits it for you. */
export type WriteEntityInput =
  | ({ kind: "task" } & CreateTaskInput)
  | ({ kind: "note" } & CreateNoteInput);

export interface UpdateEntityInput {
  title?: string | null;
  body?: string;
  tags?: string[];
  status?: string;
  metadata?: Record<string, unknown>;
  parentId?: string | null;
  dueAt?: string | null;
  priority?: Priority;
  pinned?: boolean;
  completedAt?: string | null;
  recurrenceScope?: "this" | "future";
}

export interface CreateProjectInput {
  key: string;
  name: string;
  status?: ProjectStatus;
  color?: string;
  icon?: string;
  agentsMd?: string;
}

export interface UpdateProjectInput {
  name?: string;
  status?: ProjectStatus;
  color?: string;
  icon?: string;
  agentsMd?: string;
}

export interface Token {
  id: string;
  name: string;
  prefix: string;
  plaintext: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreatedToken extends Token {
  /** Plaintext token. New tokens keep this available in Settings for copying. */
  plaintext: string;
}

export interface RecentInput {
  projectId?: string | null;
  since?: string | null;
  kinds?: EntityKind[] | null;
  limit?: number;
}

export type FeedbackStatus = "open" | "in_progress" | "done" | "rejected";

export interface ListFeedbackInput {
  category?: FeedbackCategory | null;
  status?: FeedbackStatus | null;
  limit?: number;
}

export interface SearchInput {
  query: string;
  projectId?: string | null;
  kind?: EntityKind | null;
  limit?: number;
}

export interface WorkspaceSettings {
  timezone: string;
  updatedAt: string;
}

export interface UpdateWorkspaceSettingsInput {
  timezone?: string;
}
