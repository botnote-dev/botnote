#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DEFAULT_BASE_URL, envValue, unreachableHint } from "./config.js";
import { VERSION } from "./version.js";

interface BotnoteConfig {
  baseUrl: string;
  token?: string;
}

function configDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "botnote") : path.join(home, ".config", "botnote");
}

function configPath(): string {
  return path.join(configDir(), "config.json");
}

function readConfig(): BotnoteConfig {
  const p = configPath();
  const envBaseUrl = envValue(process.env.BOTNOTE_URL);
  const envToken = envValue(process.env.BOTNOTE_TOKEN);
  if (!existsSync(p)) {
    return { baseUrl: envBaseUrl ?? DEFAULT_BASE_URL, token: envToken };
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<BotnoteConfig>;
    return {
      baseUrl: envBaseUrl ?? raw.baseUrl ?? DEFAULT_BASE_URL,
      token: envToken ?? raw.token
    };
  } catch {
    return { baseUrl: envBaseUrl ?? DEFAULT_BASE_URL, token: envToken };
  }
}

function writeConfig(cfg: BotnoteConfig): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

async function apiFetch(
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: RequestInit["body"]; allowNoAuth?: boolean } = {}
): Promise<Response> {
  const cfg = readConfig();
  const headers: Record<string, string> = { ...init.headers };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  let res: Response;
  try {
    // `duplex` is required by Node's fetch for streamed request bodies and is
    // not in the DOM RequestInit type.
    res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers,
      body: init.body,
      duplex: "half"
    } as RequestInit);
  } catch (err) {
    console.error(unreachableHint(cfg.baseUrl, err));
    process.exit(1);
  }
  if (res.status === 401 && !init.allowNoAuth) {
    console.error(
      "401 unauthorized — run `botnote login` and paste a token from Settings → API tokens."
    );
    process.exit(1);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  return res;
}

async function callApi<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { allowNoAuth?: boolean } = {}
): Promise<T> {
  const res = await apiFetch(method, path, {
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    allowNoAuth: opts.allowNoAuth
  });
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function usage(): string {
  return `botnote ${VERSION}

Usage:
  botnote login                            Save a token to ~/.config/botnote/config.json
  botnote logout                           Wipe the saved token
  botnote whoami                           Show config status

  botnote serve                            Run the REST + web daemon (same as: node dist/cli.js)
  botnote mcp                              Run the MCP stdio server (for plugin/agent integration)

  botnote projects [--all]                 List projects
  botnote project archive KEY|UUID         Archive a project
  botnote project restore KEY|UUID         Restore an archived project
  botnote today                            Show today + overdue tasks
  botnote tasks [--status open]            List tasks
  botnote task "<title>" [--project KEY] [--due YYYY-MM-DD] [--priority P]
                       [--repeat hourly|daily|weekly|monthly|yearly] [--interval N]
                       [--on MO,WE] [--anchor scheduled|completion]
                       [--count N] [--until YYYY-MM-DD]
                                           Create a task
  botnote note "<body>" [--project KEY] [--pin]
                                           Create a note (no title)
  botnote done TASK [--worklog "..."]      Mark a task done, optionally with a worklog entry
  botnote update TASK [--status S] [--priority P] [--due YYYY-MM-DD|none]
                      [--title "..."] [--project KEY] [--tags a,b]
                                           Update a task or note
  botnote worklog TASK "<body>"            Append a worklog entry
  botnote recurrence TASK                  Show recurrence for a task
  botnote skip TASK [--reason "..."]       Skip current recurring occurrence
  botnote stop-recurrence TASK             Stop a task's recurrence series
  botnote search "<query>" [--limit 10]    Hybrid search

  botnote export [--out FILE] [--vectors]  Dump the workspace as JSON Lines (stdout by default)
  botnote import FILE                      Load a dump; existing ids are skipped, conflicts reported

Env:
  BOTNOTE_URL   override the server base URL (default ${DEFAULT_BASE_URL}, the daemon on this machine)
  BOTNOTE_TOKEN override the saved bearer token (not needed for a trusted local daemon)

Config: ${configPath()}
`;
}

interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ----- subcommands -----

async function cmdLogin(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const current = readConfig();
  const baseUrl = (await rl.question(`Base URL [${current.baseUrl}]: `)).trim() || current.baseUrl;
  const token = (await rl.question("Token (bn_..., empty for a trusted local daemon): ")).trim();
  rl.close();
  if (token && !token.startsWith("bn_")) {
    console.error("token should start with 'bn_'. Aborting.");
    process.exit(1);
  }
  writeConfig(token ? { baseUrl, token } : { baseUrl });
  console.log(`saved to ${configPath()}`);
}

function cmdLogout(): void {
  const p = configPath();
  if (existsSync(p)) {
    rmSync(p);
    console.log(`removed ${p}`);
  } else {
    console.log("no config to remove");
  }
}

function cmdWhoami(): void {
  const cfg = readConfig();
  console.log(`baseUrl: ${cfg.baseUrl}`);
  console.log(`token:   ${cfg.token ? `${cfg.token.slice(0, 11)}…` : "(none)"}`);
  console.log(`config:  ${configPath()}`);
}

interface Project {
  id: string;
  key: string;
  name: string;
  status: string;
  color: string;
  icon: string;
  archivedAt: string | null;
}

interface Entity {
  id: string;
  projectId: string | null;
  kind: string;
  title: string | null;
  body: string;
  status: string;
  dueAt: string | null;
  priority: string;
  sequenceId: number | null;
  tags: string[];
}

interface RecurrenceRule {
  id: string;
  rrule: string;
  anchor: string;
  enabled: boolean;
  nextOccurrenceAt: string | null;
}

interface RecurrenceDetails {
  rule: RecurrenceRule;
  currentOccurrence: Entity | null;
}

interface SkipOccurrenceResult {
  skipped: Entity;
  next: Entity | null;
  rule: RecurrenceRule;
}

interface TasksRangeResult {
  scheduled: Entity[];
  overdue: Entity[];
  backlog: Entity[];
}

function displayTitle(e: { title: string | null; body: string }): string {
  if (e.title && e.title.trim()) return e.title;
  const first = e.body.split("\n").find((l) => l.trim())?.trim() ?? "";
  return first ? (first.length > 60 ? `${first.slice(0, 60)}…` : first) : "(untitled)";
}

async function cmdProjects(args: Args): Promise<void> {
  const includeArchived = Boolean(args.flags.all);
  const projects = await callApi<Project[]>(
    "GET",
    includeArchived ? "/v1/projects?includeArchived=true" : "/v1/projects"
  );
  for (const p of projects) {
    const archived = p.archivedAt ? ` (archived ${p.archivedAt.slice(0, 10)})` : "";
    console.log(`${p.key.padEnd(10)} [${p.status.padEnd(8)}] ${p.name}${archived}`);
  }
}

async function cmdProject(args: Args): Promise<void> {
  const [action, keyOrId] = args.positional;
  if (!action || !keyOrId || (action !== "archive" && action !== "restore")) {
    console.error("usage: botnote project archive KEY|UUID");
    console.error("   or: botnote project restore KEY|UUID");
    process.exit(1);
  }

  const projectId = await resolveProjectId(keyOrId, { includeArchived: true });
  const project = await callApi<Project>("PATCH", `/v1/projects/${projectId}`, {
    status: action === "archive" ? "archived" : "active"
  });
  console.log(`✓ ${action === "archive" ? "archived" : "restored"} project ${project.key}`);
}

async function cmdToday(): Promise<void> {
  const projects = await callApi<Project[]>("GET", "/v1/projects");
  const projectByKey = new Map(projects.map((p) => [p.id, p]));
  const today = new Date();
  const from = new Date(today);
  from.setHours(0, 0, 0, 0);
  const to = new Date(today);
  to.setHours(23, 59, 59, 999);
  const data = await callApi<TasksRangeResult>("POST", "/v1/tasks/range", {
    from: from.toISOString(),
    to: to.toISOString(),
    includeBacklog: false,
    includeDone: false
  });
  printSection("Overdue", data.overdue, projectByKey);
  printSection("Today", data.scheduled, projectByKey);
}

function printSection(title: string, tasks: Entity[], pm: Map<string, Project>): void {
  console.log(`\n## ${title} (${tasks.length})`);
  if (tasks.length === 0) {
    console.log("  —");
    return;
  }
  for (const t of tasks) {
    const p = t.projectId ? pm.get(t.projectId) : undefined;
    const id = p && t.sequenceId ? `${p.key}-${t.sequenceId}` : t.id.slice(0, 8);
    const due = t.dueAt ? `(due ${t.dueAt.slice(0, 10)}) ` : "";
    const prio = t.priority !== "none" ? `[${t.priority}] ` : "";
    console.log(`  [${t.status}] ${id.padEnd(10)} ${prio}${due}${displayTitle(t)}`);
  }
}

async function cmdTasks(args: Args): Promise<void> {
  const projects = await callApi<Project[]>("GET", "/v1/projects");
  const pm = new Map(projects.map((p) => [p.id, p]));
  const status = (args.flags.status as string | undefined) ?? null;
  const rows = await callApi<Entity[]>("POST", "/v1/recent", {
    kinds: ["task"],
    limit: 100
  });
  const filtered = status ? rows.filter((r) => r.status === status) : rows;
  for (const t of filtered) {
    const p = t.projectId ? pm.get(t.projectId) : undefined;
    const id = p && t.sequenceId ? `${p.key}-${t.sequenceId}` : t.id.slice(0, 8);
    const due = t.dueAt ? ` (due ${t.dueAt.slice(0, 10)})` : "";
    console.log(`[${t.status.padEnd(11)}] ${id.padEnd(10)} ${displayTitle(t)}${due}`);
  }
}

async function resolveProjectId(
  keyOrId?: string,
  opts: { includeArchived?: boolean } = {}
): Promise<string | undefined> {
  if (!keyOrId) {
    const env = process.env.BOTNOTE_PROJECT;
    if (env) return resolveProjectId(env, opts);
    return undefined;
  }
  if (/^[0-9a-f-]{36}$/i.test(keyOrId)) return keyOrId;
  const projects = await callApi<Project[]>(
    "GET",
    opts.includeArchived ? "/v1/projects?includeArchived=true" : "/v1/projects"
  );
  const hit = projects.find((p) => p.key.toUpperCase() === keyOrId.toUpperCase());
  if (!hit) throw new Error(`project not found: ${keyOrId}`);
  return hit.id;
}

async function resolveEntity(identifier: string): Promise<Entity> {
  if (/^[0-9a-f-]{36}$/i.test(identifier)) {
    return callApi<Entity>("GET", `/v1/entities/${identifier}`);
  }
  const match = /^([A-Z][A-Z0-9_]*)-(\d+)$/i.exec(identifier);
  if (!match) throw new Error(`task identifier must be a UUID or KEY-123; got ${identifier}`);
  const key = match[1]!.toUpperCase();
  const seq = Number(match[2]);
  return callApi<Entity>("GET", `/v1/projects/by-key/${key}/entities/by-seq/${seq}`);
}

function splitList(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function recurrenceBody(args: Args, dueAt: string | null): Record<string, unknown> | null {
  const repeat = args.flags.repeat as string | undefined;
  const rrule = args.flags.rrule as string | undefined;
  if (!repeat && !rrule) return null;
  if (!dueAt && !args.flags.dtstart) {
    throw new Error("recurring tasks require --due YYYY-MM-DD or --dtstart ISO");
  }
  const body: Record<string, unknown> = {};
  if (rrule) body.rrule = rrule;
  else body.preset = repeat;
  if (args.flags.interval) body.interval = Number(args.flags.interval);
  const weekdays = splitList(args.flags.on);
  if (weekdays) body.byWeekday = weekdays.map((d) => d.toUpperCase());
  const monthDays = splitList(args.flags["month-day"]);
  if (monthDays) body.byMonthDay = monthDays.map(Number);
  const months = splitList(args.flags.month);
  if (months) body.byMonth = months.map(Number);
  if (args.flags.until) body.until = new Date(`${args.flags.until as string}T23:59:59Z`).toISOString();
  if (args.flags.count) body.count = Number(args.flags.count);
  if (args.flags.dtstart) body.dtstart = args.flags.dtstart;
  if (args.flags.timezone) body.timezone = args.flags.timezone;
  if (args.flags.anchor) body.anchor = args.flags.anchor;
  return body;
}

async function cmdTask(args: Args): Promise<void> {
  const title = args.positional.join(" ").trim();
  if (!title) {
    console.error('usage: botnote task "<title>" [--project KEY] [--due YYYY-MM-DD] [--priority P]');
    process.exit(1);
  }
  const projectId = await resolveProjectId(args.flags.project as string | undefined);
  const dueAt = args.flags.due
    ? new Date(`${args.flags.due as string}T12:00:00Z`).toISOString()
    : null;
  const priority = (args.flags.priority as string | undefined) ?? "none";
  const entity = await callApi<Entity>("POST", "/v1/tasks", {
    projectId: projectId ?? null,
    title,
    actorKind: "human",
    dueAt,
    priority
  });
  const recurrence = recurrenceBody(args, dueAt);
  if (recurrence) {
    const rule = await callApi<RecurrenceRule>("POST", `/v1/tasks/${entity.id}/recurrence`, recurrence);
    console.log(`✓ wrote recurring task ${entity.id}`);
    console.log(`  recurrence ${rule.rrule} (${rule.anchor})`);
    return;
  }
  console.log(`✓ wrote task ${entity.id}`);
}

const TASK_STATUSES = ["open", "in_progress", "done", "rejected"] as const;
const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;

/** Date-only CLI input becomes noon UTC, so a due date reads the same in every
 *  timezone the user might be in. `none` / `clear` wipes the field. */
function parseDueFlag(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (v === "none" || v === "clear" || v === "null") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new Error(`--due expects YYYY-MM-DD or none; got ${value}`);
  }
  return new Date(`${value.trim()}T12:00:00Z`).toISOString();
}

function requireEnum<T extends string>(
  flag: string,
  value: string,
  allowed: readonly T[]
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`--${flag} must be one of: ${allowed.join(", ")}; got ${value}`);
  }
  return value as T;
}

/** Echo an entity back the way the user addressed it, so the confirmation line
 *  is greppable against what they typed. */
function describeEntity(identifier: string, e: Entity): string {
  return `${identifier} [${e.status}] ${displayTitle(e)}`;
}

async function updatePatchFromFlags(args: Args): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};
  if (typeof args.flags.status === "string") {
    patch.status = requireEnum("status", args.flags.status, TASK_STATUSES);
  }
  if (typeof args.flags.priority === "string") {
    patch.priority = requireEnum("priority", args.flags.priority, PRIORITIES);
  }
  if (typeof args.flags.due === "string") {
    patch.dueAt = parseDueFlag(args.flags.due);
  }
  if (typeof args.flags.title === "string") {
    patch.title = args.flags.title;
  }
  if (typeof args.flags.project === "string") {
    patch.projectId = await resolveProjectId(args.flags.project);
  }
  const tags = splitList(args.flags.tags);
  if (tags) patch.tags = tags;
  return patch;
}

async function cmdUpdate(args: Args): Promise<void> {
  const identifier = args.positional[0];
  if (!identifier) {
    console.error(
      'usage: botnote update TASK [--status S] [--priority P] [--due YYYY-MM-DD|none] [--title "..."] [--project KEY] [--tags a,b]'
    );
    process.exit(1);
  }
  const patch = await updatePatchFromFlags(args);
  if (Object.keys(patch).length === 0) {
    console.error("nothing to update — pass at least one of --status --priority --due --title --project --tags");
    process.exit(1);
  }
  const target = await resolveEntity(identifier);
  const updated = await callApi<Entity>("PATCH", `/v1/entities/${target.id}`, patch);
  console.log(`✓ updated ${describeEntity(identifier, updated)}`);
  for (const [field, value] of Object.entries(patch)) {
    console.log(`  ${field}: ${value === null ? "(cleared)" : String(value)}`);
  }
}

async function cmdDone(args: Args): Promise<void> {
  const identifier = args.positional[0];
  if (!identifier) {
    console.error('usage: botnote done TASK [--worklog "..."]');
    process.exit(1);
  }
  const target = await resolveEntity(identifier);
  const updated = await callApi<Entity>("PATCH", `/v1/entities/${target.id}`, { status: "done" });
  console.log(`✓ done ${describeEntity(identifier, updated)}`);
  // A closing worklog entry is what the next session reads first, so make it
  // one command instead of two.
  if (typeof args.flags.worklog === "string") {
    await callApi<Entity>("POST", `/v1/entities/${target.id}/worklog`, {
      body: args.flags.worklog,
      actorKind: "human"
    });
    console.log("  worklog entry added");
  }
}

async function cmdWorklog(args: Args): Promise<void> {
  const [identifier, ...bodyParts] = args.positional;
  const body = bodyParts.join(" ").trim();
  if (!identifier || !body) {
    console.error('usage: botnote worklog TASK "<body>"');
    process.exit(1);
  }
  const target = await resolveEntity(identifier);
  const entry = await callApi<Entity>("POST", `/v1/entities/${target.id}/worklog`, {
    body,
    actorKind: "human"
  });
  console.log(`✓ logged on ${identifier} (${entry.id.slice(0, 8)})`);
}

async function cmdRecurrence(args: Args): Promise<void> {
  const identifier = args.positional[0];
  if (!identifier) {
    console.error("usage: botnote recurrence TASK");
    process.exit(1);
  }
  const task = await resolveEntity(identifier);
  const details = await callApi<RecurrenceDetails>("GET", `/v1/tasks/${task.id}/recurrence`);
  console.log(`rule:    ${details.rule.id}`);
  console.log(`enabled: ${details.rule.enabled}`);
  console.log(`rrule:   ${details.rule.rrule}`);
  console.log(`anchor:  ${details.rule.anchor}`);
  console.log(`next:    ${details.rule.nextOccurrenceAt ?? "-"}`);
}

async function cmdSkip(args: Args): Promise<void> {
  const identifier = args.positional[0];
  if (!identifier) {
    console.error('usage: botnote skip TASK [--reason "..."]');
    process.exit(1);
  }
  const task = await resolveEntity(identifier);
  const result = await callApi<SkipOccurrenceResult>(
    "POST",
    `/v1/tasks/${task.id}/skip-occurrence`,
    { reason: args.flags.reason as string | undefined, actorKind: "human" }
  );
  console.log(`✓ skipped ${result.skipped.id}`);
  console.log(`next: ${result.next ? result.next.id : "-"}`);
}

async function cmdStopRecurrence(args: Args): Promise<void> {
  const identifier = args.positional[0];
  if (!identifier) {
    console.error("usage: botnote stop-recurrence TASK");
    process.exit(1);
  }
  const task = await resolveEntity(identifier);
  const details = await callApi<RecurrenceDetails>("GET", `/v1/tasks/${task.id}/recurrence`);
  const rule = await callApi<RecurrenceRule>("POST", `/v1/recurrences/${details.rule.id}/stop`, {
    reason: args.flags.reason as string | undefined
  });
  console.log(`✓ stopped recurrence ${rule.id}`);
}

async function cmdNote(args: Args): Promise<void> {
  const body = args.positional.join(" ").trim();
  if (!body) {
    console.error('usage: botnote note "<body>" [--project KEY] [--pin]');
    process.exit(1);
  }
  const projectId = await resolveProjectId(args.flags.project as string | undefined);
  const entity = await callApi<Entity>("POST", "/v1/notes", {
    projectId: projectId ?? null,
    body,
    actorKind: "human",
    pinned: Boolean(args.flags.pin)
  });
  console.log(`✓ wrote note ${entity.id}`);
}

interface SearchHit {
  entity: Entity;
  score: number;
}
interface SearchResponse {
  hits: SearchHit[];
  embeddingUsed: boolean;
}

async function cmdSearch(args: Args): Promise<void> {
  const query = args.positional.join(" ").trim();
  if (!query) {
    console.error('usage: botnote search "<query>" [--limit N]');
    process.exit(1);
  }
  const limit = Number(args.flags.limit ?? 10);
  const [data, projects] = await Promise.all([
    callApi<SearchResponse>("POST", "/v1/search", { query, limit }),
    callApi<Project[]>("GET", "/v1/projects?includeArchived=true")
  ]);
  const pm = new Map(projects.map((p) => [p.id, p]));
  console.log(`${data.hits.length} hit(s) · embedding=${data.embeddingUsed ? "on" : "off"}\n`);
  for (const h of data.hits) {
    const p = h.entity.projectId ? pm.get(h.entity.projectId) : undefined;
    const id = p && h.entity.sequenceId ? `${p.key}-${h.entity.sequenceId}` : h.entity.id.slice(0, 8);
    console.log(
      `[${h.score.toFixed(3)}] ${h.entity.kind.padEnd(7)} ${id.padEnd(10)} ${displayTitle(h.entity)}`
    );
    if (h.entity.body) {
      console.log(`        ${h.entity.body.slice(0, 100).replace(/\n/g, " ")}`);
    }
  }
}

async function cmdExport(args: Args): Promise<void> {
  const out = typeof args.flags.out === "string" ? args.flags.out : null;
  const vectors = args.flags.vectors === true;
  const res = await apiFetch("GET", `/v1/export${vectors ? "?vectors=1" : ""}`);
  if (!res.body) throw new Error("export returned no body");
  let lines = 0;
  const counter = async function* (source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      for (const byte of chunk) if (byte === 10) lines++;
      yield chunk;
    }
  };
  const sink = out ? createWriteStream(out) : process.stdout;
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), counter, sink, {
    end: Boolean(out)
  });
  if (out) console.error(`exported ${Math.max(lines - 1, 0)} records to ${out}`);
}

interface ImportReport {
  formatVersion: number;
  botnoteVersion: string;
  exportedAt: string;
  sourceWorkspace: { id: string; slug: string; name: string };
  counts: Record<string, { imported: number; skipped: number; conflicts: number }>;
  conflicts: Array<{ type: string; id: string; reason: string }>;
  conflictsTotal: number;
  entitiesWithoutVector: number;
}

async function cmdImport(args: Args): Promise<void> {
  const file = args.positional[0];
  if (!file) throw new Error('usage: botnote import FILE');
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  const res = await apiFetch("POST", "/v1/import", {
    headers: { "content-type": "application/x-ndjson" },
    body: Readable.toWeb(createReadStream(file)) as unknown as RequestInit["body"]
  });
  const report = (await res.json()) as ImportReport;
  console.log(
    `imported dump from ${report.sourceWorkspace.name || report.sourceWorkspace.id} (botnote ${report.botnoteVersion}, format ${report.formatVersion}, exported ${report.exportedAt})`
  );
  for (const [type, c] of Object.entries(report.counts)) {
    if (c.imported + c.skipped + c.conflicts === 0) continue;
    console.log(
      `  ${type.padEnd(21)} imported ${String(c.imported).padStart(6)}  skipped ${String(c.skipped).padStart(6)}  conflicts ${String(c.conflicts).padStart(6)}`
    );
  }
  if (report.entitiesWithoutVector > 0) {
    console.log(
      `  ${report.entitiesWithoutVector} entities arrived without a vector; the daemon re-embeds them in the background`
    );
  }
  if (report.conflictsTotal > 0) {
    console.log(`conflicts (${report.conflictsTotal}):`);
    for (const c of report.conflicts) console.log(`  ${c.type} ${c.id}: ${c.reason}`);
    if (report.conflictsTotal > report.conflicts.length) {
      console.log(`  ... ${report.conflictsTotal - report.conflicts.length} more`);
    }
    process.exitCode = 3;
  }
}

function cmdServe(): void {
  // Re-exec into the existing daemon entry. dist/cli.js is sibling of dist/bin.js.
  const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), "cli.js");
  execFileSync(process.execPath, [cli], { stdio: "inherit" });
}

function cmdMcp(): void {
  const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), "cli.js");
  execFileSync(process.execPath, [cli, "mcp"], { stdio: "inherit" });
}

async function main(): Promise<void> {
  const [, , subcommand, ...rest] = process.argv;
  const args = parseArgs(rest);
  // `botnote search foo --help` asks for help, not for a search of "foo".
  const wantsHelp = "help" in args.flags || rest.includes("-h");

  switch (subcommand) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(usage());
      return;
  }
  if (wantsHelp) {
    process.stdout.write(usage());
    return;
  }
  switch (subcommand) {
    case "version":
    case "-v":
    case "--version":
      console.log(VERSION);
      return;
    case "login":
      return cmdLogin();
    case "logout":
      return cmdLogout();
    case "whoami":
      return cmdWhoami();
    case "serve":
      return cmdServe();
    case "mcp":
      return cmdMcp();
    case "projects":
      return cmdProjects(args);
    case "project":
      return cmdProject(args);
    case "today":
      return cmdToday();
    case "tasks":
      return cmdTasks(args);
    case "task":
      return cmdTask(args);
    case "recurrence":
      return cmdRecurrence(args);
    case "skip":
      return cmdSkip(args);
    case "stop-recurrence":
      return cmdStopRecurrence(args);
    case "note":
      return cmdNote(args);
    case "done":
      return cmdDone(args);
    case "update":
      return cmdUpdate(args);
    case "worklog":
      return cmdWorklog(args);
    case "search":
      return cmdSearch(args);
    case "export":
      return cmdExport(args);
    case "import":
      return cmdImport(args);
    default:
      console.error(`unknown subcommand: ${subcommand}\n`);
      process.stdout.write(usage());
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
