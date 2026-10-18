/**
 * HTTP client used by the stdio MCP server to talk to the botnote daemon.
 *
 * The MCP server used to import drizzle and hit the DB directly. That coupled
 * the MCP process to the daemon's machine and required DATABASE_URL. The
 * plugin model needs the MCP to be runnable on any machine — laptop, private
 * network, public — pointing at whichever botnote daemon the user can reach.
 *
 * Auth model mirrors the daemon's:
 *   - direct private-network/localhost: no token required when the daemon trusts it
 *   - through Cloudflare Tunnel: bearer + optional CF Access service token
 */

import { BotnoteUnreachableError } from "../config.js";

const VERSION_HEADER = "x-botnote-mcp-version";

export interface HttpClientOptions {
  baseUrl: string;
  token?: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
  version?: string;
}

export class BotnoteHttpError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: string
  ) {
    super(`HTTP ${status} ${statusText}: ${body}`);
  }
}

/** A 404 for the route itself, as opposed to a route reporting a missing entity. */
function isMissingRoute(err: unknown): boolean {
  if (!(err instanceof BotnoteHttpError) || err.status !== 404) return false;
  try {
    const parsed = JSON.parse(err.body) as { path?: unknown; message?: unknown };
    return parsed.path !== undefined || String(parsed.message ?? "").startsWith("Route ");
  } catch {
    return false;
  }
}

export class BotnoteHttpClient {
  constructor(private opts: HttpClientOptions) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = new URL(path, this.opts.baseUrl);
    const headers: Record<string, string> = {
      accept: "application/json"
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    if (this.opts.cfAccessClientId) {
      headers["cf-access-client-id"] = this.opts.cfAccessClientId;
    }
    if (this.opts.cfAccessClientSecret) {
      headers["cf-access-client-secret"] = this.opts.cfAccessClientSecret;
    }
    if (this.opts.version) headers[VERSION_HEADER] = this.opts.version;

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (err) {
      throw new BotnoteUnreachableError(this.opts.baseUrl, err);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BotnoteHttpError(res.status, res.statusText, text);
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return (await res.text()) as T;
    return (await res.json()) as T;
  }

  private async worklogRequest<T>(method: string, id: string, body?: unknown): Promise<T> {
    try {
      return await this.request<T>(method, `/v1/entities/${id}/worklog`, body);
    } catch (err) {
      // Daemons before 0.2.16 only serve the old `/comments` path, and the
      // plugin can update before the daemon is redeployed.
      if (!isMissingRoute(err)) throw err;
      return this.request<T>(method, `/v1/entities/${id}/comments`, body);
    }
  }

  // ----- projects -----
  listProjects(opts: { includeArchived?: boolean } = {}) {
    const params = new URLSearchParams();
    if (opts.includeArchived) params.set("includeArchived", "true");
    const suffix = params.size ? `?${params.toString()}` : "";
    return this.request<ProjectDTO[]>("GET", `/v1/projects${suffix}`);
  }
  getProject(id: string) {
    return this.request<ProjectDTO>("GET", `/v1/projects/${id}`);
  }
  getProjectByKey(key: string) {
    return this.request<ProjectDTO>("GET", `/v1/projects/by-key/${key}`);
  }
  createProject(body: CreateProjectBody) {
    return this.request<ProjectDTO>("POST", "/v1/projects", body);
  }
  updateProject(id: string, body: UpdateProjectBody) {
    return this.request<ProjectDTO>("PATCH", `/v1/projects/${id}`, body);
  }

  // ----- opening brief -----
  openingBrief(body: { projectId?: string | null; recentLimit?: number }) {
    return this.request<OpeningBriefDTO>("POST", "/v1/opening-brief", body);
  }

  // ----- entities (read) -----
  getEntity(id: string) {
    return this.request<EntityDTO>("GET", `/v1/entities/${id}`);
  }
  getEntityByKey(projectKey: string, seq: number) {
    return this.request<EntityDTO>(
      "GET",
      `/v1/projects/by-key/${projectKey}/entities/by-seq/${seq}`
    );
  }
  listRelated(id: string) {
    return this.request<EntityDTO[]>("GET", `/v1/entities/${id}/related`);
  }
  listChildren(id: string) {
    return this.request<EntityDTO[]>("GET", `/v1/entities/${id}/children`);
  }
  listWorklog(id: string) {
    return this.worklogRequest<EntityDTO[]>("GET", id);
  }
  recent(body: RecentBody) {
    return this.request<EntityDTO[]>("POST", "/v1/recent", body);
  }
  search(body: SearchBody) {
    return this.request<{ hits: SearchHitDTO[]; embeddingUsed: boolean }>(
      "POST",
      "/v1/search",
      body
    );
  }

  // ----- entities (write) -----
  createTask(body: CreateTaskBody) {
    return this.request<EntityDTO>("POST", "/v1/tasks", body);
  }
  remember(body: CreateNoteBody) {
    return this.request<EntityDTO & { similar?: EntityDTO[] }>("POST", "/v1/notes", body);
  }
  updateEntity(id: string, body: UpdateEntityBody) {
    return this.request<EntityDTO>("PATCH", `/v1/entities/${id}`, body);
  }
  addWorklogEntry(id: string, body: CreateWorklogEntryBody) {
    return this.worklogRequest<EntityDTO>("POST", id, body);
  }
  submitFeedback(body: CreateFeedbackBody) {
    return this.request<EntityDTO>("POST", "/v1/feedback", body);
  }
  listFeedback(opts: { category?: string; status?: string; limit?: number } = {}) {
    const params = new URLSearchParams();
    if (opts.category) params.set("category", opts.category);
    if (opts.status) params.set("status", opts.status);
    if (opts.limit) params.set("limit", String(opts.limit));
    const suffix = params.size ? `?${params.toString()}` : "";
    return this.request<EntityDTO[]>("GET", `/v1/feedback${suffix}`);
  }
  configureRecurrence(taskId: string, body: RecurrenceBody) {
    return this.request<RecurrenceRuleDTO>("POST", `/v1/tasks/${taskId}/recurrence`, body);
  }
  getRecurrence(taskId: string) {
    return this.request<RecurrenceDetailsDTO>("GET", `/v1/tasks/${taskId}/recurrence`);
  }
  skipOccurrence(taskId: string, body: SkipOccurrenceBody = {}) {
    return this.request<SkipOccurrenceDTO>(
      "POST",
      `/v1/tasks/${taskId}/skip-occurrence`,
      body
    );
  }
  stopRecurrence(ruleId: string, body: StopRecurrenceBody = {}) {
    return this.request<RecurrenceRuleDTO>("POST", `/v1/recurrences/${ruleId}/stop`, body);
  }
  splitRecurrence(ruleId: string, body: SplitRecurrenceBody) {
    return this.request<RecurrenceRuleDTO>("POST", `/v1/recurrences/${ruleId}/split`, body);
  }
  link(fromId: string, body: { toId: string; kind: LinkKind }) {
    return this.request<{ created: boolean }>(
      "POST",
      `/v1/entities/${fromId}/links`,
      body
    );
  }
  tasksRange(body: TasksRangeBody) {
    return this.request<TasksRangeResultDTO>("POST", "/v1/tasks/range", body);
  }
  listTags(projectId?: string | null) {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    const suffix = params.size ? `?${params.toString()}` : "";
    return this.request<TagCountDTO[]>("GET", `/v1/tags${suffix}`);
  }
  getLinks(id: string, opts: { kind?: string | null; direction?: string } = {}) {
    const params = new URLSearchParams();
    if (opts.kind) params.set("kind", opts.kind);
    if (opts.direction) params.set("direction", opts.direction);
    const suffix = params.size ? `?${params.toString()}` : "";
    return this.request<LinkResultDTO[]>("GET", `/v1/entities/${id}/links${suffix}`);
  }
  getContext() {
    return this.request<ContextDTO>("GET", "/v1/context");
  }
}

// ----- Serialization helpers -----

/**
 * Strip internal-only fields (`bodyVec`, `bodyTsv` and their snake_case aliases)
 * from an entity DTO before including it in any outward-facing MCP response.
 * These fields are 384-dim float arrays / tsvector strings that are exclusively
 * used by the search/embedding pipeline; they add nothing for agent consumers
 * and bloat every response toward output-token truncation.
 */
export function serializeEntity(entity: EntityDTO): Omit<EntityDTO, "bodyVec" | "bodyTsv"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { bodyVec: _bv, bodyTsv: _bt, ...rest } = entity as EntityDTO & {
    bodyVec?: unknown;
    bodyTsv?: unknown;
    body_vec?: unknown;
    body_tsv?: unknown;
  };
  // Also strip snake_case aliases that may arrive from older REST responses.
  delete (rest as Record<string, unknown>).body_vec;
  delete (rest as Record<string, unknown>).body_tsv;
  return rest;
}

// ----- DTO shapes (mirror REST output; intentionally permissive to avoid
//       lockstep with backend changes) -----

export interface ProjectDTO {
  id: string;
  key: string;
  name: string;
  status: string;
  color: string;
  icon: string;
  agentsMd: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EntityDTO {
  id: string;
  projectId: string | null;
  kind: "task" | "note" | "worklog" | "feedback";
  title: string | null;
  body: string;
  tags: string[];
  status: string;
  parentId: string | null;
  actorKind: string;
  actorTokenId?: string | null;
  /** Resolved author: label is the token name when written via a token, else actorKind. */
  actor?: { kind: string; label: string };
  metadata: Record<string, unknown>;
  dueAt: string | null;
  priority: string;
  pinned: boolean;
  sequenceId: number | null;
  completedAt: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
  /** Present on tasks from /v1/tasks/range: unfinished tasks that block this one. */
  blockedBy?: BlockerDTO[];
}

export interface BlockerDTO {
  id: string;
  ref: string;
  title: string;
  status: string | null;
}

export interface RecurrenceRuleDTO {
  id: string;
  seriesId: string;
  currentOccurrenceId: string | null;
  enabled: boolean;
  rrule: string;
  dtstart: string;
  timezone: string;
  allDay: boolean;
  anchor: string;
  maxInstancesAhead: number;
  generatedCount: number;
  lastOccurrenceAt: string | null;
  nextOccurrenceAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecurrenceDetailsDTO {
  rule: RecurrenceRuleDTO;
  currentOccurrence: EntityDTO | null;
}

export interface SkipOccurrenceDTO {
  skipped: EntityDTO;
  next: EntityDTO | null;
  rule: RecurrenceRuleDTO;
}

export interface SearchHitDTO {
  entity: EntityDTO;
  score: number;
}

export interface OpeningBriefDTO {
  project: ProjectDTO | null;
  pinnedNotes: EntityDTO[];
  openTasks: EntityDTO[];
  latestWorklog?: EntityDTO[];
  recentActivity: EntityDTO[];
  agentsMd: string;
  markdown: string;
}

export type LinkKind = "blocks" | "references" | "parent_of" | "supersedes";

export interface CreateProjectBody {
  key: string;
  name: string;
  status?: string;
  color?: string;
  icon?: string;
  agentsMd?: string;
}

export interface UpdateProjectBody {
  name?: string;
  status?: string;
  color?: string;
  icon?: string;
  agentsMd?: string;
}

export interface CreateTaskBody {
  projectId?: string | null;
  title: string;
  body?: string;
  tags?: string[];
  status?: string;
  parentId?: string | null;
  actorKind?: string;
  dueAt?: string | null;
  priority?: string;
  completedAt?: string | null;
  idempotencyKey?: string;
}

export interface CreateNoteBody {
  projectId?: string | null;
  title?: string | null;
  body?: string;
  tags?: string[];
  parentId?: string | null;
  actorKind?: string;
  pinned?: boolean;
  supersedes?: string | null;
  idempotencyKey?: string;
}

export interface CreateFeedbackBody {
  category: "bug" | "feature" | "friction" | "idea";
  title: string;
  body?: string;
  projectId?: string | null;
  tool?: string | null;
  actorKind?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface CreateWorklogEntryBody {
  body: string;
  actorKind?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface UpdateEntityBody {
  projectId?: string | null;
  title?: string | null;
  body?: string;
  bodyAppend?: string;
  tags?: string[];
  status?: string;
  parentId?: string | null;
  dueAt?: string | null;
  priority?: string;
  pinned?: boolean;
  completedAt?: string | null;
  recurrenceScope?: "this" | "future";
}

export interface RecurrenceBody {
  rrule?: string;
  preset?: "hourly" | "daily" | "weekly" | "monthly" | "yearly";
  interval?: number;
  byWeekday?: Array<"MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU">;
  byMonthDay?: number[];
  bySetPos?: number;
  byMonth?: number[];
  until?: string | null;
  count?: number | null;
  dtstart?: string;
  timezone?: string;
  allDay?: boolean;
  anchor?: "scheduled" | "completion";
}

export interface SkipOccurrenceBody {
  reason?: string;
  actorKind?: string;
}

export interface StopRecurrenceBody {
  reason?: string;
}

// Split forks at the current occurrence; the fork point is derived server-side,
// so there is no dtstart.
export type SplitRecurrenceBody = Omit<RecurrenceBody, "dtstart">;

export interface RecentBody {
  projectId?: string | null;
  since?: string | null;
  kinds?: string[];
  limit?: number;
}

export interface SearchBody {
  query: string;
  projectId?: string | null;
  kind?: string;
  limit?: number;
}

export interface TasksRangeBody {
  from?: string | null;
  to?: string | null;
  projectId?: string | null;
  projectIds?: string[] | null;
  includeBacklog?: boolean;
  includeDone?: boolean;
  includeVirtualRecurrences?: boolean;
}

export interface VirtualOccurrenceDTO {
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

export interface TasksRangeResultDTO {
  scheduled: EntityDTO[];
  overdue: EntityDTO[];
  backlog: EntityDTO[];
  virtualOccurrences: VirtualOccurrenceDTO[];
}

export interface TagCountDTO {
  tag: string;
  count: number;
}

export interface LinkResultDTO {
  kind: string;
  direction: "outgoing" | "incoming";
  entity: EntityDTO;
}

export interface ContextDTO {
  now: string;
  timezone: string;
  version: string;
  projects: Array<{ key: string; name: string; status: string }>;
}
