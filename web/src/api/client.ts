import type {
  CreateNoteInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateWorklogEntryInput,
  CreatedToken,
  Entity,
  EntityRevision,
  ListFeedbackInput,
  OpeningBriefResponse,
  Project,
  RecentInput,
  RecurrenceDetails,
  RecurrenceInput,
  RecurrenceRule,
  SearchInput,
  SearchResponse,
  SkipOccurrenceResult,
  SplitRecurrenceInput,
  TasksRangeInput,
  TasksRangeResult,
  Token,
  EmbeddingBackfillResponse,
  EmbeddingSettings,
  UpdateEmbeddingSettingsInput,
  UpdateEntityInput,
  UpdateProjectInput,
  WorkspaceSettings,
  UpdateWorkspaceSettingsInput,
  WriteEntityInput
} from "./types";

const BASE_URL = "";
const LOGIN_PATH = "/login";

/** Paths the global 401 interceptor must NOT redirect from, because they're
 *  part of the login surface itself or expected to return 401 as a status,
 *  not as a "you should log in" signal. */
const NO_REDIRECT_PATHS = new Set<string>([
  "/v1/auth/login",
  "/v1/auth/logout",
  "/v1/auth/whoami",
  "/health"
]);

function shouldRedirectOn401(path: string): boolean {
  if (typeof window === "undefined") return false;
  if (window.location.pathname === LOGIN_PATH) return false;
  for (const p of NO_REDIRECT_PATHS) {
    if (path.startsWith(p)) return false;
  }
  return true;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && init?.body !== null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    // credentials: "include" so the browser attaches the botnote_session
    // cookie on every API call, regardless of same-origin vs cross-origin
    // (in case the SPA is ever loaded from a different host than the API).
    credentials: "include",
    headers
  });
  if (res.status === 401 && shouldRedirectOn401(path)) {
    // Stash the current URL so we can land back here after login.
    const here = window.location.pathname + window.location.search;
    window.location.href = `${LOGIN_PATH}?next=${encodeURIComponent(here)}`;
    throw new Error("unauthenticated");
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean; version: string }>("/health"),

  listProjects: (opts: { includeArchived?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (opts.includeArchived) params.set("includeArchived", "true");
    const suffix = params.size ? `?${params.toString()}` : "";
    return request<Project[]>(`/v1/projects${suffix}`);
  },
  getProject: (id: string) => request<Project>(`/v1/projects/${id}`),
  getProjectByKey: (key: string) =>
    request<Project>(`/v1/projects/by-key/${encodeURIComponent(key)}`),
  createProject: (input: CreateProjectInput) =>
    request<Project>("/v1/projects", { method: "POST", body: JSON.stringify(input) }),
  updateProject: (id: string, input: UpdateProjectInput) =>
    request<Project>(`/v1/projects/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  openingBrief: (id: string, recentLimit = 10) =>
    request<OpeningBriefResponse>(`/v1/projects/${id}/opening-brief`, {
      method: "POST",
      body: JSON.stringify({ recentLimit })
    }),

  getEntity: (id: string) => request<Entity>(`/v1/entities/${id}`),
  entityRevisions: (id: string) => request<EntityRevision[]>(`/v1/entities/${id}/revisions`),
  getEntityByKey: (projectKey: string, seq: number) =>
    request<Entity>(
      `/v1/projects/by-key/${encodeURIComponent(projectKey)}/entities/by-seq/${seq}`
    ),
  createTask: (input: CreateTaskInput) =>
    request<Entity>("/v1/tasks", { method: "POST", body: JSON.stringify(input) }),
  createNote: (input: CreateNoteInput) =>
    request<Entity>("/v1/notes", { method: "POST", body: JSON.stringify(input) }),
  /** Routes to /v1/tasks or /v1/notes based on `kind`. Callers can keep using
   *  a single helper; the wire format is split. */
  writeEntity: (input: WriteEntityInput) => {
    if (input.kind === "task") {
      const { kind: _kind, ...rest } = input;
      return request<Entity>("/v1/tasks", { method: "POST", body: JSON.stringify(rest) });
    }
    const { kind: _kind, ...rest } = input;
    return request<Entity>("/v1/notes", { method: "POST", body: JSON.stringify(rest) });
  },
  updateEntity: (id: string, fields: UpdateEntityInput) =>
    request<Entity>(`/v1/entities/${id}`, {
      method: "PATCH",
      body: JSON.stringify(fields)
    }),

  deleteEntity: (id: string) =>
    request<void>(`/v1/entities/${id}`, { method: "DELETE" }),
  purgeEntity: (id: string) =>
    request<void>(`/v1/entities/${id}?purge=true`, { method: "DELETE" }),
  restoreEntity: (id: string) =>
    request<Entity>(`/v1/entities/${id}/restore`, { method: "POST" }),
  listTrash: (limit = 100) => request<Entity[]>(`/v1/trash?limit=${limit}`),

  childEntities: (id: string) => request<Entity[]>(`/v1/entities/${id}/children`),

  listWorklog: (id: string, limit = 500) =>
    request<Entity[]>(`/v1/entities/${id}/worklog?limit=${limit}`),
  addWorklogEntry: (id: string, input: CreateWorklogEntryInput) =>
    request<Entity>(`/v1/entities/${id}/worklog`, {
      method: "POST",
      body: JSON.stringify(input)
    }),

  recent: (input: RecentInput = {}) =>
    request<Entity[]>("/v1/recent", { method: "POST", body: JSON.stringify(input) }),

  search: (input: SearchInput) =>
    request<SearchResponse>("/v1/search", { method: "POST", body: JSON.stringify(input) }),

  listFeedback: (input: ListFeedbackInput = {}) => {
    const params = new URLSearchParams();
    if (input.category) params.set("category", input.category);
    if (input.status) params.set("status", input.status);
    if (input.limit) params.set("limit", String(input.limit));
    const suffix = params.size ? `?${params.toString()}` : "";
    return request<Entity[]>(`/v1/feedback${suffix}`);
  },

  getEmbeddingSettings: () =>
    request<EmbeddingSettings>("/v1/settings/embedding"),
  updateEmbeddingSettings: (input: UpdateEmbeddingSettingsInput) =>
    request<EmbeddingSettings>("/v1/settings/embedding", {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  backfillEmbeddings: (limit?: number) =>
    request<EmbeddingBackfillResponse>("/v1/settings/embedding/backfill", {
      method: "POST",
      body: JSON.stringify(limit == null ? {} : { limit })
    }),

  getWorkspaceSettings: () =>
    request<WorkspaceSettings>("/v1/settings/workspace"),
  updateWorkspaceSettings: (input: UpdateWorkspaceSettingsInput) =>
    request<WorkspaceSettings>("/v1/settings/workspace", {
      method: "PATCH",
      body: JSON.stringify(input)
    }),

  tasksRange: (input: TasksRangeInput) =>
    request<TasksRangeResult>("/v1/tasks/range", {
      method: "POST",
      body: JSON.stringify(input)
    }),

  configureRecurrence: (taskId: string, input: RecurrenceInput) =>
    request<RecurrenceRule>(`/v1/tasks/${taskId}/recurrence`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  getRecurrence: (taskId: string) =>
    request<RecurrenceDetails>(`/v1/tasks/${taskId}/recurrence`),
  skipOccurrence: (taskId: string, reason?: string) =>
    request<SkipOccurrenceResult>(`/v1/tasks/${taskId}/skip-occurrence`, {
      method: "POST",
      body: JSON.stringify(reason ? { reason, actorKind: "human" } : { actorKind: "human" })
    }),
  stopRecurrence: (ruleId: string, reason?: string) =>
    request<RecurrenceRule>(`/v1/recurrences/${ruleId}/stop`, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {})
    }),
  splitRecurrence: (ruleId: string, input: SplitRecurrenceInput) =>
    request<RecurrenceRule>(`/v1/recurrences/${ruleId}/split`, {
      method: "POST",
      body: JSON.stringify(input)
    }),

  listTokens: () => request<Token[]>("/v1/tokens"),
  createToken: (name: string) =>
    request<CreatedToken>("/v1/tokens", { method: "POST", body: JSON.stringify({ name }) }),
  revokeToken: (id: string) => request<void>(`/v1/tokens/${id}`, { method: "DELETE" }),

  // ----- auth -----
  login: (password: string) =>
    request<{ ok: boolean; expiresAt: string }>("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ password })
    }),
  logout: () =>
    request<{ ok: boolean }>("/v1/auth/logout", { method: "POST" }),
  whoami: () =>
    request<{
      authenticated: boolean;
      via: "cookie" | "bearer" | "trusted_origin" | "auth_disabled";
      origin: "local" | "proxied" | "direct";
    }>("/v1/auth/whoami")
};
