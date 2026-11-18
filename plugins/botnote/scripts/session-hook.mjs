#!/usr/bin/env node
// Claude Code hooks for botnote. Usage: session-hook.mjs <post-tool-use|stop|user-prompt-submit>
//
// `stop` hands the event to a detached `stop-worker` child and returns at
// once. An async hook would be simpler, but Claude Code cancels async hooks
// still running when a `claude -p` session exits, so headless sessions would
// never get a snapshot; a detached child outlives the session and the hook
// still costs the user no waiting.
//
// None of these hooks block, force a turn, or call a model. They track which
// botnote task this session works on (post-tool-use), keep one overwritten
// session snapshot on that task (stop), and print a one-line reminder only
// when the task has gone a long while without a worklog entry
// (user-prompt-submit). Any failure exits 0 silently: a hook must never get in
// the way of the session.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TOOL_PREFIX = "mcp__plugin_botnote_botnote__";
const TASK_KEY_RE = /\b([A-Z][A-Z0-9_]*-\d+)\b/;
const NUDGE_PROMPTS = Number(process.env.BOTNOTE_NUDGE_PROMPTS) || 8;
const NUDGE_MINUTES = Number(process.env.BOTNOTE_NUDGE_MINUTES) || 30;
const STATE_TTL_MS = 14 * 24 * 3600_000;
const HTTP_TIMEOUT_MS = 5000;

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

function stateDir() {
  const base = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), ".cache", "botnote");
  const dir = join(base, "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function statePath(sessionId) {
  return join(stateDir(), `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function loadState(sessionId) {
  try {
    return JSON.parse(readFileSync(statePath(sessionId), "utf8"));
  } catch {
    return { taskRef: null, since: Date.now(), prompts: 0, lastWorklogAt: null, lastNudgeAt: null };
  }
}

function saveState(sessionId, state) {
  writeFileSync(statePath(sessionId), JSON.stringify(state));
}

function pruneOldState() {
  const dir = stateDir();
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (statSync(p).mtimeMs < cutoff) rmSync(p);
    } catch {}
  }
}

function setting(value) {
  const v = value?.trim();
  return v && !v.startsWith("${") ? v : undefined;
}

function daemon() {
  let cfg = {};
  try {
    const path = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "botnote", "config.json");
    if (existsSync(path)) cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  const url =
    setting(process.env.CLAUDE_PLUGIN_OPTION_BOTNOTE_URL) ||
    setting(process.env.BOTNOTE_URL) ||
    setting(cfg.baseUrl) ||
    "http://127.0.0.1:4280";
  const token =
    setting(process.env.CLAUDE_PLUGIN_OPTION_BOTNOTE_TOKEN) ||
    setting(process.env.BOTNOTE_TOKEN) ||
    setting(cfg.token);
  return { url: url.replace(/\/+$/, ""), token };
}

function refFromInput(input) {
  const ref = input?.id ?? input?.entityId ?? input?.parentId;
  return typeof ref === "string" && ref ? ref : null;
}

function refFromResponse(response) {
  const m = TASK_KEY_RE.exec(typeof response === "string" ? response : JSON.stringify(response ?? ""));
  return m ? m[1] : null;
}

function onPostToolUse(event) {
  const tool = String(event.tool_name || "");
  if (!tool.startsWith(TOOL_PREFIX)) return;
  const name = tool.slice(TOOL_PREFIX.length);
  const input = event.tool_input || {};
  const state = loadState(event.session_id);
  const now = Date.now();

  if (name === "add_worklog") {
    const ref = refFromInput(input);
    if (ref) state.taskRef = ref;
    state.lastWorklogAt = now;
    state.prompts = 0;
  } else if (name === "update_entity" || name === "update_entities") {
    const ref = refFromInput(input);
    if (input.status === "in_progress" && ref) {
      state.taskRef = ref;
      state.since = now;
      state.prompts = 0;
    } else if ((input.status === "done" || input.status === "rejected") && ref && ref === state.taskRef) {
      state.taskRef = null;
    }
  } else if (name === "create_task" && input.status === "in_progress") {
    const ref = refFromResponse(event.tool_response);
    if (ref) {
      state.taskRef = ref;
      state.since = now;
      state.prompts = 0;
    }
  } else if (name === "list_worklog" && !state.taskRef) {
    const ref = refFromInput(input);
    if (ref) {
      state.taskRef = ref;
      state.since = now;
    }
  } else {
    return;
  }
  saveState(event.session_id, state);
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    timeout: 2000,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8"
  }).trimEnd();
}

function changedFiles(cwd) {
  try {
    const stat = git(cwd, ["diff", "--stat", "HEAD"]);
    const lines = stat ? stat.split("\n") : [];
    const trimmed = lines.length > 30 ? [...lines.slice(0, 29), lines[lines.length - 1]] : lines;
    const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
    if (untracked.length) trimmed.push(`${untracked.length} untracked file${untracked.length === 1 ? "" : "s"}`);
    return trimmed.join("\n");
  } catch {
    return "";
  }
}

function handOffStop(event) {
  const file = join(stateDir(), `stop-${process.pid}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(event));
  spawn(process.execPath, [process.argv[1], "stop-worker", file], {
    detached: true,
    stdio: "ignore"
  }).unref();
}

async function onStopWorker(file) {
  let event;
  try {
    event = JSON.parse(readFileSync(file, "utf8"));
  } finally {
    rmSync(file, { force: true });
  }
  if (event?.session_id) await onStop(event);
}

async function onStop(event) {
  const state = loadState(event.session_id);
  pruneOldState();
  if (!state.taskRef) return;
  const { url, token } = daemon();
  const summary = String(event.last_assistant_message || "").trim().slice(0, 2000);
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  await fetch(`${url}/v1/tasks/${encodeURIComponent(state.taskRef)}/session-snapshot`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      sessionId: String(event.session_id),
      client: "claude-code",
      summary,
      changedFiles: changedFiles(event.cwd || process.cwd()).slice(0, 4000),
      cwd: event.cwd || null,
      actorKind: "system"
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  });
}

function onUserPromptSubmit(event) {
  const state = loadState(event.session_id);
  state.prompts = (state.prompts || 0) + 1;
  const now = Date.now();
  const quietSince = state.lastWorklogAt ?? state.since ?? now;
  const minutes = Math.floor((now - quietSince) / 60_000);
  const nudgedRecently = state.lastNudgeAt && now - state.lastNudgeAt < NUDGE_MINUTES * 60_000;
  if (state.taskRef && state.prompts >= NUDGE_PROMPTS && minutes >= NUDGE_MINUTES && !nudgedRecently) {
    state.lastNudgeAt = now;
    process.stdout.write(
      `botnote: ${state.taskRef} has had no worklog entry for ${minutes} min (${state.prompts} prompts). ` +
        "If you have reached a checkpoint, record what was done, what's next, and any blockers with add_worklog.\n"
    );
  }
  saveState(event.session_id, state);
}

async function main() {
  const kind = process.argv[2];
  if (kind === "stop-worker") return onStopWorker(process.argv[3]);
  const event = readStdin();
  if (!event?.session_id) return;
  if (kind === "post-tool-use") onPostToolUse(event);
  else if (kind === "stop") handOffStop(event);
  else if (kind === "user-prompt-submit") onUserPromptSubmit(event);
}

main().catch(() => {}).finally(() => process.exit(0));
