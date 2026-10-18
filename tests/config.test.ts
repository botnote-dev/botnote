import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import {
  BotnoteUnreachableError,
  DEFAULT_BASE_URL,
  DEFAULT_PORT,
  envValue,
  resolveBaseUrl,
  unreachableHint
} from "../packages/cli/src/config.js";
import { BotnoteHttpClient } from "../packages/cli/src/mcp/http-client.js";
import { corsOrigins, DEFAULT_PORT as SERVER_DEFAULT_PORT } from "../src/config.js";

async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") return reject(new Error("no port"));
      srv.close(() => resolve(addr.port));
    });
  });
}

describe("default base URL", () => {
  it("points at the local daemon, never a public host", () => {
    expect(DEFAULT_BASE_URL).toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
    expect(DEFAULT_BASE_URL).not.toContain("botnote.net");
  });

  it("uses the same port the daemon listens on by default", () => {
    expect(DEFAULT_PORT).toBe(SERVER_DEFAULT_PORT);
  });

  it("treats empty and blank env as unset", () => {
    expect(envValue(undefined)).toBeUndefined();
    expect(envValue("")).toBeUndefined();
    expect(envValue("   ")).toBeUndefined();
    expect(envValue(" https://x.example ")).toBe("https://x.example");
    expect(resolveBaseUrl({})).toEqual({ baseUrl: DEFAULT_BASE_URL, explicit: false });
    expect(resolveBaseUrl({ BOTNOTE_URL: "" })).toEqual({ baseUrl: DEFAULT_BASE_URL, explicit: false });
    expect(resolveBaseUrl({ BOTNOTE_URL: "https://x.example" })).toEqual({
      baseUrl: "https://x.example",
      explicit: true
    });
  });
});

describe("unreachable daemon messaging", () => {
  it("explains the implicit local default and how to point elsewhere", () => {
    const msg = unreachableHint(DEFAULT_BASE_URL, new TypeError("fetch failed"));
    expect(msg).toContain(DEFAULT_BASE_URL);
    expect(msg).toContain("botnote login");
    expect(msg).toContain("BOTNOTE_URL");
    expect(msg).toContain("No daemon URL is configured");
  });

  it("surfaces the underlying cause for an explicit URL", () => {
    const cause = Object.assign(new TypeError("fetch failed"), {
      cause: new Error("connect ECONNREFUSED 10.0.0.9:4280")
    });
    const msg = unreachableHint("http://10.0.0.9:4280", cause);
    expect(msg).toContain("http://10.0.0.9:4280");
    expect(msg).toContain("ECONNREFUSED");
    expect(msg).not.toContain("No daemon URL is configured");
  });

  it("http client raises BotnoteUnreachableError on a connection failure", async () => {
    const port = await closedPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const client = new BotnoteHttpClient({ baseUrl });
    await expect(client.listProjects()).rejects.toBeInstanceOf(BotnoteUnreachableError);
    await expect(client.listProjects()).rejects.toThrow(baseUrl);
  });
});

describe("corsOrigins", () => {
  it("allows loopback on the daemon port by default and nothing else", () => {
    expect(corsOrigins({})).toEqual([
      `http://127.0.0.1:${SERVER_DEFAULT_PORT}`,
      `http://localhost:${SERVER_DEFAULT_PORT}`
    ]);
  });

  it("follows BOTNOTE_PORT", () => {
    expect(corsOrigins({ BOTNOTE_PORT: "5000" })).toEqual([
      "http://127.0.0.1:5000",
      "http://localhost:5000"
    ]);
  });

  it("adds the origin of BOTNOTE_PUBLIC_URL, path stripped", () => {
    expect(corsOrigins({ BOTNOTE_PUBLIC_URL: "https://notes.example.com/app/" })).toContain(
      "https://notes.example.com"
    );
  });

  it("rejects a malformed BOTNOTE_PUBLIC_URL loudly", () => {
    expect(() => corsOrigins({ BOTNOTE_PUBLIC_URL: "notes.example.com" })).toThrow(
      /BOTNOTE_PUBLIC_URL/
    );
  });

  it("appends BOTNOTE_CORS_ORIGINS entries without duplicates", () => {
    const list = corsOrigins({
      BOTNOTE_PUBLIC_URL: "https://a.example",
      BOTNOTE_CORS_ORIGINS: "https://a.example, https://b.example,,"
    });
    expect(list.filter((o) => o === "https://a.example")).toHaveLength(1);
    expect(list).toContain("https://b.example");
  });
});
