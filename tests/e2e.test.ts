import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/rest/server.js";
import { EmbeddingService } from "../src/service/embedding.js";
import { createTestDb } from "./test_db.js";

const ROOT = path.resolve(import.meta.dirname, "..");

const { db, pool } = createTestDb();
const embedding = new EmbeddingService(db);

let server: FastifyInstance;
let baseUrl: string;
let mcpClient: Client;
let mcpTransport: StdioClientTransport;

beforeAll(async () => {
  await db.execute(sql`
    TRUNCATE recurrence_exceptions, recurrence_rules, entities, edges, projects, tokens, sessions
    RESTART IDENTITY CASCADE
  `);

  server = await buildServer({ db, embedding, logLevel: "warn" });
  await server.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.server.address();
  if (typeof addr === "object" && addr !== null) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  } else {
    throw new Error("could not derive REST baseUrl");
  }

  mcpTransport = new StdioClientTransport({
    command: "node",
    args: ["--import", "tsx", path.join(ROOT, "packages/cli/src/bin.ts"), "mcp"],
    env: { ...process.env, BOTNOTE_URL: baseUrl, NODE_OPTIONS: "--no-warnings" }
  });
  mcpClient = new Client({ name: "e2e-test", version: "0.0.1" });
  await mcpClient.connect(mcpTransport);
}, 30000);

afterAll(async () => {
  await mcpClient?.close();
  await server?.close();
  await pool.end();
}, 15000);

describe("botnote E2E cross-transport", () => {
  it("REST write -> MCP read sees the same data", async () => {
    const projectResp = await fetch(`${baseUrl}/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "E2E",
        name: "Cross-transport",
        agentsMd: "ALWAYS write idempotency_key"
      })
    });
    expect(projectResp.ok).toBe(true);
    const project = (await projectResp.json()) as { id: string };

    await fetch(`${baseUrl}/v1/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        title: "Use Reciprocal Rank Fusion for hybrid retrieval",
        body: "RRF with k=60 chosen to merge BM25 + cosine + time decay",
        tags: ["search", "design"],
        actorKind: "human"
      })
    });

    const briefResp = await mcpClient.callTool({
      name: "opening_brief",
      arguments: { projectId: project.id }
    });
    const briefText = (briefResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(briefText).toContain("Cross-transport");
    expect(briefText).toContain("ALWAYS write idempotency_key");
    expect(briefText).toContain("Use Reciprocal Rank Fusion");

    const searchResp = await mcpClient.callTool({
      name: "search",
      arguments: { query: "rank fusion", projectId: project.id, limit: 5 }
    });
    const searchText = (searchResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(searchText).toContain("Reciprocal Rank Fusion");
  });

  it("MCP write -> REST read sees the same data", async () => {
    const projectResp = await fetch(`${baseUrl}/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "MCP2", name: "MCP write side" })
    });
    const project = (await projectResp.json()) as { id: string };

    const writeResp = await mcpClient.callTool({
      name: "remember",
      arguments: {
        projectId: project.id,
        title: "MCP-side note about AGENTS.md",
        body: "AGENTS.md is the universal agent conventions standard.",
        tags: ["agents-md"],
        actorKind: "agent"
      }
    });
    const writeText = (writeResp.content as Array<{ text: string }>)[0]?.text ?? "";
    const idMatch = writeText.match(/id: ([0-9a-f-]{36})/);
    const entityId = idMatch?.[1];
    expect(entityId).toBeTruthy();

    const getResp = await fetch(`${baseUrl}/v1/entities/${entityId}`);
    expect(getResp.ok).toBe(true);
    const entity = (await getResp.json()) as { kind: string; title: string; tags: string[] };
    expect(entity.kind).toBe("note");
    expect(entity.title).toBe("MCP-side note about AGENTS.md");
    expect(entity.tags).toContain("agents-md");

    const searchResp = await fetch(`${baseUrl}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "AGENTS.md universal", projectId: project.id, limit: 5 })
    });
    const searchData = (await searchResp.json()) as {
      hits: Array<{ entity: { title: string } }>;
    };
    expect(searchData.hits.length).toBeGreaterThan(0);
    expect(searchData.hits[0]?.entity.title).toBe("MCP-side note about AGENTS.md");
  });

  it("AGENTS.md is reachable from MCP get_project tool", async () => {
    const projectResp = await fetch(`${baseUrl}/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "DOC",
        name: "AGENTS test",
        agentsMd: "## NEVER push to main\n## ALWAYS run pnpm test before commit"
      })
    });
    const project = (await projectResp.json()) as { id: string };

    const mdResp = await mcpClient.callTool({
      name: "get_project",
      arguments: { projectId: project.id }
    });
    const mdText = (mdResp.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(mdText).toContain("NEVER push to main");
    expect(mdText).toContain("pnpm test");
  });

  it("REST archives projects and lists archived projects only when requested", async () => {
    const projectResp = await fetch(`${baseUrl}/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "ARCE", name: "Archive E2E" })
    });
    const project = (await projectResp.json()) as { id: string };

    const legacyArchiveResp = await fetch(`${baseUrl}/v1/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true })
    });
    expect(legacyArchiveResp.status).toBe(400);

    const archiveResp = await fetch(`${baseUrl}/v1/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "archived" })
    });
    expect(archiveResp.ok).toBe(true);
    const archived = (await archiveResp.json()) as { status: string; archivedAt: string | null };
    expect(archived.status).toBe("archived");
    expect(archived.archivedAt).toBeTruthy();

    const activeList = (await (await fetch(`${baseUrl}/v1/projects`)).json()) as Array<{
      key: string;
    }>;
    expect(activeList.map((p) => p.key)).not.toContain("ARCE");

    const allList = (await (
      await fetch(`${baseUrl}/v1/projects?includeArchived=true`)
    ).json()) as Array<{ key: string; status: string; archivedAt: string | null }>;
    const archivedProject = allList.find((p) => p.key === "ARCE");
    expect(archivedProject?.status).toBe("archived");
    expect(archivedProject?.archivedAt).toBeTruthy();
  });

  it("REST creates and updates project status", async () => {
    const projectResp = await fetch(`${baseUrl}/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "W2E", name: "Watching E2E", status: "planned" })
    });
    expect(projectResp.ok).toBe(true);
    const project = (await projectResp.json()) as { id: string; status: string };
    expect(project.status).toBe("planned");

    const updateResp = await fetch(`${baseUrl}/v1/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "watching" })
    });
    expect(updateResp.ok).toBe(true);
    const updated = (await updateResp.json()) as { status: string };
    expect(updated.status).toBe("watching");

    const archiveResp = await fetch(`${baseUrl}/v1/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "archived" })
    });
    expect(archiveResp.ok).toBe(true);
    const archived = (await archiveResp.json()) as { status: string; archivedAt: string | null };
    expect(archived.status).toBe("archived");
    expect(archived.archivedAt).toBeTruthy();
  });

  it("REST recurrence completion creates the next occurrence", async () => {
    const projectResp = await fetch(`${baseUrl}/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "R2E", name: "Recurring E2E" })
    });
    const project = (await projectResp.json()) as { id: string };
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    dueAt.setUTCHours(12, 0, 0, 0);

    const taskResp = await fetch(`${baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        title: "Run recurring REST smoke",
        actorKind: "human",
        dueAt: dueAt.toISOString()
      })
    });
    expect(taskResp.ok).toBe(true);
    const task = (await taskResp.json()) as { id: string };

    const recurrenceResp = await fetch(`${baseUrl}/v1/tasks/${task.id}/recurrence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        preset: "daily",
        interval: 1,
        timezone: "UTC",
        allDay: true,
        anchor: "scheduled"
      })
    });
    expect(recurrenceResp.ok).toBe(true);

    const completeResp = await fetch(`${baseUrl}/v1/entities/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" })
    });
    expect(completeResp.ok).toBe(true);

    const detailsResp = await fetch(`${baseUrl}/v1/tasks/${task.id}/recurrence`);
    expect(detailsResp.ok).toBe(true);
    const details = (await detailsResp.json()) as {
      currentOccurrence: { id: string; dueAt: string } | null;
    };
    expect(details.currentOccurrence?.id).not.toBe(task.id);
    expect(details.currentOccurrence?.dueAt).toBe(
      new Date(dueAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
    );
  });

  it("workspace_overview resource lists non-archived projects E2E", async () => {
    const result = await mcpClient.readResource({ uri: "botnote://workspace" });
    const contents = result.contents as Array<{ text: string }>;
    const text = contents[0]?.text ?? "";
    expect(text).toContain("# botnote workspace");
    expect(text).toContain("E2E");
    expect(text).toContain("MCP2");
    expect(text).toContain("DOC");
    expect(text).not.toContain("ARCE");
    expect(text).not.toContain("W2E");
  });

  it("token lifecycle creates, lists, and revokes recoverable tokens", async () => {
    const createResp = await fetch(`${baseUrl}/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "e2e-client" })
    });
    expect(createResp.ok).toBe(true);
    const created = (await createResp.json()) as {
      id: string;
      name: string;
      prefix: string;
      plaintext: string;
    };
    expect(created.plaintext).toMatch(/^bn_[0-9a-f]{48}$/);
    expect(created.prefix).toBe(created.plaintext.slice(0, 11));

    const listResp = await fetch(`${baseUrl}/v1/tokens`);
    const tokens = (await listResp.json()) as Array<{ id: string; plaintext: string | null }>;
    expect(tokens.find((t) => t.id === created.id)?.plaintext).toBe(created.plaintext);

    const deleteResp = await fetch(`${baseUrl}/v1/tokens/${created.id}`, { method: "DELETE" });
    expect(deleteResp.status).toBe(204);

    const afterResp = await fetch(`${baseUrl}/v1/tokens`);
    const after = (await afterResp.json()) as Array<{ id: string }>;
    expect(after.some((t) => t.id === created.id)).toBe(false);
  });
});
