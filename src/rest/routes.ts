import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { z } from "zod";
import type { Entity, Token } from "../db/schema.js";
import {
  addWorklogEntry,
  bumpAccess,
  get,
  getByKey,
  getLinks,
  link,
  listChildren,
  listWorklog,
  listRelated,
  listTags,
  listTrash,
  markSuperseded,
  purge,
  recent,
  remove,
  restore,
  update,
  write
} from "../service/entities.js";
import { attachHierarchy } from "../service/hierarchy.js";
import { formatOpeningBrief, openingBrief } from "../service/opening_brief.js";
import {
  createProject,
  getProject,
  getProjectByKey,
  listProjects,
  updateProject
} from "../service/projects.js";
import { findSimilar, search } from "../service/search.js";
import type { Scope } from "../service/scope.js";
import { listFeedback, submitFeedback } from "../service/feedback.js";
import {
  embeddingCoverage,
  getEmbeddingSettings,
  updateEmbeddingSettings
} from "../service/embedding_settings.js";
import {
  getWorkspaceSettings,
  updateWorkspaceSettings
} from "../service/workspace_settings.js";
import {
  createSession,
  revokeSession,
  verifyMasterPassword
} from "../service/sessions.js";
import {
  createRecurrenceRule,
  getRecurrenceForTask,
  skipOccurrence,
  splitRecurrence,
  stopRecurrence,
  updateRecurrenceRule
} from "../service/recurrence.js";
import { listRevisions } from "../service/revisions.js";
import { tasksRange } from "../service/tasks.js";
import { exportWorkspace, importWorkspace } from "../service/transfer.js";
import { createToken, listTokens, revokeToken, tokenLabels } from "../service/tokens.js";
import {
  CreateFeedbackInput,
  CreateNoteInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateWorklogEntryInput,
  CreateTokenInput,
  EmbeddingBackfillInput,
  GetLinksInput,
  LinkInput,
  ListFeedbackInput,
  ListProjectsInput,
  ListTagsInput,
  OpeningBriefInput,
  RecentInput,
  RecurrenceInput,
  SearchInput,
  SkipOccurrenceInput,
  SplitRecurrenceInput,
  StopRecurrenceInput,
  TasksRangeInput,
  UpdateEmbeddingSettingsInput,
  UpdateInput,
  UpdateProjectInput,
  UpdateRecurrenceInput,
  UpdateWorkspaceSettingsInput,
  Uuid
} from "../service/types.js";
import { VERSION } from "../version.js";
import { attachActorLabels } from "./attribution.js";
import { requestOrigin } from "./auth.js";
import type { ServerContext } from "./server.js";

const IdParams = z.object({ id: Uuid });
const EntityIdRef = z.string().min(8).max(36).regex(/^[0-9a-fA-F-]+$/);
const EntityIdParams = z.object({ id: EntityIdRef });
const RuleIdParams = z.object({ id: Uuid });
const KeyParams = z.object({ key: z.string() });
const BooleanQuery = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value === "true" || value === "1";
  return value;
}, z.boolean());
const ListProjectsQuery = z.object({
  includeArchived: BooleanQuery.default(false)
});
const ExportQuery = z.object({
  vectors: BooleanQuery.default(false)
});
const KeySeqParams = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  seq: z.coerce.number().int().positive()
});
const OpeningBriefBody = OpeningBriefInput.omit({ projectId: true }).optional();
const LinkBody = LinkInput.omit({ fromId: true });

/**
 * Strip `bodyVec` and `bodyTsv` from an entity before sending it over the wire.
 * Both fields are internal-only: `bodyVec` is the 384-dim embedding used by
 * hybrid search, and `bodyTsv` is the tsvector used by BM25 — neither is
 * useful to REST consumers (web or agent) and both add significant token noise.
 */
function serializeEntity(e: Entity) {
  const { bodyVec: _bv, bodyTsv: _bt, ...rest } = e;
  return rest;
}

function serializeEntities(rows: Entity[]) {
  return rows.map(serializeEntity);
}

function publicToken(t: Token) {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    plaintext: t.plaintext,
    lastUsedAt: t.lastUsedAt,
    createdAt: t.createdAt
  };
}

async function workspaceSettingsResponse(scope: Scope, db: ServerContext["db"]) {
  const settings = await getWorkspaceSettings(scope, db);
  return {
    timezone: settings.timezone,
    updatedAt: settings.updatedAt
  };
}

async function embeddingSettingsResponse(scope: Scope, ctx: ServerContext) {
  const settings = await getEmbeddingSettings(scope, ctx.db);
  const coverage = await embeddingCoverage(scope, ctx.db);
  const runtime = ctx.embedding.runtimeStatus();
  return {
    enabled: settings.enabled,
    effectiveEnabled: runtime.enabled,
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    dimensions: settings.dimensions,
    apiKeyConfigured: runtime.apiKeyConfigured,
    settingsApiKeyConfigured: Boolean(settings.apiKey),
    apiKeySource: runtime.apiKeySource,
    apiKeyPreview: runtime.apiKeyPreview,
    statusReason: runtime.reason,
    pendingCount: ctx.embedding.pendingCount(),
    totalCount: coverage.totalCount,
    embeddedCount: coverage.embeddedCount,
    missingCount: coverage.missingCount,
    updatedAt: settings.updatedAt
  };
}

export async function registerRoutes(
  rawApp: FastifyInstance,
  ctx: ServerContext
): Promise<void> {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  // Additive `actor: { kind, label }` on every serialized entity, resolved
  // from the token that wrote it. Centralised here so the entity-returning
  // routes (and anything nested: hits, links, briefs) stay unaware of it.
  app.addHook("preSerialization", async (req, _reply, payload) => {
    if (!req.url.startsWith("/v1/")) return payload;
    return attachActorLabels(payload, () => tokenLabels(req.scope, ctx.db));
  });

  app.get("/health", async () => {
    const embedding = ctx.embedding.runtimeStatus();
    return {
      ok: true,
      version: VERSION,
      embedding: {
        enabled: embedding.enabled,
        provider: embedding.provider,
        model: embedding.model,
        dimensions: embedding.dimensions,
        reason: embedding.reason
      }
    };
  });

  // ----- settings -----

  app.get(
    "/v1/settings/embedding",
    {
      schema: {
        tags: ["settings"],
        summary: "Read embedding provider/model/key status and vector coverage"
      }
    },
    async (req) => embeddingSettingsResponse(req.scope, ctx)
  );

  app.patch(
    "/v1/settings/embedding",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
      schema: {
        tags: ["settings"],
        summary: "Update embedding provider/model/key settings",
        body: UpdateEmbeddingSettingsInput
      }
    },
    async (req) => {
      const body = UpdateEmbeddingSettingsInput.parse(req.body);
      await updateEmbeddingSettings(req.scope, ctx.db, body);
      await ctx.embedding.reloadConfig();
      return embeddingSettingsResponse(req.scope, ctx);
    }
  );

  app.post(
    "/v1/settings/embedding/backfill",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
      schema: {
        tags: ["settings"],
        summary: "Queue missing embeddings for existing notes and tasks",
        body: EmbeddingBackfillInput.optional()
      }
    },
    async (req) => {
      const body = EmbeddingBackfillInput.parse(req.body ?? {});
      const coverage = await embeddingCoverage(req.scope, ctx.db);
      const limit = body.limit ?? coverage.missingCount;
      const queued =
        limit > 0
          ? await ctx.embedding.enqueueMissing(limit)
          : { enqueued: 0, pendingCount: ctx.embedding.pendingCount() };
      return {
        ...queued,
        settings: await embeddingSettingsResponse(req.scope, ctx)
      };
    }
  );

  app.get(
    "/v1/settings/workspace",
    {
      schema: {
        tags: ["settings"],
        summary: "Read workspace settings (timezone)"
      }
    },
    async (req) => workspaceSettingsResponse(req.scope, ctx.db)
  );

  app.patch(
    "/v1/settings/workspace",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
      schema: {
        tags: ["settings"],
        summary: "Update workspace settings (timezone)",
        body: UpdateWorkspaceSettingsInput
      }
    },
    async (req) => {
      const body = UpdateWorkspaceSettingsInput.parse(req.body);
      await updateWorkspaceSettings(req.scope, ctx.db, body);
      return workspaceSettingsResponse(req.scope, ctx.db);
    }
  );

  // ----- context -----

  app.get(
    "/v1/context",
    {
      schema: {
        tags: ["context"],
        summary: "Server time, workspace timezone, version, and project list for agent date-math"
      }
    },
    async (req) => {
      const [settings, projects] = await Promise.all([
        getWorkspaceSettings(req.scope, ctx.db),
        listProjects(req.scope, ctx.db, { includeArchived: false })
      ]);
      return {
        now: new Date().toISOString(),
        timezone: settings.timezone,
        version: VERSION,
        projects: projects.map((p) => ({ key: p.key, name: p.name, status: p.status }))
      };
    }
  );

  // ----- projects -----

  app.post(
    "/v1/projects",
    { schema: { tags: ["projects"], summary: "Create a project", body: CreateProjectInput } },
    async (req) => createProject(req.scope, ctx.db, CreateProjectInput.parse(req.body))
  );

  app.get(
    "/v1/projects",
    {
      schema: {
        tags: ["projects"],
        summary: "List non-archived projects",
        querystring: ListProjectsQuery
      }
    },
    async (req) => {
      const query = ListProjectsInput.parse(ListProjectsQuery.parse(req.query));
      return listProjects(req.scope, ctx.db, query);
    }
  );

  app.get(
    "/v1/projects/:id",
    { schema: { tags: ["projects"], summary: "Fetch a project by id (includes AGENTS.md)", params: IdParams } },
    async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const p = await getProject(req.scope, ctx.db, id);
      if (!p) return reply.code(404).send({ error: "not_found" });
      return p;
    }
  );

  app.patch(
    "/v1/projects/:id",
    {
      schema: {
        tags: ["projects"],
        summary: "Update project (status, name, color, icon, agents_md)",
        params: IdParams,
        body: UpdateProjectInput
      }
    },
    async (req) => {
      const { id } = IdParams.parse(req.params);
      const body = UpdateProjectInput.parse(req.body);
      return updateProject(req.scope, ctx.db, id, body);
    }
  );

  app.get(
    "/v1/projects/by-key/:key",
    { schema: { tags: ["projects"], summary: "Fetch a project by key", params: KeyParams } },
    async (req, reply) => {
      const { key } = KeyParams.parse(req.params);
      const p = await getProjectByKey(req.scope, ctx.db, key);
      if (!p) return reply.code(404).send({ error: "not_found" });
      return p;
    }
  );

  app.post(
    "/v1/projects/:id/opening-brief",
    {
      schema: {
        tags: ["brief"],
        summary: "Opening brief for a project",
        description:
          "Returns the agent context bundle: AGENTS.md, pinned notes, open tasks, and recent activity. Also returns a markdown-formatted version.",
        params: IdParams,
        body: OpeningBriefBody
      }
    },
    async (req) => {
      const { id } = IdParams.parse(req.params);
      const bodyOpts = OpeningBriefBody.parse(req.body);
      const input = OpeningBriefInput.parse({ projectId: id, recentLimit: bodyOpts?.recentLimit });
      const brief = await openingBrief(req.scope, ctx.db, input);
      return {
        ...brief,
        pinnedNotes: serializeEntities(brief.pinnedNotes),
        openTasks: serializeEntities(brief.openTasks),
        latestWorklog: serializeEntities(brief.latestWorklog),
        // Pre-0.2.16 plugins read the old field name.
        latestComments: serializeEntities(brief.latestWorklog),
        recent: serializeEntities(brief.recent),
        markdown: formatOpeningBrief(brief)
      };
    }
  );

  // Workspace-or-project opening brief. The path-param variant above is kept
  // for clients that already integrate against it; the MCP HTTP client and
  // new plugin code uses this single entry point and passes projectId in the
  // body (or omits it for a workspace-wide brief).
  app.post(
    "/v1/opening-brief",
    {
      schema: {
        tags: ["brief"],
        summary: "Opening brief (project-scoped or workspace-wide)",
        body: OpeningBriefInput.partial().optional()
      }
    },
    async (req) => {
      const input = OpeningBriefInput.parse(req.body ?? {});
      const brief = await openingBrief(req.scope, ctx.db, input);
      return {
        ...brief,
        pinnedNotes: serializeEntities(brief.pinnedNotes),
        openTasks: serializeEntities(brief.openTasks),
        latestWorklog: serializeEntities(brief.latestWorklog),
        // Pre-0.2.16 plugins read the old field name.
        latestComments: serializeEntities(brief.latestWorklog),
        recent: serializeEntities(brief.recent),
        markdown: formatOpeningBrief(brief)
      };
    }
  );

  // ----- entities (read) -----

  app.get(
    "/v1/entities/:id",
    { schema: { tags: ["entities"], summary: "Fetch an entity by id", params: EntityIdParams } },
    async (req, reply) => {
      const { id } = EntityIdParams.parse(req.params);
      const e = await get(req.scope, ctx.db, id);
      if (!e) return reply.code(404).send({ error: "not_found" });
      await bumpAccess(req.scope, ctx.db, e.id);
      return serializeEntity(e);
    }
  );

  app.get(
    "/v1/projects/by-key/:key/entities/by-seq/:seq",
    {
      schema: {
        tags: ["entities"],
        summary: "Fetch an entity by its human-readable identifier (e.g. DEMO-12)",
        params: KeySeqParams
      }
    },
    async (req, reply) => {
      const { key, seq } = KeySeqParams.parse(req.params);
      const e = await getByKey(req.scope, ctx.db, key, seq);
      if (!e) return reply.code(404).send({ error: "not_found" });
      await bumpAccess(req.scope, ctx.db, e.id);
      return serializeEntity(e);
    }
  );

  app.get(
    "/v1/entities/:id/revisions",
    {
      schema: {
        tags: ["entities"],
        summary:
          "Content history, newest first: each row is the title/body/tags/priority/status before one update, with who made that update",
        params: EntityIdParams
      }
    },
    async (req, reply) => {
      const { id } = EntityIdParams.parse(req.params);
      const rows = await listRevisions(req.scope, ctx.db, id);
      if (!rows) return reply.code(404).send({ error: "not_found" });
      return rows;
    }
  );

  app.get(
    "/v1/entities/:id/related",
    {
      schema: {
        tags: ["entities"],
        summary: "List entities whose parent_id is this id (e.g. notes linked to a task)",
        params: EntityIdParams
      }
    },
    async (req) => {
      const { id } = EntityIdParams.parse(req.params);
      return serializeEntities(await listRelated(req.scope, ctx.db, id));
    }
  );

  app.get(
    "/v1/entities/:id/children",
    {
      schema: {
        tags: ["entities"],
        summary:
          "List child work items (subtasks/notes) of an entity, via parentId or parent_of edges; worklog entries excluded",
        params: EntityIdParams
      }
    },
    async (req) => {
      const { id } = EntityIdParams.parse(req.params);
      return serializeEntities(await listChildren(req.scope, ctx.db, id));
    }
  );

  app.post(
    "/v1/recent",
    {
      schema: {
        tags: ["entities"],
        summary: "Recent entities (filterable by project, kinds, since)",
        body: RecentInput.optional()
      }
    },
    async (req) => {
      const rows = await recent(req.scope, ctx.db, RecentInput.parse(req.body ?? {}));
      return serializeEntities(await attachHierarchy(req.scope, ctx.db, rows));
    }
  );

  app.post(
    "/v1/search",
    {
      schema: {
        tags: ["search"],
        summary: "Hybrid retrieval (BM25 + cosine + time decay, RRF merged)",
        description:
          "If OPENAI_API_KEY is set, the query is embedded and cosine similarity is merged in via RRF. Otherwise BM25-only.",
        body: SearchInput
      }
    },
    async (req) => {
      const body = SearchInput.parse(req.body);
      const queryEmbedding = await ctx.embedding.embedQuery(body.query);
      const hits = await search(req.scope, ctx.db, body, queryEmbedding ? { queryEmbedding } : {});
      return {
        hits: hits.map((h) => ({ ...h, entity: serializeEntity(h.entity) })),
        embeddingUsed: queryEmbedding != null
      };
    }
  );

  app.post(
    "/v1/tasks/range",
    {
      schema: {
        tags: ["tasks"],
        summary: "Tasks in a date range + overdue + backlog (no due_at)",
        description:
          "Returns three buckets: scheduled (display date in [from, to)), overdue (unfinished due_at before from, or before now when from is omitted), backlog (no due_at, only when includeBacklog).",
        body: TasksRangeInput
      }
    },
    async (req) => {
      const result = await tasksRange(req.scope, ctx.db, TasksRangeInput.parse(req.body));
      return {
        scheduled: serializeEntities(result.scheduled),
        overdue: serializeEntities(result.overdue),
        backlog: serializeEntities(result.backlog),
        virtualOccurrences: result.virtualOccurrences
      };
    }
  );

  app.post(
    "/v1/tasks/:id/recurrence",
    {
      schema: {
        tags: ["recurrence"],
        summary: "Configure recurrence on a task",
        params: IdParams,
        body: RecurrenceInput
      }
    },
    async (req) => {
      const { id } = IdParams.parse(req.params);
      const body = RecurrenceInput.parse(req.body);
      return createRecurrenceRule(req.scope, ctx.db, id, body);
    }
  );

  app.get(
    "/v1/tasks/:id/recurrence",
    {
      schema: {
        tags: ["recurrence"],
        summary: "Read recurrence for a task",
        params: IdParams
      }
    },
    async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const recurrence = await getRecurrenceForTask(req.scope, ctx.db, id);
      if (!recurrence) {
        reply.code(404);
        return { error: "not_found", path: req.url };
      }
      return {
        ...recurrence,
        currentOccurrence: recurrence.currentOccurrence
          ? serializeEntity(recurrence.currentOccurrence)
          : null
      };
    }
  );

  app.patch(
    "/v1/recurrences/:id",
    {
      schema: {
        tags: ["recurrence"],
        summary: "Update a recurrence rule",
        params: RuleIdParams,
        body: UpdateRecurrenceInput
      }
    },
    async (req) => {
      const { id } = RuleIdParams.parse(req.params);
      const body = UpdateRecurrenceInput.parse(req.body);
      return updateRecurrenceRule(req.scope, ctx.db, id, body);
    }
  );

  app.post(
    "/v1/tasks/:id/skip-occurrence",
    {
      schema: {
        tags: ["recurrence"],
        summary: "Skip the current recurring occurrence and create the next one",
        params: IdParams,
        body: SkipOccurrenceInput.optional()
      }
    },
    async (req) => {
      const { id } = IdParams.parse(req.params);
      const body = SkipOccurrenceInput.parse(req.body ?? {});
      const result = await skipOccurrence(req.scope, ctx.db, id, body);
      return {
        ...result,
        skipped: serializeEntity(result.skipped),
        next: result.next ? serializeEntity(result.next) : null
      };
    }
  );

  app.post(
    "/v1/recurrences/:id/stop",
    {
      schema: {
        tags: ["recurrence"],
        summary: "Stop a recurrence series",
        params: RuleIdParams,
        body: StopRecurrenceInput.optional()
      }
    },
    async (req) => {
      const { id } = RuleIdParams.parse(req.params);
      const body = StopRecurrenceInput.parse(req.body ?? {});
      return stopRecurrence(req.scope, ctx.db, id, body);
    }
  );

  app.post(
    "/v1/recurrences/:id/split",
    {
      schema: {
        tags: ["recurrence"],
        summary: "Split a recurrence series at its current occurrence",
        params: RuleIdParams,
        body: SplitRecurrenceInput
      }
    },
    async (req) => {
      const { id } = RuleIdParams.parse(req.params);
      const body = SplitRecurrenceInput.parse(req.body);
      return splitRecurrence(req.scope, ctx.db, id, body);
    }
  );

  // ----- entities (write) -----

  app.post(
    "/v1/tasks",
    {
      schema: {
        tags: ["entities"],
        summary: "Create a task",
        body: CreateTaskInput
      }
    },
    async (req) => {
      const body = CreateTaskInput.parse(req.body);
      const entity = await write(req.scope, ctx.db, {
        ...body,
        kind: "task",
        pinned: false,
        actorTokenId: req.actorTokenId
      });
      if (ctx.embedding.isEnabled()) {
        ctx.embedding.enqueue(entity.id, `${entity.title ?? ""}\n${entity.body}`);
      }
      return serializeEntity(entity);
    }
  );

  app.post(
    "/v1/notes",
    {
      schema: {
        tags: ["entities"],
        summary: "Create a note (title optional; body's first line acts as the label)",
        body: CreateNoteInput
      }
    },
    async (req, reply) => {
      const { supersedes, ...body } = CreateNoteInput.parse(req.body);
      // Resolve the supersedes target BEFORE writing so a bad reference
      // fails the whole request instead of leaving an orphaned note.
      const supersededId = supersedes ? (await get(req.scope, ctx.db, supersedes))?.id ?? null : null;
      if (supersedes && !supersededId) {
        return reply.code(404).send({ error: `supersedes target ${supersedes} not found` });
      }
      const entity = await write(req.scope, ctx.db, {
        ...body,
        kind: "note",
        status: "open",
        priority: "none",
        dueAt: null,
        actorTokenId: req.actorTokenId
      });
      if (supersededId) {
        await markSuperseded(req.scope, ctx.db, entity.id, supersededId);
      }
      if (ctx.embedding.isEnabled()) {
        ctx.embedding.enqueue(entity.id, `${entity.title ?? ""}\n${entity.body}`);
      }
      // Dedup hint: surface near-duplicate notes so the caller can decide to
      // supersede or update instead of accumulating parallel memories. Skipped
      // when the caller already declared a supersedes target.
      let similar: Entity[] = [];
      if (!supersededId) {
        const label = (entity.title ?? entity.body.split("\n")[0] ?? "").trim().slice(0, 200);
        const queryEmbedding = label ? await ctx.embedding.embedQuery(label) : null;
        const hits = await findSimilar(req.scope, ctx.db, {
          title: entity.title,
          body: entity.body,
          projectId: entity.projectId,
          excludeId: entity.id,
          queryEmbedding: queryEmbedding ?? undefined
        });
        similar = hits.map((h) => h.entity);
      }
      return { ...serializeEntity(entity), similar: serializeEntities(similar) };
    }
  );

  const ListWorklogQuery = z.object({
    limit: z.coerce.number().int().positive().max(500).default(50)
  });

  // `/comments` is the pre-0.2.16 path. Plugins run their own MCP client
  // against this daemon, so older ones keep calling it after an upgrade.
  for (const [path, deprecated] of [
    ["/v1/entities/:id/worklog", false],
    ["/v1/entities/:id/comments", true]
  ] as const) {
    app.post(
      path,
      {
        schema: {
          tags: ["entities"],
          summary: "Append a worklog entry to a task or note",
          description:
            "Worklog entries are append-only progress notes. The latest entry per in_progress task is surfaced in the opening brief.",
          deprecated,
          params: EntityIdParams,
          body: CreateWorklogEntryInput
        }
      },
      async (req) => {
        const { id } = EntityIdParams.parse(req.params);
        const body = CreateWorklogEntryInput.parse(req.body);
        const entity = await addWorklogEntry(req.scope, ctx.db, id, body, {
          actorTokenId: req.actorTokenId
        });
        if (ctx.embedding.isEnabled()) {
          ctx.embedding.enqueue(entity.id, entity.body);
        }
        return serializeEntity(entity);
      }
    );

    app.get(
      path,
      {
        schema: {
          tags: ["entities"],
          summary: "List worklog entries for an entity, oldest first",
          deprecated,
          params: EntityIdParams,
          querystring: ListWorklogQuery
        }
      },
      async (req) => {
        const { id } = EntityIdParams.parse(req.params);
        const query = ListWorklogQuery.parse(req.query);
        return serializeEntities(await listWorklog(req.scope, ctx.db, id, query.limit));
      }
    );
  }

  app.post(
    "/v1/feedback",
    {
      schema: {
        tags: ["feedback"],
        summary: "File product feedback about botnote itself (bug/feature/friction/idea)",
        body: CreateFeedbackInput
      }
    },
    async (req) => {
      const body = CreateFeedbackInput.parse(req.body);
      const entity = await submitFeedback(req.scope, ctx.db, body, {
        actorTokenId: req.actorTokenId
      });
      if (ctx.embedding.isEnabled()) {
        ctx.embedding.enqueue(entity.id, `${entity.title ?? ""}\n${entity.body}`);
      }
      return serializeEntity(entity);
    }
  );

  app.get(
    "/v1/feedback",
    {
      schema: {
        tags: ["feedback"],
        summary: "List feedback for triage, newest first",
        querystring: z.object({
          category: z.enum(["bug", "feature", "friction", "idea"]).optional(),
          status: z.enum(["open", "in_progress", "done", "rejected"]).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20)
        })
      }
    },
    async (req) => {
      const query = ListFeedbackInput.parse(req.query);
      return serializeEntities(await listFeedback(req.scope, ctx.db, query));
    }
  );

  app.patch(
    "/v1/entities/:id",
    {
      schema: {
        tags: ["entities"],
        summary: "Update an entity (task or note)",
        params: EntityIdParams,
        body: UpdateInput
      }
    },
    async (req) => {
      const { id } = EntityIdParams.parse(req.params);
      const fields = UpdateInput.parse(req.body);
      const updated = await update(req.scope, ctx.db, id, fields, {
        actorTokenId: req.actorTokenId
      });
      if (
        ctx.embedding.isEnabled() &&
        (fields.body !== undefined || fields.bodyAppend !== undefined || fields.title !== undefined)
      ) {
        ctx.embedding.enqueue(updated.id, `${updated.title ?? ""}\n${updated.body}`);
      }
      return serializeEntity(updated);
    }
  );

  const DeleteEntityQuery = z.object({
    // ?purge=true permanently deletes an already-trashed entity; without it,
    // delete is a soft delete (moves the entity to the trash).
    purge: z.coerce.boolean().optional()
  });

  app.delete(
    "/v1/entities/:id",
    {
      schema: {
        tags: ["entities"],
        summary: "Move an entity to the trash (soft delete); ?purge=true permanently deletes a trashed entity",
        params: EntityIdParams,
        querystring: DeleteEntityQuery
      }
    },
    async (req, reply) => {
      const { id } = EntityIdParams.parse(req.params);
      const query = DeleteEntityQuery.parse(req.query);
      const ok = query.purge ? await purge(req.scope, ctx.db, id) : await remove(req.scope, ctx.db, id);
      if (!ok) return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    }
  );

  app.post(
    "/v1/entities/:id/restore",
    {
      schema: {
        tags: ["entities"],
        summary: "Restore a trashed entity",
        params: EntityIdParams
      }
    },
    async (req, reply) => {
      const { id } = EntityIdParams.parse(req.params);
      const restored = await restore(req.scope, ctx.db, id);
      if (!restored) return reply.code(404).send({ error: "not_found" });
      return serializeEntity(restored);
    }
  );

  const TrashQuery = z.object({
    limit: z.coerce.number().int().positive().max(500).default(100)
  });

  app.get(
    "/v1/trash",
    {
      schema: {
        tags: ["entities"],
        summary: "List trashed entities, most recently deleted first",
        querystring: TrashQuery
      }
    },
    async (req) => {
      const query = TrashQuery.parse(req.query);
      return serializeEntities(await listTrash(req.scope, ctx.db, query.limit));
    }
  );

  app.post(
    "/v1/entities/:id/links",
    {
      schema: {
        tags: ["entities"],
        summary: "Link this entity to another (blocks / references / parent_of)",
        params: IdParams,
        body: LinkBody
      }
    },
    async (req) => {
      const { id } = IdParams.parse(req.params);
      const body = LinkBody.parse(req.body);
      return link(req.scope, ctx.db, { fromId: id, toId: body.toId, kind: body.kind });
    }
  );

  const GetLinksQuery = z.object({
    kind: z.enum(["blocks", "references", "parent_of"]).optional(),
    direction: z.enum(["outgoing", "incoming", "both"]).optional()
  });

  app.get(
    "/v1/entities/:id/links",
    {
      schema: {
        tags: ["entities"],
        summary: "Read typed graph edges for an entity (blocks / references / parent_of)",
        params: IdParams,
        querystring: GetLinksQuery
      }
    },
    async (req) => {
      const { id } = IdParams.parse(req.params);
      const query = GetLinksQuery.parse(req.query);
      const input = GetLinksInput.parse({ id, kind: query.kind, direction: query.direction ?? "both" });
      const links = await getLinks(req.scope, ctx.db, input);
      return links.map((l) => ({
        kind: l.kind,
        direction: l.direction,
        entity: serializeEntity(l.entity)
      }));
    }
  );

  const ListTagsQuery = z.object({
    projectId: Uuid.optional()
  });

  app.get(
    "/v1/tags",
    {
      schema: {
        tags: ["entities"],
        summary: "List distinct tags with counts across entities",
        querystring: ListTagsQuery
      }
    },
    async (req) => {
      const query = ListTagsQuery.parse(req.query);
      const input = ListTagsInput.parse({ projectId: query.projectId ?? null });
      return listTags(req.scope, ctx.db, input);
    }
  );

  // ----- auth (browser session cookie) -----

  const LoginBody = z.object({
    password: z.string().min(1).max(500)
  });

  app.post(
    "/v1/auth/login",
    {
      // Tight cap — this is the brute-force surface.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        summary: "Master-password login. Sets httpOnly session cookie.",
        body: LoginBody
      }
    },
    async (req, reply) => {
      const { password } = LoginBody.parse(req.body);
      const ok = verifyMasterPassword(password);
      if (!ok) {
        // Add a small constant-time penalty so timing attacks against the
        // env-lookup branch aren't easier than the rate limit makes them.
        await new Promise((r) => setTimeout(r, 300));
        return reply.code(401).send({ error: "invalid_password" });
      }
      const ua = (req.headers["user-agent"] as string | undefined) ?? null;
      const { plaintext, session } = await createSession(req.scope, ctx.db, { userAgent: ua });
      reply.setCookie("botnote_session", plaintext, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30 // 30 days
      });
      return { ok: true, expiresAt: session.expiresAt };
    }
  );

  app.post(
    "/v1/auth/logout",
    {
      schema: {
        tags: ["auth"],
        summary: "Clear session cookie and revoke the server-side row."
      }
    },
    async (req, reply) => {
      const plaintext = req.cookies?.botnote_session;
      if (plaintext) await revokeSession(ctx.db, plaintext);
      reply.clearCookie("botnote_session", { path: "/" });
      return { ok: true };
    }
  );

  app.get(
    "/v1/auth/whoami",
    {
      schema: {
        tags: ["auth"],
        summary: "Confirm authentication state + how the caller got in."
      }
    },
    async (req) => {
      // If the request reached this handler, the auth gate already passed —
      // via cookie, bearer, trusted loopback, or because auth is disabled.
      const hasCookie = !!req.cookies?.botnote_session;
      const hasBearer = !!req.headers.authorization;
      const via = hasCookie
        ? "cookie"
        : hasBearer
          ? "bearer"
          : ctx.auth.required
            ? "trusted_origin"
            : "auth_disabled";
      return { authenticated: true, via, origin: requestOrigin(req, ctx.auth) };
    }
  );

  // ----- tokens -----

  app.get(
    "/v1/tokens",
    { schema: { tags: ["tokens"], summary: "List API tokens (no hash; includes recoverable plaintext when available)" } },
    async (req) => (await listTokens(req.scope, ctx.db)).map(publicToken)
  );

  // Token write endpoints get a much tighter cap (30/hour per IP). These are
  // low-frequency operations — bumping them limits the blast radius if a token
  // leaks or someone hammers the create endpoint.
  app.post(
    "/v1/tokens",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
      schema: {
        tags: ["tokens"],
        summary: "Create a new API token (plaintext remains available for copying)",
        body: CreateTokenInput
      }
    },
    async (req) => {
      const body = CreateTokenInput.parse(req.body);
      const { token, plaintext } = await createToken(req.scope, ctx.db, body);
      return { ...publicToken(token), plaintext };
    }
  );

  app.delete(
    "/v1/tokens/:id",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
      schema: { tags: ["tokens"], summary: "Revoke an API token", params: IdParams }
    },
    async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const ok = await revokeToken(req.scope, ctx.db, id);
      if (!ok) return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    }
  );

  // Raw stream for JSON Lines bodies: the importer reads them line by line,
  // so a dump larger than memory never gets buffered.
  app.addContentTypeParser("application/x-ndjson", (_req, payload, done) => done(null, payload));

  app.get(
    "/v1/export",
    {
      schema: {
        tags: ["transfer"],
        summary: "Stream the whole workspace as JSON Lines (header line, then one record per line)",
        querystring: ExportQuery
      }
    },
    async (req, reply) => {
      const { vectors } = ExportQuery.parse(req.query);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      return reply
        .type("application/x-ndjson")
        .header("content-disposition", `attachment; filename="botnote-export-${stamp}.jsonl"`)
        .send(Readable.from(exportWorkspace(req.scope, ctx.db, { includeVectors: vectors })));
    }
  );

  app.post(
    "/v1/import",
    {
      schema: {
        tags: ["transfer"],
        summary:
          "Import a JSON Lines dump (content-type application/x-ndjson). Idempotent: existing ids are skipped, conflicts are reported."
      }
    },
    async (req, reply) => {
      const body = req.body;
      if (!body || typeof (body as Readable).pipe !== "function") {
        return reply.code(415).send({ error: "send the dump with content-type: application/x-ndjson" });
      }
      const lines = createInterface({ input: body as Readable, crlfDelay: Infinity });
      const report = await importWorkspace(req.scope, ctx.db, lines);
      if (report.entitiesWithoutVector > 0 && ctx.embedding.isEnabled()) {
        await ctx.embedding.enqueueMissing();
      }
      return report;
    }
  );
}
