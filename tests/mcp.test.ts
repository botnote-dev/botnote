import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BotnoteHttpClient } from "../src/mcp/http-client.js";
import { buildServer } from "../src/rest/server.js";
import { EmbeddingService } from "../src/service/embedding.js";
import { createTestDb } from "./test_db.js";

const ROOT = path.resolve(import.meta.dirname, "..");

const { db: rawDb, pool } = createTestDb();
const embedding = new EmbeddingService(rawDb);

let server: FastifyInstance;
let baseUrl: string;
let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  await rawDb.execute(sql`
    TRUNCATE recurrence_exceptions, recurrence_rules, entities, edges, projects, tokens, sessions
    RESTART IDENTITY CASCADE
  `);

  server = await buildServer({ db: rawDb, embedding, logLevel: "warn" });
  await server.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.server.address();
  if (typeof addr === "object" && addr !== null) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  } else {
    throw new Error("could not derive REST baseUrl");
  }

  transport = new StdioClientTransport({
    command: "node",
    args: ["--import", "tsx", path.join(ROOT, "src/cli.ts"), "mcp"],
    env: { ...process.env, BOTNOTE_URL: baseUrl, NODE_OPTIONS: "--no-warnings" }
  });
  client = new Client({ name: "botnote-test", version: "0.0.1" });
  await client.connect(transport);
}, 30000);

afterAll(async () => {
  await client?.close();
  await server?.close();
  await pool.end();
}, 10000);

/**
 * Assert that no internal embedding/tsvector field names appear as JSON keys
 * in an MCP response. We check for the patterns `"bodyVec":` and `"body_vec":`
 * (with the leading quote and trailing colon) so we match JSON object keys
 * rather than incidental string values in body text.
 */
function assertNoInternalFields(text: string, label: string): void {
  const forbidden = ['"bodyVec":', '"bodyTsv":', '"body_vec":', '"body_tsv":'];
  for (const field of forbidden) {
    expect(text, `${label} should not contain JSON key ${field}`).not.toContain(field);
  }
}

describe("botnote MCP", () => {
  it("lists current tools + workspace resource", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "add_worklog",
      "configure_recurrence",
      "context",
      "create_project",
      "create_task",
      "get_entity",
      "get_entity_by_key",
      "get_links",
      "get_project",
      "get_recurrence",
      "link",
      "list_feedback",
      "list_projects",
      "list_tags",
      "list_tasks",
      "list_worklog",
      "opening_brief",
      "recent",
      "related",
      "remember",
      "search",
      "skip_occurrence",
      "split_recurrence",
      "stop_recurrence",
      "submit_feedback",
      "update_entities",
      "update_entity",
      "update_project"
    ]);
    const resources = await client.listResources();
    const resourceNames = resources.resources.map((r) => r.name);
    expect(resourceNames).toContain("workspace_overview");
  });

  it("surfaces server instructions with behavioral rules", async () => {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("Proactive task capture");
    expect(instructions).toContain("KEY-SEQ");
    expect(instructions).toContain("opening_brief");
  });

  it("annotates read/write/destructive correctly", async () => {
    const tools = await client.listTools();
    const byName = new Map(tools.tools.map((t) => [t.name, t]));
    expect(byName.get("opening_brief")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("search")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("remember")?.annotations?.idempotentHint).toBe(true);
    expect(byName.get("update_entity")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("link")?.annotations?.idempotentHint).toBe(true);
    expect(byName.get("update_project")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("configure_recurrence")?.annotations?.idempotentHint).toBe(true);
    expect(byName.get("get_recurrence")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("skip_occurrence")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("split_recurrence")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("split_recurrence")?.annotations?.idempotentHint).toBe(false);
  });

  it("create_project + remember + search round-trip", async () => {
    const createResp = await client.callTool({
      name: "create_project",
      arguments: { key: "MCP", name: "MCP Test", agentsMd: "## NEVER ship without tests" }
    });
    const createText = (createResp.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(createText).toMatch(/created project MCP/);
    const idMatch = createText.match(/id: ([0-9a-f-]{36})/);
    const projectId = idMatch?.[1];
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    const writeResp = await client.callTool({
      name: "remember",
      arguments: {
        projectId,
        title: "Adopt MCP 2025-03-26 annotations",
        body: "All tools must declare readOnlyHint / idempotentHint / destructiveHint",
        tags: ["mcp", "convention"],
        actorKind: "agent"
      }
    });
    const writeText = (writeResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(writeText).toMatch(/remembered MCP-\d+/);

    const searchResp = await client.callTool({
      name: "search",
      arguments: { query: "MCP annotations", projectId, limit: 5 }
    });
    const searchText = (searchResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(searchText).toMatch(/Adopt MCP 2025-03-26 annotations/);
    expect(searchText).toMatch(/embedding=off/);
    // Search output leads with the human-readable KEY-SEQ ref, not the UUID.
    expect(searchText).toMatch(/MCP-\d+ · Adopt MCP 2025-03-26 annotations/);
    const noteId = writeText.match(/id: ([0-9a-f-]{36})/)?.[1];
    expect(noteId).toMatch(/^[0-9a-f-]{36}$/);

    const getResp = await client.callTool({
      name: "get_entity",
      arguments: { id: noteId }
    });
    const getText = (getResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(getText).toContain("Adopt MCP 2025-03-26 annotations");
    assertNoInternalFields(getText, "get_entity");

    const shortId = noteId!.slice(0, 8);
    const getByPrefixResp = await client.callTool({
      name: "get_entity",
      arguments: { id: shortId }
    });
    const getByPrefixText = (getByPrefixResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(getByPrefixText).toContain(noteId!);

    const updateByPrefixResp = await client.callTool({
      name: "update_entity",
      arguments: { id: shortId, title: "Adopt MCP annotations with short ids" }
    });
    const updateByPrefixText =
      (updateByPrefixResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(updateByPrefixText).toContain("Adopt MCP annotations with short ids");
  });

  it("unexpected tool errors nudge toward submit_feedback, client errors do not", async () => {
    // update on a nonexistent UUID surfaces as an unexpected (5xx) error.
    const unexpectedResp = await client.callTool({
      name: "update_entity",
      arguments: { id: "00000000-0000-0000-0000-000000000000", title: "x" }
    });
    const unexpectedText =
      (unexpectedResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(unexpectedResp.isError).toBe(true);
    expect(unexpectedText).toContain("submit_feedback");

    // A malformed KEY-SEQ lookup is the caller's mistake (404) — no nudge.
    const clientErrResp = await client.callTool({
      name: "get_entity_by_key",
      arguments: { projectKey: "NOPE", sequenceId: 999 }
    });
    const clientErrText =
      (clientErrResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(clientErrResp.isError).toBe(true);
    expect(clientErrText).not.toContain("submit_feedback");
  });

  it("submit_feedback files and list_feedback filters product feedback", async () => {
    const submitResp = await client.callTool({
      name: "submit_feedback",
      arguments: {
        category: "friction",
        title: "opening_brief output is too long for small context windows",
        body: "A brief with 20 open tasks plus pinned notes exceeds what a short session wants to read.",
        tool: "opening_brief"
      }
    });
    const submitText = (submitResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(submitText).toMatch(/feedback filed \(friction\)/);

    const listResp = await client.callTool({
      name: "list_feedback",
      arguments: { category: "friction", status: "open" }
    });
    const listText = (listResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(listText).toContain("[friction · opening_brief]");
    expect(listText).toContain("opening_brief output is too long");

    const otherCategoryResp = await client.callTool({
      name: "list_feedback",
      arguments: { category: "bug" }
    });
    const otherCategoryText =
      (otherCategoryResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(otherCategoryText).not.toContain("opening_brief output is too long");
  });

  it("remember flags near-duplicates and supports supersedes", async () => {
    const createResp = await client.callTool({
      name: "create_project",
      arguments: { key: "MEM", name: "Memory MCP" }
    });
    const projectId = (createResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    expect(projectId).toBeTruthy();

    const firstResp = await client.callTool({
      name: "remember",
      arguments: { projectId, title: "CI cache key uses pnpm lockfile hash", body: "See .github/workflows/ci.yml" }
    });
    const firstText = (firstResp.content as Array<{ text: string }>)[0]?.text ?? "";
    const firstId = firstText.match(/id: ([0-9a-f-]{36})/)?.[1];
    expect(firstId).toBeTruthy();

    // A second capture of the same fact should come back with a dedup hint.
    const dupResp = await client.callTool({
      name: "remember",
      arguments: { projectId, title: "CI cache key uses pnpm lockfile hash", body: "Captured again in another session" }
    });
    const dupText = (dupResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(dupText).toMatch(/similar existing notes/);
    expect(dupText).toContain(firstId!);

    // Superseding skips the dedup hint and records the replacement.
    const supResp = await client.callTool({
      name: "remember",
      arguments: {
        projectId,
        title: "CI cache key now includes the Node version",
        body: "Replaces the lockfile-only cache key",
        supersedes: firstId
      }
    });
    const supText = (supResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(supText).toContain(`supersedes: ${firstId}`);
    expect(supText).not.toMatch(/similar existing notes/);
  });

  it("archives and restores projects via MCP", async () => {
    const createResp = await client.callTool({
      name: "create_project",
      arguments: { key: "ARCM", name: "Archive MCP" }
    });
    const projectId = (createResp.content as Array<{ text: string }>)[0]?.text.match(
      /[0-9a-f-]{36}/
    )?.[0];
    expect(projectId).toBeTruthy();

    const archiveResp = await client.callTool({
      name: "update_project",
      arguments: { projectId, status: "archived" }
    });
    const archiveText = (archiveResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(archiveText).toContain("(archived)");

    const activeListResp = await client.callTool({ name: "list_projects", arguments: {} });
    const activeListText = (activeListResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(activeListText).not.toContain("ARCM");

    const allListResp = await client.callTool({
      name: "list_projects",
      arguments: { includeArchived: true }
    });
    const allListText = (allListResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(allListText).toContain("ARCM");
    expect(allListText).toContain("archived:");

    await client.callTool({
      name: "update_project",
      arguments: { projectId, status: "active" }
    });
    const restoredListResp = await client.callTool({ name: "list_projects", arguments: {} });
    const restoredListText =
      (restoredListResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(restoredListText).toContain("ARCM");
  });

  it("updates project status via MCP", async () => {
    const createResp = await client.callTool({
      name: "create_project",
      arguments: { key: "WAT", name: "Watching MCP", status: "planned" }
    });
    const projectId = (createResp.content as Array<{ text: string }>)[0]?.text.match(
      /[0-9a-f-]{36}/
    )?.[0];
    expect(projectId).toBeTruthy();

    const updateResp = await client.callTool({
      name: "update_project",
      arguments: { projectId, status: "watching" }
    });
    const updateText = (updateResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(updateText).toContain("watching");

    const listResp = await client.callTool({ name: "list_projects", arguments: {} });
    const listText = (listResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(listText).toContain("WAT");
    expect(listText).toContain("status: watching");

    const archiveResp = await client.callTool({
      name: "update_project",
      arguments: { projectId, status: "archived" }
    });
    const archiveText = (archiveResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(archiveText).toContain("archived");
  });

  it("opening_brief returns AGENTS.md + open tasks markdown", async () => {
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);

    // Re-use the project from prior test by re-creating (idempotent via key check)
    const createResp = await client.callTool({
      name: "create_project",
      arguments: { key: "MCP", name: "MCP Test", agentsMd: "## NEVER ship without tests" }
    });
    const text = (createResp.content as Array<{ text: string }>)[0]?.text ?? "";
    const idMatch = text.match(/[0-9a-f-]{36}/);
    const projectId = idMatch?.[0];
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    const taskResp = await client.callTool({
      name: "create_task",
      arguments: {
        projectId,
        title: "Ship botnote v0",
        body: "M1 milestones in progress",
        actorKind: "agent",
        idempotencyKey: "mcp-task-1"
      }
    });
    const taskText = (taskResp.content as Array<{ text: string }>)[0]?.text ?? "";
    const taskId = taskText.match(/id: ([0-9a-f-]{36})/)?.[1];
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);

    const briefResp = await client.callTool({
      name: "opening_brief",
      arguments: { projectId }
    });
    const briefText = (briefResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(briefText).toMatch(/# Project: MCP/);
    expect(briefText).toMatch(/AGENTS.md/);
    expect(briefText).toMatch(/NEVER ship without tests/);
    expect(briefText).toMatch(/Ship botnote v0/);
    expect(briefText).toMatch(/\[MCP-\d+\] Ship botnote v0/);
    expect(briefText).toMatch(/MCP-\d+ · Ship botnote v0/);
  });

  it("write is idempotent on idempotencyKey via MCP", async () => {
    const createResp = await client.callTool({
      name: "create_project",
      arguments: { key: "IDP2", name: "Idempotency MCP" }
    });
    const projectId = (createResp.content as Array<{ text: string }>)[0]?.text.match(
      /[0-9a-f-]{36}/
    )?.[0];
    expect(projectId).toBeTruthy();

    const first = await client.callTool({
      name: "remember",
      arguments: {
        projectId,
        title: "Once",
        body: "first",
        actorKind: "agent",
        idempotencyKey: "mcp-note-1"
      }
    });
    const firstId = (first.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];

    const second = await client.callTool({
      name: "remember",
      arguments: {
        projectId,
        title: "Different title",
        body: "different",
        actorKind: "agent",
        idempotencyKey: "mcp-note-1"
      }
    });
    const secondText = (second.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(secondText).toContain(firstId!);
  });

  it("configures and advances recurrence via MCP", async () => {
    const createResp = await client.callTool({
      name: "create_project",
      arguments: { key: "RMC", name: "Recurrence MCP" }
    });
    const projectId = (createResp.content as Array<{ text: string }>)[0]?.text.match(
      /[0-9a-f-]{36}/
    )?.[0];
    expect(projectId).toBeTruthy();

    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    dueAt.setUTCHours(12, 0, 0, 0);
    const taskResp = await client.callTool({
      name: "create_task",
      arguments: {
        projectId,
        title: "Review recurring MCP task",
        actorKind: "agent",
        dueAt: dueAt.toISOString(),
        idempotencyKey: "mcp-recurring-task-1"
      }
    });
    const taskId = (taskResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    expect(taskId).toBeTruthy();

    const configureResp = await client.callTool({
      name: "configure_recurrence",
      arguments: {
        taskId,
        preset: "daily",
        interval: 1,
        anchor: "scheduled",
        timezone: "UTC",
        allDay: true
      }
    });
    const configureText = (configureResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(configureText).toMatch(/configured recurrence/);

    await client.callTool({
      name: "update_entity",
      arguments: {
        id: taskId,
        status: "done"
      }
    });

    const recurrenceResp = await client.callTool({
      name: "get_recurrence",
      arguments: { taskId }
    });
    const recurrence = JSON.parse(
      (recurrenceResp.content as Array<{ text: string }>)[0]?.text ?? "{}"
    ) as { currentOccurrence?: { id?: string; dueAt?: string } };
    expect(recurrence.currentOccurrence?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(recurrence.currentOccurrence?.id).not.toBe(taskId);
    expect(recurrence.currentOccurrence?.dueAt).toBe(
      new Date(dueAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
    );
  });

  it("splits a recurrence series via MCP", async () => {
    const createResp = await client.callTool({
      name: "create_project",
      arguments: { key: "SMC", name: "Split MCP" }
    });
    const projectId = (createResp.content as Array<{ text: string }>)[0]?.text.match(
      /[0-9a-f-]{36}/
    )?.[0];

    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    dueAt.setUTCHours(12, 0, 0, 0);
    const taskResp = await client.callTool({
      name: "create_task",
      arguments: {
        projectId,
        title: "Splittable MCP task",
        actorKind: "agent",
        dueAt: dueAt.toISOString(),
        idempotencyKey: "mcp-split-task-1"
      }
    });
    const taskId = (taskResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];

    await client.callTool({
      name: "configure_recurrence",
      arguments: { taskId, preset: "daily", interval: 1, anchor: "scheduled", timezone: "UTC", allDay: true }
    });

    const beforeResp = await client.callTool({ name: "get_recurrence", arguments: { taskId } });
    const before = JSON.parse(
      (beforeResp.content as Array<{ text: string }>)[0]?.text ?? "{}"
    ) as { rule: { id: string; seriesId: string } };
    const ruleId = before.rule.id;
    expect(ruleId).toMatch(/^[0-9a-f-]{36}$/);

    const splitResp = await client.callTool({
      name: "split_recurrence",
      arguments: { ruleId, preset: "weekly", interval: 1 }
    });
    const splitText = (splitResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(splitText).toMatch(/split into recurrence/);
    expect(splitText).toContain("FREQ=WEEKLY");
    const newRuleId = splitText.match(/split into recurrence ([0-9a-f-]{36})/)?.[1];
    expect(newRuleId).toBeTruthy();
    expect(newRuleId).not.toBe(ruleId);

    // The original occurrence still routes to the frozen old rule (same series).
    const afterResp = await client.callTool({ name: "get_recurrence", arguments: { taskId } });
    const after = JSON.parse(
      (afterResp.content as Array<{ text: string }>)[0]?.text ?? "{}"
    ) as { rule: { id: string; seriesId: string; enabled: boolean; rrule: string } };
    expect(after.rule.id).toBe(ruleId);
    expect(after.rule.seriesId).toBe(before.rule.seriesId);
    expect(after.rule.enabled).toBe(false);
    expect(after.rule.rrule).toContain("UNTIL=");
  });

  it("reads workspace_overview resource", async () => {
    const result = await client.readResource({ uri: "botnote://workspace" });
    const contents = result.contents as Array<{ text: string }>;
    expect(contents[0]?.text).toMatch(/# botnote workspace/);
    expect(contents[0]?.text).toMatch(/## Projects/);
  });

  it("strips bodyVec and bodyTsv from all entity-returning tools", async () => {
    // Set up a project and entity to exercise every entity-returning tool.
    const cpResp = await client.callTool({
      name: "create_project",
      arguments: { key: "STRIP", name: "Strip Fields Test" }
    });
    const cpText = (cpResp.content as Array<{ text: string }>)[0]?.text ?? "";
    const projectId = cpText.match(/id: ([0-9a-f-]{36})/)?.[1];
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    const dueAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    dueAt.setUTCHours(12, 0, 0, 0);

    // create_task — text format, just check the text response
    const taskResp = await client.callTool({
      name: "create_task",
      arguments: {
        projectId,
        title: "Strip test task",
        body: "checking that embedding fields are stripped from responses",
        actorKind: "agent",
        dueAt: dueAt.toISOString(),
        idempotencyKey: "strip-task-1"
      }
    });
    const taskText = (taskResp.content as Array<{ text: string }>)[0]?.text ?? "";
    const taskId = taskText.match(/id: ([0-9a-f-]{36})/)?.[1];
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
    assertNoInternalFields(taskText, "create_task");

    // remember — text format
    const noteResp = await client.callTool({
      name: "remember",
      arguments: {
        projectId,
        title: "Strip test note",
        body: "also checking that tsvector fields are absent from responses",
        actorKind: "agent",
        idempotencyKey: "strip-note-1"
      }
    });
    const noteText = (noteResp.content as Array<{ text: string }>)[0]?.text ?? "";
    const noteId = noteText.match(/id: ([0-9a-f-]{36})/)?.[1];
    assertNoInternalFields(noteText, "remember");

    // get_entity — JSON format (main risk)
    const getResp = await client.callTool({ name: "get_entity", arguments: { id: taskId! } });
    const getEntityText = (getResp.content as Array<{ text: string }>)[0]?.text ?? "";
    assertNoInternalFields(getEntityText, "get_entity");

    // get_entity_by_key — JSON format
    const getByKeyResp = await client.callTool({
      name: "get_entity_by_key",
      arguments: { projectKey: "STRIP", sequenceId: 1 }
    });
    const getByKeyText = (getByKeyResp.content as Array<{ text: string }>)[0]?.text ?? "";
    assertNoInternalFields(getByKeyText, "get_entity_by_key");

    // update_entity — text format
    const updateResp = await client.callTool({
      name: "update_entity",
      arguments: { id: taskId!, body: "updated body text" }
    });
    const updateText = (updateResp.content as Array<{ text: string }>)[0]?.text ?? "";
    assertNoInternalFields(updateText, "update_entity");

    // related — text format (list of summarized entities)
    const relatedResp = await client.callTool({
      name: "related",
      arguments: { id: projectId! }
    });
    const relatedText = (relatedResp.content as Array<{ text: string }>)[0]?.text ?? "";
    assertNoInternalFields(relatedText, "related");

    // recent — text format
    const recentResp = await client.callTool({
      name: "recent",
      arguments: { projectId, limit: 5 }
    });
    const recentText = (recentResp.content as Array<{ text: string }>)[0]?.text ?? "";
    assertNoInternalFields(recentText, "recent");

    // search — text format
    const searchResp = await client.callTool({
      name: "search",
      arguments: { query: "strip test", projectId, limit: 5 }
    });
    const searchText = (searchResp.content as Array<{ text: string }>)[0]?.text ?? "";
    assertNoInternalFields(searchText, "search");

    // configure_recurrence + get_recurrence — JSON format for get_recurrence
    const configResp = await client.callTool({
      name: "configure_recurrence",
      arguments: {
        taskId: taskId!,
        preset: "daily",
        interval: 1,
        anchor: "scheduled",
        timezone: "UTC",
        allDay: true
      }
    });
    const configText = (configResp.content as Array<{ text: string }>)[0]?.text ?? "";
    assertNoInternalFields(configText, "configure_recurrence");

    const recurrenceResp = await client.callTool({
      name: "get_recurrence",
      arguments: { taskId: taskId! }
    });
    const recurrenceText = (recurrenceResp.content as Array<{ text: string }>)[0]?.text ?? "";
    assertNoInternalFields(recurrenceText, "get_recurrence (JSON with currentOccurrence)");

    // opening_brief — markdown format
    const briefResp = await client.callTool({
      name: "opening_brief",
      arguments: { projectId }
    });
    const briefText = (briefResp.content as Array<{ text: string }>)[0]?.text ?? "";
    assertNoInternalFields(briefText, "opening_brief");

    // skip_occurrence — text format with two entity summaries
    await client.callTool({
      name: "update_entity",
      arguments: { id: taskId!, status: "done" }
    });
    const skipResp = await client.callTool({
      name: "skip_occurrence",
      arguments: { taskId: taskId! }
    });
    const skipText = (skipResp.content as Array<{ text: string }>)[0]?.text ?? "";
    assertNoInternalFields(skipText, "skip_occurrence");
  });

  it("list_tasks returns overdue / scheduled / backlog buckets", async () => {
    const cpResp = await client.callTool({
      name: "create_project",
      arguments: { key: "LTT", name: "List Tasks Test" }
    });
    const cpText = (cpResp.content as Array<{ text: string }>)[0]?.text ?? "";
    const projectId = cpText.match(/id: ([0-9a-f-]{36})/)?.[1];
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    // Backlog (no due date)
    await client.callTool({
      name: "create_task",
      arguments: { projectId, title: "Backlog task", actorKind: "agent" }
    });

    // Overdue (due in the past)
    await client.callTool({
      name: "create_task",
      arguments: {
        projectId,
        title: "Overdue task",
        actorKind: "agent",
        dueAt: "2020-01-01T12:00:00.000Z"
      }
    });

    // Scheduled (due in the future)
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    tomorrow.setUTCHours(12, 0, 0, 0);
    await client.callTool({
      name: "create_task",
      arguments: {
        projectId,
        title: "Scheduled task",
        actorKind: "agent",
        dueAt: tomorrow.toISOString()
      }
    });

    // Query with a future window so the scheduled task lands in it
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

    const listResp = await client.callTool({
      name: "list_tasks",
      arguments: { projectId, from, to, includeBacklog: true, includeDone: false }
    });
    const listText = (listResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(listText).toContain("## Overdue");
    expect(listText).toContain("Overdue task");
    expect(listText).toContain("## Scheduled");
    expect(listText).toContain("Scheduled task");
    expect(listText).toContain("## Backlog");
    expect(listText).toContain("Backlog task");
    assertNoInternalFields(listText, "list_tasks");
  });

  it("list_tasks marks tasks whose blocker is still open", async () => {
    const cpResp = await client.callTool({
      name: "create_project",
      arguments: { key: "LTB", name: "List Tasks Blocked" }
    });
    const projectId = (cpResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    const idOf = (resp: Awaited<ReturnType<typeof client.callTool>>) =>
      (resp.content as Array<{ text: string }>)[0]?.text.match(/id: ([0-9a-f-]{36})/)?.[1];
    const blockerId = idOf(
      await client.callTool({
        name: "create_task",
        arguments: { projectId, title: "Blocker task", actorKind: "agent" }
      })
    );
    const blockedId = idOf(
      await client.callTool({
        name: "create_task",
        arguments: { projectId, title: "Blocked task", actorKind: "agent" }
      })
    );
    await client.callTool({
      name: "link",
      arguments: { fromId: blockerId, toId: blockedId, kind: "blocks" }
    });

    const listResp = await client.callTool({
      name: "list_tasks",
      arguments: { projectId, includeBacklog: true, includeDone: false }
    });
    const text = (listResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toMatch(/LTB-2 · Blocked task \(open, BLOCKED by LTB-1\)/);
    expect(text).toMatch(/LTB-1 · Blocker task \(open\)/);
    assertNoInternalFields(text, "list_tasks blocked");
  });

  it("list_tasks returns 'no tasks' when empty", async () => {
    const cpResp = await client.callTool({
      name: "create_project",
      arguments: { key: "LTE", name: "List Tasks Empty" }
    });
    const projectId = (cpResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    const from = "2099-01-01T00:00:00.000Z";
    const to = "2099-01-02T00:00:00.000Z";
    const listResp = await client.callTool({
      name: "list_tasks",
      arguments: { projectId, from, to, includeBacklog: false }
    });
    const listText = (listResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(listText).toBe("no tasks");
  });

  it("list_tags returns tag counts and is scoped by projectId", async () => {
    const cpResp = await client.callTool({
      name: "create_project",
      arguments: { key: "LTAG", name: "List Tags Test" }
    });
    const projectId = (cpResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    await client.callTool({
      name: "create_task",
      arguments: { projectId, title: "Tagged task 1", tags: ["alpha", "beta"], actorKind: "agent" }
    });
    await client.callTool({
      name: "create_task",
      arguments: { projectId, title: "Tagged task 2", tags: ["alpha", "gamma"], actorKind: "agent" }
    });

    const tagsResp = await client.callTool({
      name: "list_tags",
      arguments: { projectId }
    });
    const tagsText = (tagsResp.content as Array<{ text: string }>)[0]?.text ?? "";
    // alpha appears twice, so it should be first
    expect(tagsText).toContain("alpha (2)");
    expect(tagsText).toContain("beta (1)");
    expect(tagsText).toContain("gamma (1)");
    // alpha (2) should appear before beta (1) and gamma (1)
    expect(tagsText.indexOf("alpha")).toBeLessThan(tagsText.indexOf("beta"));
  });

  it("list_tags returns 'no tags' when empty", async () => {
    const cpResp = await client.callTool({
      name: "create_project",
      arguments: { key: "LTGE", name: "List Tags Empty" }
    });
    const projectId = (cpResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    const tagsResp = await client.callTool({
      name: "list_tags",
      arguments: { projectId }
    });
    const tagsText = (tagsResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(tagsText).toBe("no tags");
  });

  it("get_links returns typed edges by direction and kind", async () => {
    const cpResp = await client.callTool({
      name: "create_project",
      arguments: { key: "GLK", name: "Get Links Test" }
    });
    const projectId = (cpResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    const taskAResp = await client.callTool({
      name: "create_task",
      arguments: { projectId, title: "Task A (blocker)", actorKind: "agent" }
    });
    const taskAId = (taskAResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    expect(taskAId).toMatch(/^[0-9a-f-]{36}$/);

    const taskBResp = await client.callTool({
      name: "create_task",
      arguments: { projectId, title: "Task B (blocked)", actorKind: "agent" }
    });
    const taskBId = (taskBResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    expect(taskBId).toMatch(/^[0-9a-f-]{36}$/);

    // Link A -[blocks]-> B
    await client.callTool({
      name: "link",
      arguments: { fromId: taskAId, toId: taskBId, kind: "blocks" }
    });

    // get_links on A (outgoing) should return B
    const outResp = await client.callTool({
      name: "get_links",
      arguments: { id: taskAId, direction: "outgoing" }
    });
    const outText = (outResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(outText).toContain("blocks ▸ outgoing");
    expect(outText).toContain("Task B");
    assertNoInternalFields(outText, "get_links outgoing");

    // get_links on B (incoming) should return A
    const inResp = await client.callTool({
      name: "get_links",
      arguments: { id: taskBId, direction: "incoming" }
    });
    const inText = (inResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(inText).toContain("blocks ▸ incoming");
    expect(inText).toContain("Task A");

    // get_links on B with kind=references should return "no links"
    const noResp = await client.callTool({
      name: "get_links",
      arguments: { id: taskBId, direction: "outgoing", kind: "references" }
    });
    const noText = (noResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(noText).toBe("no links");
  });

  it("resolves KEY-SEQ refs in update_entity and link", async () => {
    const cpResp = await client.callTool({
      name: "create_project",
      arguments: { key: "KSEQ", name: "Key-seq Resolution Test" }
    });
    const cpText = (cpResp.content as Array<{ text: string }>)[0]?.text ?? "";
    const projectId = cpText.match(/id: ([0-9a-f-]{36})/)?.[1];
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    // Create two tasks; they will get sequenceId 1 and 2 in project KSEQ
    const t1Resp = await client.callTool({
      name: "create_task",
      arguments: { projectId, title: "Key-seq task alpha", actorKind: "agent" }
    });
    const t1Id = (t1Resp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    expect(t1Id).toMatch(/^[0-9a-f-]{36}$/);

    const t2Resp = await client.callTool({
      name: "create_task",
      arguments: { projectId, title: "Key-seq task beta", actorKind: "agent" }
    });
    const t2Id = (t2Resp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    expect(t2Id).toMatch(/^[0-9a-f-]{36}$/);

    // Resolve the sequence IDs assigned to the two tasks
    const seq1Resp = await client.callTool({
      name: "get_entity",
      arguments: { id: t1Id! }
    });
    const seq1Json = JSON.parse(
      (seq1Resp.content as Array<{ text: string }>)[0]?.text ?? "{}"
    ) as { sequenceId: number };
    const seq1 = seq1Json.sequenceId;
    expect(seq1).toBeGreaterThan(0);

    const seq2Resp = await client.callTool({
      name: "get_entity",
      arguments: { id: t2Id! }
    });
    const seq2Json = JSON.parse(
      (seq2Resp.content as Array<{ text: string }>)[0]?.text ?? "{}"
    ) as { sequenceId: number };
    const seq2 = seq2Json.sequenceId;

    // update_entity using KEY-SEQ ref
    const keySeq1 = `KSEQ-${seq1}`;
    const updateResp = await client.callTool({
      name: "update_entity",
      arguments: { id: keySeq1, title: "Key-seq task alpha (updated via KEY-SEQ)" }
    });
    const updateText = (updateResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(updateText).toContain("alpha (updated via KEY-SEQ)");

    // link using KEY-SEQ refs for both fromId and toId
    const keySeq2 = `KSEQ-${seq2}`;
    const linkResp = await client.callTool({
      name: "link",
      arguments: { fromId: keySeq1, toId: keySeq2, kind: "blocks" }
    });
    const linkText = (linkResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(linkText).toMatch(/linked .+ -\[blocks\]-> .+/);

    // Confirm the link resolves via get_links with the UUID
    const linksResp = await client.callTool({
      name: "get_links",
      arguments: { id: t1Id!, direction: "outgoing" }
    });
    const linksText = (linksResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(linksText).toContain("blocks ▸ outgoing");
    expect(linksText).toContain("beta");
  });

  it("update_entity bodyAppend appends atomically", async () => {
    const cpResp = await client.callTool({
      name: "create_project",
      arguments: { key: "BAPP", name: "BodyAppend Test" }
    });
    const projectId = (cpResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    // Create a task with initial body
    const taskResp = await client.callTool({
      name: "create_task",
      arguments: { projectId, title: "Append test task", body: "initial content", actorKind: "agent" }
    });
    const taskId = (taskResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);

    // Append to non-empty body — should separate with blank line
    await client.callTool({
      name: "update_entity",
      arguments: { id: taskId!, bodyAppend: "appended text" }
    });

    const afterAppend = await client.callTool({
      name: "get_entity",
      arguments: { id: taskId! }
    });
    const afterJson = JSON.parse(
      (afterAppend.content as Array<{ text: string }>)[0]?.text ?? "{}"
    ) as { body: string };
    expect(afterJson.body).toBe("initial content\n\nappended text");

    // Append to empty body — should NOT prepend blank line
    const emptyTaskResp = await client.callTool({
      name: "create_task",
      arguments: { projectId, title: "Empty body task", body: "", actorKind: "agent" }
    });
    const emptyTaskId = (emptyTaskResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    await client.callTool({
      name: "update_entity",
      arguments: { id: emptyTaskId!, bodyAppend: "first append" }
    });
    const emptyAfter = await client.callTool({
      name: "get_entity",
      arguments: { id: emptyTaskId! }
    });
    const emptyJson = JSON.parse(
      (emptyAfter.content as Array<{ text: string }>)[0]?.text ?? "{}"
    ) as { body: string };
    expect(emptyJson.body).toBe("first append");
  });

  it("summarizeEntity includes status and due date for tasks", async () => {
    const cpResp = await client.callTool({
      name: "create_project",
      arguments: { key: "SUMM", name: "Summarize Test" }
    });
    const projectId = (cpResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    // Create a task with dueAt and priority
    const dueAt = "2099-12-25T12:00:00.000Z";
    const taskResp = await client.callTool({
      name: "create_task",
      arguments: {
        projectId,
        title: "Summarize test task",
        actorKind: "agent",
        dueAt,
        priority: "high",
        status: "open"
      }
    });
    const taskId = (taskResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);

    // recent should include status, priority, and due date in the summary
    const recentResp = await client.callTool({
      name: "recent",
      arguments: { projectId, limit: 5 }
    });
    const recentText = (recentResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(recentText).toContain("open");
    expect(recentText).toContain("high");
    expect(recentText).toContain("due 2099-12-25");

    // list_tasks also uses summarizeEntity
    const listResp = await client.callTool({
      name: "list_tasks",
      arguments: {
        projectId,
        from: new Date().toISOString(),
        to: "2100-01-01T00:00:00.000Z",
        includeBacklog: false
      }
    });
    const listText = (listResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(listText).toContain("open");
    expect(listText).toContain("high");
    expect(listText).toContain("due 2099-12-25");

    // Mark task done and verify completedAt shows instead of dueAt
    await client.callTool({
      name: "update_entity",
      arguments: { id: taskId!, status: "done" }
    });
    const doneResp = await client.callTool({
      name: "recent",
      arguments: { projectId, limit: 5 }
    });
    const doneText = (doneResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(doneText).toContain("done");
    // completedAt should be today's date
    const todayPrefix = new Date().toISOString().slice(0, 10);
    expect(doneText).toContain(`done ${todayPrefix}`);
  });

  it("update_entity with non-existent id returns structured isError", async () => {
    const resp = await client.callTool({
      name: "update_entity",
      arguments: { id: "00000000-0000-0000-0000-000000000000", title: "will fail" }
    });
    // Should return isError true rather than throwing an unhandled exception
    expect(resp.isError).toBe(true);
    const text = (resp.content as Array<{ text: string }>)[0]?.text ?? "";
    // The REST backend throws an unhandled error resulting in HTTP 500; the
    // MCP layer must still catch it and return a structured error (not throw).
    expect(text).toBeTruthy();
    expect(text.length).toBeGreaterThan(0);
  });

  it("context tool returns now, timezone, version, and projects", async () => {
    const resp = await client.callTool({ name: "context", arguments: {} });
    expect(resp.isError).toBeFalsy();
    const text = (resp.content as Array<{ text: string }>)[0]?.text ?? "";
    // now: should be an ISO datetime
    expect(text).toMatch(/^now: \d{4}-\d{2}-\d{2}T/m);
    // timezone: should be present
    expect(text).toMatch(/^timezone: /m);
    // version: should be present
    expect(text).toMatch(/^version: /m);
    // projects: header present
    expect(text).toContain("projects:");
  });

  it("opening_brief includes server time and timezone line", async () => {
    const cpResp = await client.callTool({
      name: "create_project",
      arguments: { key: "OBRTZ", name: "Opening Brief TZ Test" }
    });
    const projectId = (cpResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    const briefResp = await client.callTool({
      name: "opening_brief",
      arguments: { projectId }
    });
    const briefText = (briefResp.content as Array<{ text: string }>)[0]?.text ?? "";
    // Should contain Server time with ISO datetime
    expect(briefText).toMatch(/Server time: \d{4}-\d{2}-\d{2}T/);
    // Should contain timezone label
    expect(briefText).toMatch(/timezone: /);
  });

  it("update_entities batch tool applies partial success", async () => {
    const cpResp = await client.callTool({
      name: "create_project",
      arguments: { key: "BTCH", name: "Batch Update Test" }
    });
    const projectId = (cpResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    const t1 = await client.callTool({
      name: "create_task",
      arguments: { projectId, title: "Batch task 1", actorKind: "agent" }
    });
    const t1Id = (t1.content as Array<{ text: string }>)[0]?.text.match(/id: ([0-9a-f-]{36})/)?.[1];

    const t2 = await client.callTool({
      name: "create_task",
      arguments: { projectId, title: "Batch task 2", actorKind: "agent" }
    });
    const t2Id = (t2.content as Array<{ text: string }>)[0]?.text.match(/id: ([0-9a-f-]{36})/)?.[1];

    expect(t1Id).toMatch(/^[0-9a-f-]{36}$/);
    expect(t2Id).toMatch(/^[0-9a-f-]{36}$/);

    // Batch update: two valid + one bad id
    const batchResp = await client.callTool({
      name: "update_entities",
      arguments: {
        items: [
          { id: t1Id!, status: "done" },
          { id: t2Id!, title: "Batch task 2 (updated)" },
          { id: "00000000-0000-0000-0000-000000000000", status: "done" }
        ]
      }
    });
    const batchText = (batchResp.content as Array<{ text: string }>)[0]?.text ?? "";

    // Two successes, one failure
    expect(batchText).toContain("2 ok, 1 failed");
    expect(batchText).toMatch(/✓ .+Batch task 1/);
    expect(batchText).toMatch(/✓ .+Batch task 2 \(updated\)/);
    expect(batchText).toMatch(/✗ 00000000-0000-0000-0000-000000000000:/);

    // Verify the good ones were actually updated
    const check1 = await client.callTool({ name: "get_entity", arguments: { id: t1Id! } });
    const json1 = JSON.parse((check1.content as Array<{ text: string }>)[0]?.text ?? "{}") as { status: string };
    expect(json1.status).toBe("done");

    const check2 = await client.callTool({ name: "get_entity", arguments: { id: t2Id! } });
    const json2 = JSON.parse((check2.content as Array<{ text: string }>)[0]?.text ?? "{}") as { title: string };
    expect(json2.title).toBe("Batch task 2 (updated)");
  });

  it("get_entity_by_key accepts a whole KEY-SEQ identifier, and worklog tools accept id aliases", async () => {
    const cpResp = await client.callTool({
      name: "create_project",
      arguments: { key: "ALIAS", name: "Identifier Tolerance Test" }
    });
    const projectId = (cpResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];

    const taskResp = await client.callTool({
      name: "create_task",
      arguments: { projectId, title: "Tolerate every identifier spelling", actorKind: "agent" }
    });
    const taskId = (taskResp.content as Array<{ text: string }>)[0]?.text.match(
      /id: ([0-9a-f-]{36})/
    )?.[1];
    const seqJson = JSON.parse(
      ((await client.callTool({ name: "get_entity", arguments: { id: taskId! } }))
        .content as Array<{ text: string }>)[0]?.text ?? "{}"
    ) as { sequenceId: number };
    const key = `ALIAS-${seqJson.sequenceId}`;

    // All three spellings of the identifier reach the same entity.
    for (const args of [
      { key },
      { key: key.toLowerCase() },
      { id: key },
      { projectKey: "ALIAS", sequenceId: seqJson.sequenceId },
      { projectKey: key }
    ]) {
      const resp = await client.callTool({ name: "get_entity_by_key", arguments: args });
      const json = JSON.parse((resp.content as Array<{ text: string }>)[0]?.text ?? "{}") as {
        id: string;
      };
      expect(json.id, `get_entity_by_key ${JSON.stringify(args)}`).toBe(taskId);
    }

    // Worklog tools take id, entityId, or parentId.
    const viaParentId = await client.callTool({
      name: "add_worklog",
      arguments: { parentId: key, body: "filed via parentId", actorKind: "agent" }
    });
    expect(viaParentId.isError).toBeFalsy();
    const viaEntityId = await client.callTool({
      name: "add_worklog",
      arguments: { entityId: taskId!, body: "filed via entityId", actorKind: "agent" }
    });
    expect(viaEntityId.isError).toBeFalsy();

    const listResp = await client.callTool({
      name: "list_worklog",
      arguments: { entityId: key }
    });
    const listText = (listResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(listText).toContain("filed via parentId");
    expect(listText).toContain("filed via entityId");

    // No reference at all is still an error, and it names the accepted spellings.
    const missingResp = await client.callTool({
      name: "add_worklog",
      arguments: { body: "nowhere to go", actorKind: "agent" }
    });
    expect(missingResp.isError).toBe(true);
    expect((missingResp.content as Array<{ text: string }>)[0]?.text).toContain("entityId");
  });

  it("REST answers 409 when writing to a trashed entity and still serves it on GET", async () => {
    const project = await fetch(`${baseUrl}/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "RTRS", name: "REST trash" })
    }).then((r) => r.json() as Promise<{ id: string }>);
    const task = await fetch(`${baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, title: "trash me" })
    }).then((r) => r.json() as Promise<{ id: string }>);
    expect((await fetch(`${baseUrl}/v1/entities/${task.id}`, { method: "DELETE" })).status).toBeLessThan(300);

    const got = await fetch(`${baseUrl}/v1/entities/${task.id}`);
    expect(got.status).toBe(200);
    expect(((await got.json()) as { deletedAt: string | null }).deletedAt).not.toBeNull();

    const patched = await fetch(`${baseUrl}/v1/entities/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" })
    });
    expect(patched.status).toBe(409);
    expect(((await patched.json()) as { message: string }).message).toContain("restore first");

    const logged = await fetch(`${baseUrl}/v1/entities/${task.id}/worklog`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "nope", actorKind: "agent" })
    });
    expect(logged.status).toBe(409);
  });

  it("REST still serves the pre-0.2.16 /comments path, latestComments field and comment kind", async () => {
    const post = (url: string, body: unknown) =>
      fetch(`${baseUrl}${url}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    const project = (await post("/v1/projects", { key: "LEGC", name: "Legacy comments" }).then((r) =>
      r.json()
    )) as { id: string };
    const task = (await post("/v1/tasks", {
      projectId: project.id,
      title: "old plugin",
      status: "in_progress"
    }).then((r) => r.json())) as { id: string };

    const posted = await post(`/v1/entities/${task.id}/comments`, { body: "from an old plugin", actorKind: "agent" });
    expect(posted.status).toBe(200);
    expect(((await posted.json()) as { kind: string }).kind).toBe("worklog");

    const current = (await fetch(`${baseUrl}/v1/entities/${task.id}/worklog`).then((r) => r.json())) as Array<{
      body: string;
    }>;
    expect(current.map((e) => e.body)).toEqual(["from an old plugin"]);
    expect(await fetch(`${baseUrl}/v1/entities/${task.id}/comments`).then((r) => r.json())).toEqual(current);

    const brief = (await post("/v1/opening-brief", { projectId: project.id }).then((r) => r.json())) as {
      latestWorklog: Array<{ body: string }>;
      latestComments: Array<{ body: string }>;
    };
    expect(brief.latestWorklog.map((e) => e.body)).toEqual(["from an old plugin"]);
    expect(brief.latestComments).toEqual(brief.latestWorklog);

    const recent = (await post("/v1/recent", { projectId: project.id, kinds: ["comment"] }).then((r) =>
      r.json()
    )) as Array<{ kind: string }>;
    expect(recent.map((e) => e.kind)).toEqual(["worklog"]);
  });

  it("MCP client falls back to /comments only when the daemon lacks the /worklog route", async () => {
    const seen: string[] = [];
    const legacyDaemon = http.createServer((req, res) => {
      req.resume();
      seen.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/v1/entities/gone/")) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "client_error", message: "entity gone not found" }));
      } else if (req.url?.endsWith("/comments")) {
        res.end(JSON.stringify(req.method === "GET" ? [] : { id: "c0ffee00-0000-4000-8000-000000000000" }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: `Route ${req.method}:${req.url} not found`, error: "Not Found", statusCode: 404 }));
      }
    });
    await new Promise<void>((resolve) => legacyDaemon.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = legacyDaemon.address() as AddressInfo;
      const c = new BotnoteHttpClient({ baseUrl: `http://127.0.0.1:${port}` });

      expect((await c.addWorklogEntry("t1", { body: "x" })).id).toBe("c0ffee00-0000-4000-8000-000000000000");
      expect(await c.listWorklog("t1")).toEqual([]);
      await expect(c.addWorklogEntry("gone", { body: "x" })).rejects.toMatchObject({ status: 404 });
      expect(seen).toEqual([
        "POST /v1/entities/t1/worklog",
        "POST /v1/entities/t1/comments",
        "GET /v1/entities/t1/worklog",
        "GET /v1/entities/t1/comments",
        "POST /v1/entities/gone/worklog"
      ]);
    } finally {
      await new Promise((resolve) => legacyDaemon.close(resolve));
    }
  });
});
