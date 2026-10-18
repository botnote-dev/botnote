import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  BotnoteHttpClient,
  BotnoteHttpError,
  type EntityDTO,
  type LinkKind,
  type VirtualOccurrenceDTO,
  serializeEntity
} from "./http-client.js";
import { BotnoteUnreachableError } from "../config.js";
import { VERSION } from "../version.js";

export interface McpServerContext {
  client: BotnoteHttpClient;
  version?: string;
}

// Inline kind constants so the MCP package can be packaged without pulling
// drizzle / the db schema module at runtime.
const ENTITY_KINDS = ["task", "note", "worklog", "feedback"] as const;
const FEEDBACK_CATEGORIES = ["bug", "feature", "friction", "idea"] as const;
const ACTOR_KINDS = ["human", "agent", "system"] as const;
const TASK_STATUSES = [
  "open",
  "in_progress",
  "done",
  "rejected"
] as const;
const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
const EDGE_KINDS = ["blocks", "references", "parent_of", "supersedes"] as const;
const RECURRENCE_PRESETS = ["hourly", "daily", "weekly", "monthly", "yearly"] as const;
const RECURRENCE_ANCHORS = ["scheduled", "completion"] as const;
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const PROJECT_STATUSES = ["planned", "active", "watching", "paused", "archived"] as const;
/** Accepts a full UUID, a unique UUID prefix (≥8 hex chars), or a human-readable KEY-SEQ such as BOT-55. */
const EntityRef = z
  .string()
  .min(1)
  .max(40)
  .describe("UUID, unique UUID prefix, or human-readable KEY-SEQ such as BOT-55.");

/**
 * Split a human-readable KEY-SEQ identifier (BOT-55) into its parts, or null
 * when the string is not one. Case-insensitive: agents copy identifiers out of
 * prose, so `bot-55` has to resolve the same as `BOT-55`.
 */
function parseKeySeq(ref: string): { projectKey: string; sequenceId: number } | null {
  const m = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(ref.trim());
  if (!m) return null;
  return { projectKey: m[1]!.toUpperCase(), sequenceId: parseInt(m[2]!, 10) };
}

/**
 * Resolve an entity reference to a UUID (or pass through for the backend to handle).
 * If `ref` matches the KEY-SEQ pattern (e.g. BOT-55), it calls getEntityByKey and
 * returns the resolved UUID. Otherwise it passes `ref` through unchanged so the
 * backend can resolve UUID / prefix as before.
 */
/**
 * `id` plus its tolerated aliases, for the worklog tools. Every field is
 * optional at the schema level and `pickEntityRef` enforces that one arrived,
 * so a wrong-but-reasonable param name produces a useful error instead of a
 * schema rejection the agent cannot act on.
 */
const TargetEntityRef = EntityRef.optional().describe(
  "Parent task/note: UUID, unique UUID prefix, or KEY-SEQ such as BOT-55. Required (aliases: entityId, parentId)."
);
const TargetEntityAlias = EntityRef.optional().describe("Alias for `id`.");

async function resolveEntityRef(
  c: BotnoteHttpClient,
  ref: string
): Promise<string> {
  const keySeq = parseKeySeq(ref);
  if (keySeq) {
    const entity = await c.getEntityByKey(keySeq.projectKey, keySeq.sequenceId);
    return entity.id;
  }
  return ref;
}

/**
 * Tools that act on one entity historically took `id`, while sibling tools take
 * entity-suffixed names (`projectId`, `parentId`), so agents guess wrong and hit
 * a schema rejection instead of the operation they meant. Accept every spelling
 * and resolve here.
 */
function pickEntityRef(input: {
  id?: string;
  entityId?: string;
  parentId?: string;
}): string {
  const ref = input.id ?? input.entityId ?? input.parentId;
  if (!ref) {
    throw new Error(
      "missing target entity: pass `id` (aliases: `entityId`, `parentId`) as a UUID, UUID prefix, or KEY-SEQ such as BOT-55."
    );
  }
  return ref;
}

function displayTitle(e: { title: string | null; body: string }): string {
  if (e.title && e.title.trim()) return e.title;
  const firstLine = e.body.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (firstLine) return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
  return "(untitled)";
}

/**
 * Human-readable reference for an entity: KEY-SEQ (e.g. BOT-55) when the
 * project key is known, otherwise kind/uuid-prefix. Both forms are accepted
 * back as EntityRef inputs, so tool output never needs the full UUID.
 */
function entityRefLabel(e: EntityDTO, projectKey: string | null): string {
  if (projectKey && e.sequenceId != null) return `${projectKey}-${e.sequenceId}`;
  return `${e.kind}/${e.id.slice(0, 8)}`;
}

function summarizeEntity(e: EntityDTO, projectKey: string | null): string {
  const tagPart = e.tags.length ? ` [${e.tags.join(", ")}]` : "";
  const base = `${entityRefLabel(e, projectKey)} · ${displayTitle(e)}${tagPart}`;
  if (e.kind !== "task") return `${base} (note)`;
  // Compact task suffix: status, optional priority, and due/completedAt date.
  const parts: string[] = [e.status];
  if (e.priority && e.priority !== "none") parts.push(e.priority);
  if (e.status === "done" && e.completedAt) {
    parts.push(`done ${e.completedAt.slice(0, 10)}`);
  } else if (e.dueAt) {
    parts.push(`due ${e.dueAt.slice(0, 10)}`);
  }
  if (e.blockedBy?.length) {
    parts.push(`BLOCKED by ${e.blockedBy.map((b) => b.ref).join(", ")}`);
  }
  return `${base} (${parts.join(", ")})`;
}

/**
 * Format a caught error from a write-tool handler into a structured isError
 * response. For BotnoteHttpError produces a human-readable hint keyed to the
 * status code; for everything else falls back to the error message.
 *
 * Unexpected failures (5xx / non-HTTP errors) additionally nudge the agent to
 * file the problem with submit_feedback: the error text is the one message an
 * agent is guaranteed to read at the exact moment botnote friction occurs.
 * Client errors (400/404/422) are the caller's mistake and get no nudge.
 */
const FEEDBACK_NUDGE =
  "\n\nIf this looks like a botnote bug rather than a mistake in your request, file it with submit_feedback (category 'bug', include the tool name and this error text).";

function formatToolError(err: unknown): { isError: true; content: Array<{ type: "text"; text: string }> } {
  let text: string;
  let unexpected = false;
  if (err instanceof BotnoteHttpError) {
    const body = err.body?.trim() || err.statusText;
    if (err.status === 404) {
      text = `not found: ${body}`;
    } else if (err.status === 400 || err.status === 422) {
      text = `invalid request: ${body}`;
    } else {
      text = `HTTP ${err.status} ${err.statusText}: ${body}`;
      unexpected = err.status >= 500;
    }
  } else if (err instanceof BotnoteUnreachableError) {
    text = err.message;
  } else {
    const e = err as Error | undefined;
    text = String(e?.message ?? err);
    unexpected = true;
  }
  if (unexpected) text += FEEDBACK_NUDGE;
  return { isError: true, content: [{ type: "text", text }] };
}

const ProjectKey = z
  .string()
  .min(1)
  .max(20)
  .regex(/^[A-Z][A-Z0-9_]*$/);
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const IconName = z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/);

/**
 * Server-level behavioral guidance, surfaced to MCP clients at initialize time
 * (Claude Code injects it into the agent's context). Keep it short — this is
 * always-on context for every session that connects to botnote.
 */
const SERVER_INSTRUCTIONS = `botnote is the user's task + memory system. Rules for agents:

Proactive task capture (propose, don't silently create):
- When a discussion turns into a decision to build/fix/do something, propose recording it as a task before starting the work.
- When new work emerges mid-task that is outside the current task's scope, propose capturing it as a new task (link it via parentId or a reference) instead of silently doing it or letting it drop.
- Confirm with the user before creating. Batch proposals at natural checkpoints rather than interrupting for every item.

Task scope:
- Keep tasks small: one focused session (roughly ≤1 hour). Propose splitting bigger work into a parent milestone task plus small subtasks via parentId.

References:
- Refer to tasks and notes by their KEY-SEQ identifier (e.g. BOT-55) when talking to the user, never by UUID.

Worklog:
- When pausing or finishing work on a task, record progress with add_worklog (what was done, what's next, blockers). The opening brief surfaces the latest worklog entry per in_progress task, so this is how the next session resumes.

Memory hygiene:
- When a stored fact becomes outdated (changed decision, corrected detail), remember the new fact with supersedes=<old note id> instead of leaving both or editing history away. Superseded notes are downweighted in search but stay readable.
- If remember reports similar existing notes, check them before piling on duplicates — supersede or update instead.

Product feedback:
- When botnote ITSELF gets in your way — a tool misbehaves, a capability is missing, a workflow is awkward — file it with submit_feedback (category: bug/feature/friction/idea). Do not create tasks in the user's projects for botnote product issues, and check list_feedback first to avoid duplicates.

Session start: call opening_brief first to load project context.`;

export function buildMcpServer(ctx: McpServerContext): McpServer {
  const server = new McpServer(
    {
      name: "botnote",
      version: ctx.version ?? VERSION
    },
    { instructions: SERVER_INSTRUCTIONS }
  );
  const c = ctx.client;

  // projectId → key cache used to render human-readable KEY-SEQ refs (BOT-55)
  // in tool output. Loaded lazily; refreshed whenever an unknown projectId
  // shows up (e.g. a project created after the cache was filled).
  let projectKeyCache: Map<string, string> | null = null;

  async function projectKeysFor(rows: EntityDTO[]): Promise<Map<string, string>> {
    const cache = projectKeyCache;
    if (!cache || rows.some((e) => e.projectId && !cache.has(e.projectId))) {
      const projects = await c.listProjects({ includeArchived: true });
      projectKeyCache = new Map(projects.map((p) => [p.id, p.key]));
    }
    return projectKeyCache!;
  }

  async function summarizeAll(rows: EntityDTO[]): Promise<string[]> {
    const keys = await projectKeysFor(rows);
    return rows.map((e) =>
      summarizeEntity(e, e.projectId ? (keys.get(e.projectId) ?? null) : null)
    );
  }

  async function summarize(e: EntityDTO): Promise<string> {
    return (await summarizeAll([e]))[0]!;
  }

  /**
   * Markdown section listing an entity's child work items (subtasks/notes via
   * parentId or parent_of edges, worklog entries excluded), or "" when it has none.
   * Surfaced from get_entity so "can this milestone be closed?" never needs a
   * whole-project dump.
   */
  async function childrenSection(entityId: string): Promise<string> {
    const children = await c.listChildren(entityId).catch(() => [] as EntityDTO[]);
    if (!children.length) return "";
    const tasks = children.filter((ch) => ch.kind === "task");
    const closed = tasks.filter((ch) => ch.status === "done" || ch.status === "rejected");
    const header = tasks.length
      ? `## Children (${closed.length}/${tasks.length} tasks closed)`
      : "## Children";
    const lines = await summarizeAll(children);
    return `\n\n${header}\n${lines.map((s) => `- ${s}`).join("\n")}`;
  }

  // ----- 1. opening_brief -----

  server.registerTool(
    "opening_brief",
    {
      title: "Opening Brief",
      description:
        "CALL THIS FIRST when starting work on a project. Fetch the agent context bundle: AGENTS.md + PINNED NOTES (full text, user-curated must-read context like deployment steps, important conventions) + open tasks + recent activity. Returns markdown.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        projectId: z
          .string()
          .uuid()
          .optional()
          .describe("Optional project UUID; omit for workspace-wide brief.")
      }
    },
    async ({ projectId }) => {
      const brief = await c.openingBrief({ projectId: projectId ?? null, recentLimit: 10 });
      return { content: [{ type: "text", text: brief.markdown }] };
    }
  );

  // ----- 2. search -----

  server.registerTool(
    "search",
    {
      title: "Hybrid Search",
      description:
        "Find tasks and notes by free-text query. Uses BM25 + vector cosine + time decay merged via RRF. Pass kind='note' or kind='task' to narrow; omit to search both.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        query: z.string().min(1),
        projectId: z.string().uuid().optional(),
        kind: z.enum(ENTITY_KINDS).optional(),
        limit: z.number().int().min(1).max(50).default(10)
      }
    },
    async ({ query, projectId, kind, limit }) => {
      const { hits, embeddingUsed } = await c.search({
        query,
        projectId: projectId ?? null,
        kind,
        limit
      });
      const summaries = await summarizeAll(hits.map((h) => h.entity));
      const lines = hits.map(
        (h, i) =>
          `${h.score.toFixed(4)} ${summaries[i]}\n    ${h.entity.body.slice(0, 200).replace(/\n/g, " ")}`
      );
      return {
        content: [
          {
            type: "text",
            text: hits.length
              ? `${hits.length} hit(s). embedding=${embeddingUsed ? "on" : "off"}\n\n${lines.join("\n\n")}`
              : `no hits. embedding=${embeddingUsed ? "on" : "off"}`
          }
        ]
      };
    }
  );

  // ----- 3. recent -----

  server.registerTool(
    "recent",
    {
      title: "Recent Entities",
      description:
        "List entities ordered by most recent. Filter by project, kinds, and since (ISO date).",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        projectId: z.string().uuid().optional(),
        since: z.string().datetime().optional(),
        kinds: z.array(z.enum(ENTITY_KINDS)).optional(),
        limit: z.number().int().min(1).max(50).default(20)
      }
    },
    async ({ projectId, since, kinds, limit }) => {
      const rows = await c.recent({
        projectId: projectId ?? null,
        since: since ?? null,
        kinds,
        limit
      });
      const summaries = await summarizeAll(rows);
      return {
        content: [
          {
            type: "text",
            text: rows.length
              ? rows
                  .map(
                    (r, i) =>
                      `${r.createdAt.slice(0, 16).replace("T", " ")} · ${summaries[i]}`
                  )
                  .join("\n")
              : "no recent entities"
          }
        ]
      };
    }
  );

  // ----- 4. list_projects -----

  server.registerTool(
    "list_projects",
    {
      title: "List Projects",
      description:
        "List non-archived projects in the workspace with key, status, name, color and icon. Pass includeArchived=true only when you need archived projects too.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        includeArchived: z.boolean().default(false)
      }
    },
    async ({ includeArchived }) => {
      const projects = await c.listProjects({ includeArchived });
      const lines = projects.map(
        (p) =>
          `${p.key.padEnd(10)} ${p.name}  (id: ${p.id}, status: ${p.status}, icon: ${p.icon}, color: ${p.color}${
            p.archivedAt ? `, archived: ${p.archivedAt}` : ""
          })`
      );
      return {
        content: [{ type: "text", text: projects.length ? lines.join("\n") : "no projects" }]
      };
    }
  );

  // ----- 5. get_project -----

  server.registerTool(
    "get_project",
    {
      title: "Get Project",
      description:
        "Fetch a single project, including its AGENTS.md. Accepts either the UUID or the human-readable key (e.g. 'BOT').",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        projectId: z.string().uuid().optional(),
        key: ProjectKey.optional()
      }
    },
    async ({ projectId, key }) => {
      if (!projectId && !key) {
        return { isError: true, content: [{ type: "text", text: "pass projectId or key" }] };
      }
      try {
        const p = projectId
          ? await c.getProject(projectId)
          : await c.getProjectByKey(key!);
        return { content: [{ type: "text", text: JSON.stringify(p, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `project not found: ${msg}` }] };
      }
    }
  );

  // ----- 6. create_project -----

  server.registerTool(
    "create_project",
    {
      title: "Create Project",
      description:
        "Create a new project. Call `list_projects` first to verify the project does not already exist or fit an existing bucket. Only create a new project when the work is large enough to deserve its own backlog.\n" +
        "\n" +
        "Conventions:\n" +
        "- `key`: short uppercase identifier, e.g. 'BOT', 'DOCS', 'OPS'. Unique across the workspace.\n" +
        "- `name`: human-readable.\n" +
        "- `status`: planned, active, watching, paused, or archived. Use archived for completed, canceled, or historical projects.\n" +
        "- `color`: hex like '#5e6ad2' (Linear blue) by default. Pick a color that contrasts with the existing palette.\n" +
        "- `icon`: lowercase kebab name from lucide-react (e.g. 'rocket', 'brain', 'package', 'archive').\n" +
        "- `agentsMd`: write project-level conventions agents should follow (test commands, deploy steps, important gotchas). Surfaced in opening_brief.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        key: ProjectKey,
        name: z.string().min(1).max(200),
        status: z.enum(PROJECT_STATUSES).default("active"),
        color: HexColor.default("#5e6ad2"),
        icon: IconName.default("circle"),
        agentsMd: z.string().default("")
      }
    },
    async ({ key, name, status, color, icon, agentsMd }) => {
      try {
        const existing = await c.getProjectByKey(key);
        return {
          content: [{ type: "text", text: `project ${key} already exists: ${existing.id}` }]
        };
      } catch {
        // Not found → continue to create.
      }
      const p = await c.createProject({ key, name, status, color, icon, agentsMd });
      return { content: [{ type: "text", text: `created project ${p.key} · ${p.name}\nid: ${p.id}` }] };
    }
  );

  // ----- 7. update_project -----

  server.registerTool(
    "update_project",
    {
      title: "Update Project",
      description:
        "Update a project's status, name, color, icon, or AGENTS.md. Use status='archived' for completed, canceled, or historical projects.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        projectId: z.string().uuid(),
        name: z.string().min(1).max(200).optional(),
        status: z.enum(PROJECT_STATUSES).optional(),
        color: HexColor.optional(),
        icon: IconName.optional(),
        agentsMd: z.string().optional()
      }
    },
    async ({ projectId, ...fields }) => {
      const defined: Record<string, unknown> = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined)
      );
      const p = await c.updateProject(projectId, defined);
      return {
        content: [
          {
            type: "text",
            text: `updated project ${p.key} · ${p.name} · ${p.status}${p.archivedAt ? " (archived)" : ""}`
          }
        ]
      };
    }
  );

  // ----- 8. get_entity -----

  server.registerTool(
    "get_entity",
    {
      title: "Get Entity",
      description: "Fetch a single task or note by its UUID, unique UUID prefix, or human-readable KEY-SEQ (e.g. BOT-55).",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: { id: EntityRef }
    },
    async ({ id }) => {
      try {
        const resolvedId = await resolveEntityRef(c, id);
        const entity = await c.getEntity(resolvedId);
        const text = JSON.stringify(serializeEntity(entity), null, 2) + (await childrenSection(entity.id));
        return { content: [{ type: "text", text }] };
      } catch {
        return { isError: true, content: [{ type: "text", text: `entity ${id} not found` }] };
      }
    }
  );

  // ----- 9. get_entity_by_key -----

  server.registerTool(
    "get_entity_by_key",
    {
      title: "Get Entity by Identifier",
      description:
        "Fetch a task or note by its human-readable identifier. Pass the whole identifier as `key`: \"DEMO-12\" — the form every doc, brief, and UI shows. The split `projectKey` + `sequenceId` form still works.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        key: z
          .string()
          .min(1)
          .max(40)
          .optional()
          .describe("Full identifier such as DEMO-12. Preferred form."),
        id: z
          .string()
          .min(1)
          .max(40)
          .optional()
          .describe("Alias of key, for callers that name every identifier id."),
        projectKey: z
          .string()
          .min(1)
          .max(40)
          .optional()
          .describe("Split form: project key alone (DEMO), paired with sequenceId."),
        sequenceId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Split form: sequence number, paired with projectKey.")
      }
    },
    async ({ key, id, projectKey, sequenceId }) => {
      // Tolerate every spelling agents actually produce: key: "DEMO-12",
      // id: "DEMO-12", projectKey + sequenceId, and projectKey: "DEMO-12"
      // with the sequence already baked in.
      const ref = key ?? id ?? projectKey;
      if (!ref) {
        return {
          isError: true,
          content: [
            { type: "text", text: 'missing identifier: pass key: "DEMO-12" (or projectKey + sequenceId).' }
          ]
        };
      }
      const parsed =
        parseKeySeq(ref) ??
        (sequenceId !== undefined && /^[A-Za-z][A-Za-z0-9_]*$/.test(ref.trim())
          ? { projectKey: ref.trim().toUpperCase(), sequenceId }
          : null);
      if (!parsed) {
        return {
          isError: true,
          content: [
            { type: "text", text: `not an entity identifier: ${ref} — expected KEY-SEQ such as DEMO-12.` }
          ]
        };
      }
      try {
        const entity = await c.getEntityByKey(parsed.projectKey, parsed.sequenceId);
        const text = JSON.stringify(serializeEntity(entity), null, 2) + (await childrenSection(entity.id));
        return { content: [{ type: "text", text }] };
      } catch {
        return {
          isError: true,
          content: [
            { type: "text", text: `entity ${parsed.projectKey}-${parsed.sequenceId} not found` }
          ]
        };
      }
    }
  );

  // ----- 10. create_task -----

  server.registerTool(
    "create_task",
    {
      title: "Create Task",
      description:
        "Create a task — a structured work item with status, optional due date, priority, and tags. Use this for anything with a state machine (open/in_progress/done). For free-form notes call `remember`.\n" +
        "\n" +
        "Conventions (follow strictly):\n" +
        "- `projectId`: required. Call `list_projects` first if you don't already know the project's UUID. If user-supplied context doesn't pin a project, ask before creating.\n" +
        "- `title`: an executable verb phrase, NOT a vague topic ('Fix DEMO-12 null-pointer' ✓, 'Process demo stuff' ✗). Max ~100 chars.\n" +
        "- `priority`: infer from urgency cues — ASAP/blocker -> urgent; this week -> high; soon -> medium; backlog -> low; otherwise none.\n" +
        "- `status`: defaults to 'open'. Use 'in_progress' only if work has actually started in this turn.\n" +
        "- `dueAt`: include when the user mentions a date. Use an ISO datetime in UTC.\n" +
        "- `tags`: 2-4 short lowercase kebab-case tokens. Re-use existing tags when possible — search first if unsure.\n" +
        "- `parentId`: include when this task is a follow-up under another task or note.\n" +
        "\n" +
        "Scope — keep tasks small:\n" +
        "- One task = one focused work session (roughly ≤1 hour). If the work spans multiple hours, days, or deliverables, propose a split into smaller executable tasks and get the user's agreement before creating anything.\n" +
        "- For a large goal, create a parent milestone task (no dueAt needed), then attach small executable subtasks via `parentId`.\n" +
        "- Heuristic: if the title needs 'and' to chain multiple verbs, it should be several tasks.\n" +
        "\n" +
        "When reporting a created task to the user, refer to it by its KEY-SEQ identifier (e.g. BOT-55), never the UUID.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        projectId: z.string().uuid().optional(),
        title: z.string().min(1).max(500),
        body: z.string().default(""),
        tags: z.array(z.string()).default([]),
        status: z.enum(TASK_STATUSES).default("open"),
        parentId: EntityRef.optional().describe("Link this task under another entity. Accepts UUID, UUID prefix, or KEY-SEQ such as BOT-55."),
        actorKind: z.enum(ACTOR_KINDS).default("agent"),
        dueAt: z.string().datetime().optional().describe("ISO datetime."),
        priority: z.enum(PRIORITIES).default("none"),
        completedAt: z
          .string()
          .datetime()
          .optional()
          .describe(
            "Only with status 'done': when the work was actually finished (ISO datetime). Use to backdate completions, e.g. the user says they finished it yesterday. Defaults to now."
          ),
        idempotencyKey: z.string().min(1).max(200).optional()
      }
    },
    async (input) => {
      try {
        const resolvedParentId = input.parentId
          ? await resolveEntityRef(c, input.parentId)
          : null;
        const entity = await c.createTask({
          projectId: input.projectId ?? null,
          title: input.title,
          body: input.body,
          tags: input.tags,
          status: input.status,
          parentId: resolvedParentId,
          actorKind: input.actorKind,
          dueAt: input.dueAt ?? null,
          priority: input.priority,
          completedAt: input.completedAt ?? null,
          idempotencyKey: input.idempotencyKey
        });
        return { content: [{ type: "text", text: `created task ${await summarize(entity)}\nid: ${entity.id}` }] };
      } catch (err: unknown) {
        return formatToolError(err);
      }
    }
  );

  // ----- 11. remember (= create_note) -----

  server.registerTool(
    "remember",
    {
      title: "Remember (Create Note)",
      description:
        "Capture a free-form note. Title is optional (body's first line acts as label). Notes are botnote's memory layer, so err on the side of preserving useful context.\n" +
        "\n" +
        "Conventions:\n" +
        "- `body`: the substance. Multi-line + markdown OK. Include the WHY, not just the WHAT.\n" +
        "- `title`: skip if the first body line is descriptive. Provide when the body is long-form.\n" +
        "- `tags`: 2-4 short lowercase kebab-case tokens inferred from content. Re-use existing tags — recall similar memories first if unsure of vocabulary.\n" +
        "- `projectId`: pick the most specific project. If unclear, omit (workspace-scope is fine; better than wrong-project).\n" +
        "- `parentId`: pass a task's UUID when the note is a follow-up on a specific task — this surfaces the note when the task is opened.\n" +
        "- `pinned=true`: ONLY for must-read context (deployment steps, hidden gotchas, AGENTS-style conventions). Pinned notes appear in every future opening_brief — abuse them and the brief becomes noise.\n" +
        "- `supersedes`: pass an existing note's id when this note REPLACES an outdated memory (changed decision, corrected fact). The old note is downweighted in search but stays readable — prefer this over editing history away.\n" +
        "\n" +
        "The result may list `similar existing notes` — near-duplicates already stored. If one of them covers the same fact, mark it superseded via `link` (from=new note, to=old note, kind='supersedes') or update the existing note instead of keeping both.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        projectId: z.string().uuid().optional(),
        title: z.string().max(500).optional().describe("Optional; first body line is used as fallback."),
        body: z.string().default(""),
        tags: z.array(z.string()).default([]),
        parentId: EntityRef.optional().describe("Link this note under a task or other entity. Accepts UUID, UUID prefix, or KEY-SEQ such as BOT-55."),
        actorKind: z.enum(ACTOR_KINDS).default("agent"),
        pinned: z.boolean().default(false).describe("Pin to project opening brief (must-read context)."),
        supersedes: EntityRef.optional().describe("Existing note this one replaces. Accepts UUID, UUID prefix, or KEY-SEQ such as BOT-55. The old note is downweighted in search."),
        idempotencyKey: z.string().min(1).max(200).optional()
      }
    },
    async (input) => {
      try {
        const resolvedParentId = input.parentId
          ? await resolveEntityRef(c, input.parentId)
          : null;
        const resolvedSupersedes = input.supersedes
          ? await resolveEntityRef(c, input.supersedes)
          : null;
        const entity = await c.remember({
          projectId: input.projectId ?? null,
          title: input.title ?? null,
          body: input.body,
          tags: input.tags,
          parentId: resolvedParentId,
          actorKind: input.actorKind,
          pinned: input.pinned,
          supersedes: resolvedSupersedes,
          idempotencyKey: input.idempotencyKey
        });
        let text = `remembered ${await summarize(entity)}\nid: ${entity.id}`;
        if (resolvedSupersedes) {
          text += `\nsupersedes: ${resolvedSupersedes}`;
        }
        const similar = entity.similar ?? [];
        if (similar.length > 0) {
          const lines = await Promise.all(
            similar.map(async (s) => `- ${await summarize(s)} (id: ${s.id})`)
          );
          text +=
            `\n\nsimilar existing notes (possible duplicates):\n${lines.join("\n")}\n` +
            `If one covers the same fact, run link(fromId=${entity.id}, toId=<old id>, kind='supersedes') or update the existing note instead of keeping both.`;
        }
        return { content: [{ type: "text", text }] };
      } catch (err: unknown) {
        return formatToolError(err);
      }
    }
  );

  // ----- 12. update_entity -----

  server.registerTool(
    "update_entity",
    {
      title: "Update Entity",
      description:
        "Update fields on an existing task or note. Pass ONLY the fields you want to change — omitted fields are left untouched.\n" +
        "\n" +
        "Common transitions:\n" +
        "- task completion: `status='done'`. Add a closing `add_worklog` entry summarizing what was done.\n" +
        "- task cancellation / give up: `status='rejected'`.\n" +
        "- start work: `status='in_progress'` ONLY when work actually begins in this turn (not just on every mention).\n" +
        "- move between projects: pass `projectId` (or `null` to move to workspace scope).\n" +
        "- re-parent: pass `parentId` (or `null` to detach).\n" +
        "- pin/unpin: `pinned: true/false`. Pinned notes drive opening_brief — use sparingly.\n" +
        "- title=null clears the title (notes only).\n" +
        "- fix completion time: `completedAt` overrides the automatic stamp on a done task (e.g. the user actually finished it yesterday). Combine with `status='done'` in the same call to complete-and-backdate at once.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        id: EntityRef,
        projectId: z
          .string()
          .uuid()
          .nullable()
          .optional()
          .describe("Move to a project UUID, or pass null for workspace scope."),
        title: z
          .string()
          .max(500)
          .nullable()
          .optional()
          .describe("Pass null to clear the title (notes only)."),
        body: z.string().optional().describe("Replace the entire body. Mutually exclusive with bodyAppend."),
        bodyAppend: z
          .string()
          .optional()
          .describe(
            "Atomically append text to the existing body, separated by a blank line when the current body is non-empty. Mutually exclusive with body."
          ),
        tags: z.array(z.string()).optional(),
        status: z.enum(TASK_STATUSES).optional(),
        parentId: EntityRef.nullable().optional().describe("Re-link or unlink (null) parent. Accepts UUID, UUID prefix, or KEY-SEQ such as BOT-55."),
        dueAt: z.string().datetime().nullable().optional().describe("ISO datetime or null to clear."),
        priority: z.enum(PRIORITIES).optional(),
        pinned: z.boolean().optional().describe("Pin or unpin from project opening brief."),
        completedAt: z
          .string()
          .datetime()
          .nullable()
          .optional()
          .describe(
            "Override the completion timestamp of a done task (ISO datetime), e.g. to backdate when the work actually finished; null clears it. Only valid when the task is done (or becomes done in this call)."
          ),
        recurrenceScope: z
          .enum(["this", "future"])
          .optional()
          .describe(
            "For recurring task occurrences: 'this' applies the edit to this occurrence only (does not propagate to future); 'future' (default) propagates the edit to future occurrences."
          )
      }
    },
    async ({ id, parentId, ...fields }) => {
      try {
        const resolvedId = await resolveEntityRef(c, id);
        const resolvedParentId =
          parentId === null ? null : parentId !== undefined ? await resolveEntityRef(c, parentId) : undefined;
        const defined: Record<string, unknown> = Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v !== undefined)
        );
        if (resolvedParentId !== undefined) defined.parentId = resolvedParentId;
        const updated = await c.updateEntity(resolvedId, defined);
        let text = `updated ${await summarize(updated)}`;
        // Closing a milestone parent with open children is usually a mistake —
        // warn (don't block) so the agent can double-check with the user.
        if (defined.status === "done" && updated.kind === "task") {
          const children = await c.listChildren(updated.id).catch(() => [] as EntityDTO[]);
          const openKids = children.filter(
            (ch) => ch.kind === "task" && ch.status !== "done" && ch.status !== "rejected"
          );
          if (openKids.length) {
            const lines = await summarizeAll(openKids);
            text +=
              `\n\nWarning: this task still has ${openKids.length} unfinished child task(s):\n` +
              lines.map((s) => `- ${s}`).join("\n");
          }
        }
        return { content: [{ type: "text", text }] };
      } catch (err: unknown) {
        return formatToolError(err);
      }
    }
  );

  server.registerTool(
    "add_worklog",
    {
      title: "Add Worklog Entry",
      description:
        "Append a worklog entry to a task or note. Use it to record progress, decisions, blockers, or a handoff summary when pausing work — the opening brief shows the latest entry for every in_progress task. Entries are append-only.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        id: TargetEntityRef,
        entityId: TargetEntityAlias,
        parentId: TargetEntityAlias,
        body: z.string().min(1).describe("The worklog entry text. Markdown allowed."),
        actorKind: z.enum(ACTOR_KINDS).default("agent"),
        idempotencyKey: z.string().min(1).max(200).optional()
      }
    },
    async ({ body, actorKind, idempotencyKey, ...target }) => {
      try {
        const ref = pickEntityRef(target);
        const resolvedId = await resolveEntityRef(c, ref);
        const entry = await c.addWorklogEntry(resolvedId, { body, actorKind, idempotencyKey });
        return {
          content: [
            { type: "text", text: `added worklog entry ${entry.id.slice(0, 8)} on ${ref}` }
          ]
        };
      } catch (err: unknown) {
        return formatToolError(err);
      }
    }
  );

  server.registerTool(
    "list_worklog",
    {
      title: "List Worklog",
      description:
        "List the worklog entries on a task or note, oldest first. Read this when resuming an in_progress task to see what previous sessions did.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        id: TargetEntityRef,
        entityId: TargetEntityAlias,
        parentId: TargetEntityAlias
      }
    },
    async (target) => {
      try {
        const resolvedId = await resolveEntityRef(c, pickEntityRef(target));
        const rows = await c.listWorklog(resolvedId);
        if (rows.length === 0) {
          return { content: [{ type: "text", text: "no worklog entries" }] };
        }
        const lines = rows.map((r) => {
          const when = (r.createdAt ?? "").slice(0, 16).replace("T", " ");
          return `[${when} · ${r.actor?.label ?? r.actorKind}]\n${r.body}`;
        });
        return { content: [{ type: "text", text: lines.join("\n\n---\n\n") }] };
      } catch (err: unknown) {
        return formatToolError(err);
      }
    }
  );

  server.registerTool(
    "submit_feedback",
    {
      title: "Submit Feedback",
      description:
        "File product feedback about botnote ITSELF — not about the user's projects. Use it when botnote misbehaves (bug), lacks a capability you needed (feature), makes a workflow awkward (friction), or you see how it could serve agents better (idea). This feeds botnote's own iteration backlog.\n" +
        "\n" +
        "Conventions:\n" +
        "- `title`: one concrete, actionable sentence (e.g. \"search ignores KEY-SEQ refs in queries\").\n" +
        "- `body`: what you tried, what happened, what you expected. Include the exact tool call when reporting a bug.\n" +
        "- `tool`: the tool or surface involved (e.g. \"search\", \"opening_brief\", \"web-ui\").\n" +
        "- `projectId`: the project you were working in when it surfaced, if any.\n" +
        "Check list_feedback first if you suspect it is already known; do not re-file duplicates.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        category: z.enum(FEEDBACK_CATEGORIES),
        title: z.string().min(1).max(500),
        body: z.string().default(""),
        projectId: z.string().uuid().optional(),
        tool: z.string().max(100).optional(),
        actorKind: z.enum(ACTOR_KINDS).default("agent"),
        idempotencyKey: z.string().min(1).max(200).optional()
      }
    },
    async (input) => {
      try {
        const entity = await c.submitFeedback({
          category: input.category,
          title: input.title,
          body: input.body,
          projectId: input.projectId ?? null,
          tool: input.tool ?? null,
          actorKind: input.actorKind,
          idempotencyKey: input.idempotencyKey
        });
        return {
          content: [
            {
              type: "text",
              text: `feedback filed (${input.category}): ${await summarize(entity)}\nid: ${entity.id}`
            }
          ]
        };
      } catch (err: unknown) {
        return formatToolError(err);
      }
    }
  );

  server.registerTool(
    "list_feedback",
    {
      title: "List Feedback",
      description:
        "List filed botnote product feedback for triage, newest first. Filter by category (bug/feature/friction/idea) and status (open/in_progress/done/rejected). Check this before submit_feedback to avoid duplicates; use update_entity to change a feedback item's status when triaging.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        category: z.enum(FEEDBACK_CATEGORIES).optional(),
        status: z.enum(["open", "in_progress", "done", "rejected"]).optional(),
        limit: z.number().int().min(1).max(100).default(20)
      }
    },
    async (input) => {
      try {
        const rows = await c.listFeedback({
          category: input.category,
          status: input.status,
          limit: input.limit
        });
        if (rows.length === 0) {
          return { content: [{ type: "text", text: "no feedback found" }] };
        }
        const lines = rows.map((r) => {
          const category = (r.metadata as { category?: string }).category ?? "?";
          const tool = (r.metadata as { tool?: string }).tool;
          const when = (r.createdAt ?? "").slice(0, 10);
          return `- [${category}${tool ? ` · ${tool}` : ""}] ${r.title} (${r.status}, ${when}, id: ${r.id.slice(0, 8)})`;
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: unknown) {
        return formatToolError(err);
      }
    }
  );

  // ----- 13. recurrence -----

  server.registerTool(
    "configure_recurrence",
    {
      title: "Configure Recurrence",
      description:
        "Attach a recurrence rule to an existing dated task. Use this only when the user explicitly asks for a repeating task; meetings and calendar-like work should usually use anchor='scheduled', while maintenance routines can use anchor='completion'.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        taskId: EntityRef.describe("Task UUID, unique UUID prefix, or KEY-SEQ such as BOT-55."),
        rrule: z.string().min(1).max(1000).optional().describe("Raw RRULE such as FREQ=WEEKLY;BYDAY=MO."),
        preset: z.enum(RECURRENCE_PRESETS).optional(),
        interval: z.number().int().min(1).max(999).optional(),
        byWeekday: z.array(z.enum(WEEKDAYS)).optional(),
        byMonthDay: z.array(z.number().int().min(1).max(31)).optional(),
        bySetPos: z.number().int().min(-5).max(5).optional(),
        byMonth: z.array(z.number().int().min(1).max(12)).optional(),
        until: z.string().datetime().nullable().optional(),
        count: z.number().int().min(1).max(10000).nullable().optional(),
        dtstart: z.string().datetime().optional(),
        timezone: z.string().min(1).max(80).optional(),
        allDay: z.boolean().optional(),
        anchor: z.enum(RECURRENCE_ANCHORS).optional()
      }
    },
    async ({ taskId, ...fields }) => {
      try {
        const resolvedTaskId = await resolveEntityRef(c, taskId);
        const body = Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v !== undefined)
        );
        const rule = await c.configureRecurrence(resolvedTaskId, body);
        return {
          content: [
            {
              type: "text",
              text: `configured recurrence ${rule.id}\nrrule: ${rule.rrule}\nanchor: ${rule.anchor}\nnext: ${rule.nextOccurrenceAt ?? "-"}`
            }
          ]
        };
      } catch (err: unknown) {
        return formatToolError(err);
      }
    }
  );

  server.registerTool(
    "get_recurrence",
    {
      title: "Get Recurrence",
      description: "Fetch the recurrence rule attached to a task occurrence.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: { taskId: EntityRef.describe("Task UUID, unique UUID prefix, or KEY-SEQ such as BOT-55.") }
    },
    async ({ taskId }) => {
      const resolvedTaskId = await resolveEntityRef(c, taskId);
      const details = await c.getRecurrence(resolvedTaskId);
      const serialized = {
        ...details,
        currentOccurrence: details.currentOccurrence
          ? serializeEntity(details.currentOccurrence)
          : null
      };
      return { content: [{ type: "text", text: JSON.stringify(serialized, null, 2) }] };
    }
  );

  server.registerTool(
    "skip_occurrence",
    {
      title: "Skip Recurring Occurrence",
      description:
        "Skip the current recurring occurrence without marking it done, then create the next occurrence when the series continues.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        taskId: EntityRef.describe("Task UUID, unique UUID prefix, or KEY-SEQ such as BOT-55."),
        reason: z.string().max(500).optional()
      }
    },
    async ({ taskId, reason }) => {
      try {
        const resolvedTaskId = await resolveEntityRef(c, taskId);
        const result = await c.skipOccurrence(resolvedTaskId, { reason, actorKind: "agent" });
        return {
          content: [
            {
              type: "text",
              text: `skipped ${await summarize(result.skipped)}\nnext: ${
                result.next ? await summarize(result.next) : "-"
              }`
            }
          ]
        };
      } catch (err: unknown) {
        return formatToolError(err);
      }
    }
  );

  server.registerTool(
    "stop_recurrence",
    {
      title: "Stop Recurrence",
      description: "Disable a recurrence series so no future occurrences are generated.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        ruleId: z.string().uuid(),
        reason: z.string().max(500).optional()
      }
    },
    async ({ ruleId, reason }) => {
      try {
        const rule = await c.stopRecurrence(ruleId, { reason });
        return { content: [{ type: "text", text: `stopped recurrence ${rule.id}` }] };
      } catch (err: unknown) {
        return formatToolError(err);
      }
    }
  );

  server.registerTool(
    "split_recurrence",
    {
      title: "Split Recurrence",
      description:
        "Fork a recurring series at its current occurrence: freeze the existing rule (history stays intact) and apply a new cadence going forward, keeping it the same series. Use this when the schedule should change from now on but past occurrences must be preserved; use configure_recurrence to rewrite the whole rule in place instead.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        ruleId: z.string().uuid(),
        rrule: z.string().min(1).max(1000).optional().describe("Raw RRULE such as FREQ=WEEKLY;BYDAY=MO."),
        preset: z.enum(RECURRENCE_PRESETS).optional(),
        interval: z.number().int().min(1).max(999).optional(),
        byWeekday: z.array(z.enum(WEEKDAYS)).optional(),
        byMonthDay: z.array(z.number().int().min(1).max(31)).optional(),
        bySetPos: z.number().int().min(-5).max(5).optional(),
        byMonth: z.array(z.number().int().min(1).max(12)).optional(),
        until: z.string().datetime().nullable().optional(),
        count: z.number().int().min(1).max(10000).nullable().optional(),
        timezone: z.string().min(1).max(80).optional(),
        allDay: z.boolean().optional(),
        anchor: z.enum(RECURRENCE_ANCHORS).optional()
      }
    },
    async ({ ruleId, ...fields }) => {
      try {
        const body = Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v !== undefined)
        );
        const rule = await c.splitRecurrence(ruleId, body);
        return {
          content: [
            {
              type: "text",
              text: `split into recurrence ${rule.id}\nrrule: ${rule.rrule}\nanchor: ${rule.anchor}\nnext: ${rule.nextOccurrenceAt ?? "-"}`
            }
          ]
        };
      } catch (err: unknown) {
        return formatToolError(err);
      }
    }
  );

  // ----- 14. related -----

  server.registerTool(
    "related",
    {
      title: "Related Entities",
      description:
        "List entities whose parent_id is the given id or unique UUID prefix. Use this after opening a task to surface the relevant notes/context.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: { id: EntityRef }
    },
    async ({ id }) => {
      const resolvedId = await resolveEntityRef(c, id);
      const rows = await c.listRelated(resolvedId);
      const summaries = await summarizeAll(rows);
      return {
        content: [
          {
            type: "text",
            text: rows.length
              ? summaries.map((s) => `- ${s}`).join("\n")
              : "no related entities"
          }
        ]
      };
    }
  );

  // ----- 15. link -----

  server.registerTool(
    "link",
    {
      title: "Link Entities",
      description:
        "Create a typed edge between two entities. `blocks` = source blocks target, `references` = source references target (citation/see-also), `parent_of` = source is the parent (e.g. task is parent of a sub-note), `supersedes` = source replaces target (the outdated entity is downweighted in search but stays readable).",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        fromId: EntityRef.describe("Source entity: UUID, UUID prefix, or KEY-SEQ such as BOT-55."),
        toId: EntityRef.describe("Target entity: UUID, UUID prefix, or KEY-SEQ such as BOT-55."),
        kind: z.enum(EDGE_KINDS)
      }
    },
    async ({ fromId, toId, kind }) => {
      try {
        const resolvedFromId = await resolveEntityRef(c, fromId);
        const resolvedToId = await resolveEntityRef(c, toId);
        const result = await c.link(resolvedFromId, { toId: resolvedToId, kind: kind as LinkKind });
        return {
          content: [
            {
              type: "text",
              text: result.created
                ? `linked ${fromId} -[${kind}]-> ${toId}`
                : `link already exists`
            }
          ]
        };
      } catch (err: unknown) {
        return formatToolError(err);
      }
    }
  );

  // ----- 16. list_tasks -----

  server.registerTool(
    "list_tasks",
    {
      title: "List Tasks",
      description:
        "Return tasks split into Overdue / Scheduled / Backlog buckets for a given date range. Scheduled includes tasks whose display date falls in [from, to). Overdue is unfinished work before the range start (or before now when from is omitted). Backlog is undated tasks (when includeBacklog is true). Rejected and archived tasks never appear in any bucket — use the project views to inspect cancelled work.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        projectId: z.string().uuid().optional().describe("Scope to a single project UUID."),
        projectIds: z.array(z.string().uuid()).optional().describe("Scope to multiple project UUIDs."),
        from: z.string().datetime().optional().describe("Range start (ISO datetime, inclusive)."),
        to: z.string().datetime().optional().describe("Range end (ISO datetime, exclusive)."),
        includeBacklog: z.boolean().default(true).describe("Include undated tasks."),
        includeDone: z.boolean().default(false).describe("Include completed tasks."),
        includeVirtualRecurrences: z.boolean().default(false).describe("Include ephemeral future ghost occurrences for recurring tasks.")
      }
    },
    async ({ projectId, projectIds, from, to, includeBacklog, includeDone, includeVirtualRecurrences }) => {
      // Merge projectId into projectIds for the REST call
      const ids: string[] = [];
      if (projectId) ids.push(projectId);
      if (projectIds) ids.push(...projectIds);

      const result = await c.tasksRange({
        from: from ?? null,
        to: to ?? null,
        projectIds: ids.length ? ids : null,
        includeBacklog,
        includeDone,
        includeVirtualRecurrences
      });

      const lines: string[] = [];

      const buckets: Array<[string, EntityDTO[]]> = [
        ["## Overdue", result.overdue.map(serializeEntity)],
        ["## Scheduled", result.scheduled.map(serializeEntity)],
        ["## Backlog", result.backlog.map(serializeEntity)]
      ];
      for (const [header, rows] of buckets) {
        if (!rows.length) continue;
        lines.push(header);
        for (const s of await summarizeAll(rows)) lines.push(`- ${s}`);
      }

      if (result.virtualOccurrences.length) {
        lines.push("## Virtual Occurrences (upcoming, not yet materialized)");
        for (const v of result.virtualOccurrences as VirtualOccurrenceDTO[]) {
          lines.push(`- ${v.title ?? "(untitled)"} · ${v.dueAt.slice(0, 10)} [virtual]`);
        }
      }

      const text = lines.length
        ? lines.join("\n")
        : "no tasks";

      return { content: [{ type: "text", text }] };
    }
  );

  // ----- 17. list_tags -----

  server.registerTool(
    "list_tags",
    {
      title: "List Tags",
      description:
        "Return distinct tags across all entities, ordered by usage count (most-used first). Optionally scope to a single project. Useful for discovering existing tag vocabulary before creating tasks or notes.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        projectId: z.string().uuid().optional().describe("Scope to a single project UUID.")
      }
    },
    async ({ projectId }) => {
      const tags = await c.listTags(projectId ?? null);
      const text = tags.length
        ? tags.map((t) => `${t.tag} (${t.count})`).join("\n")
        : "no tags";
      return { content: [{ type: "text", text }] };
    }
  );

  // ----- 18. get_links -----

  server.registerTool(
    "get_links",
    {
      title: "Get Links",
      description:
        "Read typed graph edges for an entity. direction='outgoing' returns edges where the entity is the source; direction='incoming' returns edges where the entity is the target; direction='both' (default) returns all. Filter by kind when you only need a specific edge type (blocks, references, or parent_of).",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        id: EntityRef,
        kind: z.enum(EDGE_KINDS).optional().describe("Edge type filter: blocks, references, parent_of, or supersedes."),
        direction: z.enum(["outgoing", "incoming", "both"]).default("both").describe("Edge direction relative to the given entity.")
      }
    },
    async ({ id, kind, direction }) => {
      const resolvedId = await resolveEntityRef(c, id);
      const links = await c.getLinks(resolvedId, { kind: kind ?? null, direction });
      const summaries = await summarizeAll(links.map((l) => serializeEntity(l.entity)));
      const text = links.length
        ? links
            .map((l, i) => `- [${l.kind} ▸ ${l.direction}] ${summaries[i]}`)
            .join("\n")
        : "no links";
      return { content: [{ type: "text", text }] };
    }
  );

  // ----- 19. update_entities (batch) -----

  const UpdateEntityItem = z.object({
    id: EntityRef,
    projectId: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe("Move to a project UUID, or pass null for workspace scope."),
    title: z.string().max(500).nullable().optional().describe("Pass null to clear the title (notes only)."),
    body: z.string().optional().describe("Replace the entire body. Mutually exclusive with bodyAppend."),
    bodyAppend: z.string().optional().describe("Atomically append text to the body. Mutually exclusive with body."),
    tags: z.array(z.string()).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    parentId: EntityRef.nullable().optional().describe("Re-link or unlink (null) parent."),
    dueAt: z.string().datetime().nullable().optional().describe("ISO datetime or null to clear."),
    priority: z.enum(PRIORITIES).optional(),
    pinned: z.boolean().optional(),
    completedAt: z
      .string()
      .datetime()
      .nullable()
      .optional()
      .describe("Override the completion timestamp of a done task; null clears it."),
    recurrenceScope: z.enum(["this", "future"]).optional()
  });

  server.registerTool(
    "update_entities",
    {
      title: "Batch Update Entities",
      description:
        "Apply per-item patches to multiple tasks or notes in a single call. Each item specifies an entity ref (UUID, UUID prefix, or KEY-SEQ like BOT-55) and the fields to change — same as update_entity. A per-item failure does NOT abort the rest; partial success is reported. Returns one line per item plus a final tally.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        items: z
          .array(UpdateEntityItem)
          .min(1)
          .max(50)
          .describe("List of entities to update (1–50 items).")
      }
    },
    async ({ items }) => {
      try {
        const lines: string[] = [];
        let okCount = 0;
        let failCount = 0;

        for (const item of items) {
          const { id, parentId, ...fields } = item;
          try {
            const resolvedId = await resolveEntityRef(c, id);
            const resolvedParentId =
              parentId === null ? null : parentId !== undefined ? await resolveEntityRef(c, parentId) : undefined;
            const defined: Record<string, unknown> = Object.fromEntries(
              Object.entries(fields).filter(([, v]) => v !== undefined)
            );
            if (resolvedParentId !== undefined) defined.parentId = resolvedParentId;
            const updated = await c.updateEntity(resolvedId, defined);
            lines.push(`✓ ${await summarize(updated)}`);
            okCount++;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            lines.push(`✗ ${id}: ${msg}`);
            failCount++;
          }
        }

        lines.push(`\n${okCount} ok, ${failCount} failed`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: unknown) {
        return formatToolError(err);
      }
    }
  );

  // ----- 20. context -----

  server.registerTool(
    "context",
    {
      title: "Server Context",
      description:
        "Return the current server time, workspace timezone, botnote version, and project list. Call this tool first to resolve relative dates ('tomorrow', 'next Monday') and to pick the correct project UUID before creating tasks.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {}
    },
    async () => {
      const ctx = await c.getContext();
      const projectLines = ctx.projects.map(
        (p) => `  ${p.key} — ${p.name} [${p.status}]`
      );
      const text = [
        `now: ${ctx.now}`,
        `timezone: ${ctx.timezone}`,
        `version: ${ctx.version}`,
        `projects:`,
        ...projectLines
      ].join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  // ----- bonus resource: workspace overview -----

  server.registerResource(
    "workspace_overview",
    "botnote://workspace",
    {
      title: "Workspace Overview",
      description: "List of non-archived projects + most recent activity across the workspace.",
      mimeType: "text/markdown"
    },
    async (uri) => {
      const projects = await c.listProjects();
      const recentRows = await c.recent({
        projectId: null,
        since: null,
        kinds: undefined,
        limit: 20
      });
      const lines: string[] = ["# botnote workspace", ""];
      lines.push("## Projects");
      for (const p of projects) {
        lines.push(`- ${p.key} — ${p.name} [${p.status}] (id: ${p.id})`);
      }
      lines.push("");
      lines.push("## Recent (workspace-wide)");
      const summaries = await summarizeAll(recentRows);
      for (let i = 0; i < recentRows.length; i++) {
        lines.push(
          `- ${recentRows[i]!.createdAt.slice(0, 16).replace("T", " ")} · ${summaries[i]}`
        );
      }
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: lines.join("\n") }] };
    }
  );

  return server;
}
