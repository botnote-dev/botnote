import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/rest/server.js";
import { EmbeddingService } from "../src/service/embedding.js";
import { createTestDb } from "./test_db.js";

const { db, pool } = createTestDb();
const embedding = new EmbeddingService(db);

let server: FastifyInstance;
let client: Client;

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");
}

beforeAll(async () => {
  await db.execute(sql`
    TRUNCATE recurrence_exceptions, recurrence_rules, entities, edges, projects, tokens, sessions
    RESTART IDENTITY CASCADE
  `);
  server = await buildServer({ db, embedding, logLevel: "warn" });
  await server.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("could not derive daemon address");

  client = new Client({ name: "botnote-http-test", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/mcp`))
  );
}, 30000);

afterAll(async () => {
  await client?.close();
  await server?.close();
  await pool.end();
}, 10000);

describe("MCP over Streamable HTTP served by the daemon", () => {
  it("hands out the server instructions and the full tool surface", async () => {
    expect(client.getInstructions()).toContain("botnote is the user's task + memory system");
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of ["opening_brief", "create_task", "update_entity", "search", "remember"]) {
      expect(names).toContain(expected);
    }
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBeTypeOf("boolean");
    }
  });

  it("creates, reads back and updates a task through the REST service layer", async () => {
    const project = await client.callTool({
      name: "create_project",
      arguments: { key: "HTTP", name: "http transport" }
    });
    expect(project.isError).toBeFalsy();

    const projects = await server.inject({ method: "GET", url: "/v1/projects" });
    const projectId = (projects.json() as Array<{ id: string; key: string }>).find(
      (p) => p.key === "HTTP"
    )!.id;

    const created = await client.callTool({
      name: "create_task",
      arguments: { title: "Ship remote MCP", projectId, idempotencyKey: "http-mcp-create" }
    });
    expect(textOf(created)).toContain("HTTP-1");

    const again = await client.callTool({
      name: "create_task",
      arguments: { title: "Ship remote MCP", projectId, idempotencyKey: "http-mcp-create" }
    });
    expect(textOf(again)).toContain("HTTP-1");

    const updated = await client.callTool({
      name: "update_entity",
      arguments: { id: "HTTP-1", status: "done" }
    });
    expect(updated.isError).toBeFalsy();

    const viaRest = await server.inject({ method: "GET", url: "/v1/projects/by-key/HTTP/entities/by-seq/1" });
    expect(viaRest.json()).toMatchObject({ title: "Ship remote MCP", status: "done" });
  });

  it("serves the opening brief resource", async () => {
    const { resources } = await client.listResources();
    expect(resources.length).toBeGreaterThan(0);
    const read = await client.readResource({ uri: resources[0]!.uri });
    expect(read.contents.length).toBeGreaterThan(0);
  });
});
