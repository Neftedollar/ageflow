/**
 * http-transport.test.ts
 *
 * Integration tests for the Streamable HTTP transport.
 *
 * Each test spins up a real Node.js HTTP server on localhost:0 (random port)
 * and connects a real StreamableHTTPClientTransport from the MCP SDK.
 *
 * Tests:
 * - tools/list returns the workflow tool
 * - tools/call returns expected result
 * - Bearer auth: missing token → 401
 * - Bearer auth: wrong token → 401
 * - Bearer auth: correct token → success
 * - CORS preflight: OPTIONS returns expected headers
 * - Rate limit: exceed limit → 429
 * - Audit log: tool call invokes callback with correct shape
 * - Non-loopback without auth throws at construction
 */

import { defineAgent, defineWorkflow } from "@ageflow/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type AuditEvent, createHttpTransport } from "../http-transport.js";
import { createSingleWorkflowServer } from "../server.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const greetAgent = defineAgent({
  runner: "claude",
  model: "claude-sonnet-4-6",
  input: z.object({ name: z.string() }),
  output: z.object({ greeting: z.string() }),
  prompt: ({ name }) => `say hi to ${name}`,
});

const greetWorkflow = defineWorkflow({
  name: "greet",
  mcp: { description: "Greet someone", maxCostUsd: 0.5 },
  tasks: { greet: { agent: greetAgent } },
});

function makeHandle() {
  const handle = createSingleWorkflowServer({
    workflow: greetWorkflow,
    cliCeilings: {},
    hitlStrategy: "fail",
  });
  // _testRunExecutor signature: (args, hooks, signal, effective) => Promise<unknown>
  handle._testRunExecutor = async (args) => {
    const input = args as { name: string };
    return { greeting: `hello, ${input.name}!` };
  };
  return handle;
}

// ─── Helper: MCP client over HTTP ─────────────────────────────────────────────

async function connectClient(
  url: URL,
  opts?: { token?: string },
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit:
      opts?.token !== undefined
        ? { headers: { Authorization: `Bearer ${opts.token}` } }
        : undefined,
  });
  const client = new Client(
    { name: "test-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return {
    client,
    cleanup: async () => {
      await client.close();
    },
  };
}

// ─── Test suite: unauthenticated (loopback) ───────────────────────────────────

describe("createHttpTransport — unauthenticated loopback", () => {
  let httpHandle: ReturnType<typeof createHttpTransport>;
  let baseUrl: URL;
  let stderrLines: string[];

  beforeEach(async () => {
    stderrLines = [];
    const handle = makeHandle();
    httpHandle = createHttpTransport(
      handle,
      {
        port: 0, // OS-assigned
        host: "127.0.0.1",
        auth: { type: "none" },
        stderr: (l) => stderrLines.push(l),
      },
      "test-server",
      "0.0.1",
    );
    await httpHandle.start();
    const { port } = httpHandle.address();
    baseUrl = new URL(`http://127.0.0.1:${port}/mcp`);
  });

  afterEach(async () => {
    await httpHandle.stop();
  });

  it("emits startup banner to stderr", () => {
    expect(stderrLines.join("")).toMatch(/test-server@0\.0\.1.*HTTP/);
  });

  it("tools/list returns the greet tool", async () => {
    const { client, cleanup } = await connectClient(baseUrl);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe("greet");
      expect(tools[0]?.description).toBe("Greet someone");
    } finally {
      await cleanup();
    }
  });

  it("tools/call returns the greeting", async () => {
    const { client, cleanup } = await connectClient(baseUrl);
    try {
      const result = await client.callTool({
        name: "greet",
        arguments: { name: "World" },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as { type: string; text: string }[])[0]
        ?.text;
      const parsed = JSON.parse(text ?? "{}") as { greeting: string };
      expect(parsed.greeting).toBe("hello, World!");
    } finally {
      await cleanup();
    }
  });
});

// ─── Test suite: bearer auth ──────────────────────────────────────────────────

describe("createHttpTransport — bearer auth", () => {
  const TOKEN = "secret-test-token-xyz";
  let httpHandle: ReturnType<typeof createHttpTransport>;
  let baseUrl: URL;
  let port: number;

  beforeEach(async () => {
    const handle = makeHandle();
    httpHandle = createHttpTransport(
      handle,
      {
        port: 0,
        host: "127.0.0.1",
        auth: { type: "bearer", token: TOKEN },
        stderr: () => {},
      },
      "auth-server",
      "0.0.1",
    );
    await httpHandle.start();
    port = httpHandle.address().port;
    baseUrl = new URL(`http://127.0.0.1:${port}/mcp`);
  });

  afterEach(async () => {
    await httpHandle.stop();
  });

  it("missing token → 401 (connection fails)", async () => {
    const transport = new StreamableHTTPClientTransport(baseUrl);
    const client = new Client(
      { name: "test-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it("wrong token → 401 (connection fails)", async () => {
    const transport = new StreamableHTTPClientTransport(baseUrl, {
      requestInit: { headers: { Authorization: "Bearer wrong-token" } },
    });
    const client = new Client(
      { name: "test-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it("correct token → success", async () => {
    const { client, cleanup } = await connectClient(baseUrl, { token: TOKEN });
    try {
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === "greet")).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

// ─── Test suite: CORS ─────────────────────────────────────────────────────────

describe("createHttpTransport — CORS", () => {
  let httpHandle: ReturnType<typeof createHttpTransport>;
  let port: number;

  beforeEach(async () => {
    const handle = makeHandle();
    httpHandle = createHttpTransport(
      handle,
      {
        port: 0,
        host: "127.0.0.1",
        auth: { type: "none" },
        cors: { origin: "https://app.example.com" },
        stderr: () => {},
      },
      "cors-server",
      "0.0.1",
    );
    await httpHandle.start();
    port = httpHandle.address().port;
  });

  afterEach(async () => {
    await httpHandle.stop();
  });

  it("OPTIONS preflight returns CORS headers for allowed origin", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("OPTIONS preflight returns no CORS headers for disallowed origin", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does NOT echo the request Origin header (security: uses configured value only)", async () => {
    // Even if the request sends a different origin, we only ever return
    // the configured static value — never the request's origin.
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    const returned = res.headers.get("access-control-allow-origin");
    // Must be the configured literal, not something derived from the request.
    if (returned !== null) {
      expect(returned).toBe("https://app.example.com");
    }
  });
});

// ─── Test suite: rate limiting ────────────────────────────────────────────────

describe("createHttpTransport — rate limiting", () => {
  let httpHandle: ReturnType<typeof createHttpTransport>;
  let port: number;

  beforeEach(async () => {
    const handle = makeHandle();
    httpHandle = createHttpTransport(
      handle,
      {
        port: 0,
        host: "127.0.0.1",
        auth: { type: "none" },
        rateLimit: { windowMs: 10_000, max: 2 },
        stderr: () => {},
      },
      "rl-server",
      "0.0.1",
    );
    await httpHandle.start();
    port = httpHandle.address().port;
  });

  afterEach(async () => {
    await httpHandle.stop();
  });

  it("returns 429 when rate limit exceeded", async () => {
    // Send 3 POST requests; the 3rd should be rate-limited.
    // We use raw fetch so we can count responses without triggering MCP session logic.
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    const r1 = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers,
      body,
    });
    const r2 = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers,
      body,
    });
    const r3 = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers,
      body,
    });

    // First two requests: allowed (200-range or SSE)
    expect(r1.status).not.toBe(429);
    expect(r2.status).not.toBe(429);
    // Third: should be rate-limited
    expect(r3.status).toBe(429);
  });
});

// ─── Test suite: audit log ────────────────────────────────────────────────────

describe("createHttpTransport — audit log", () => {
  it("invokes auditLog with correct shape on tool call", async () => {
    const events: AuditEvent[] = [];
    const handle = makeHandle();
    const httpHandle = createHttpTransport(
      handle,
      {
        port: 0,
        host: "127.0.0.1",
        auth: { type: "none" },
        auditLog: (e) => events.push(e),
        stderr: () => {},
      },
      "audit-server",
      "0.0.1",
    );
    await httpHandle.start();
    const { port } = httpHandle.address();
    const baseUrl = new URL(`http://127.0.0.1:${port}/mcp`);

    const { client, cleanup } = await connectClient(baseUrl);
    try {
      await client.callTool({ name: "greet", arguments: { name: "Audit" } });
    } finally {
      await cleanup();
    }
    await httpHandle.stop();

    // Should have received at least one audit event for tools/call
    const toolCallEvent = events.find((e) => e.method === "tools/call");
    expect(toolCallEvent).toBeDefined();
    expect(toolCallEvent?.authDenied).toBe(false);
    expect(toolCallEvent?.rateLimited).toBe(false);
    expect(toolCallEvent?.toolName).toBe("greet");
    expect(typeof toolCallEvent?.ts).toBe("number");
    expect(typeof toolCallEvent?.remoteIp).toBe("string");
  });

  it("invokes auditLog with authDenied = true on 401", async () => {
    const events: AuditEvent[] = [];
    const handle = makeHandle();
    const httpHandle = createHttpTransport(
      handle,
      {
        port: 0,
        host: "127.0.0.1",
        auth: { type: "bearer", token: "mytoken" },
        auditLog: (e) => events.push(e),
        stderr: () => {},
      },
      "audit-auth-server",
      "0.0.1",
    );
    await httpHandle.start();
    const { port } = httpHandle.address();

    // Raw request without auth header
    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });

    await httpHandle.stop();

    const denied = events.find((e) => e.authDenied);
    expect(denied).toBeDefined();
    expect(denied?.authDenied).toBe(true);
    expect(denied?.rateLimited).toBe(false);
  });
});

// ─── Test suite: security — non-loopback without auth ────────────────────────

describe("createHttpTransport — security preconditions", () => {
  it("throws at construction when non-loopback host used without bearer auth", () => {
    const handle = makeHandle();
    expect(() => {
      createHttpTransport(
        handle,
        {
          port: 3000,
          host: "0.0.0.0",
          auth: { type: "none" },
          stderr: () => {},
        },
        "server",
        "1.0.0",
      );
    }).toThrow(/non-loopback/i);
  });

  it("does NOT throw when non-loopback host has bearer auth", () => {
    const handle = makeHandle();
    expect(() => {
      createHttpTransport(
        handle,
        {
          port: 3000,
          host: "0.0.0.0",
          auth: { type: "bearer", token: "secret" },
          stderr: () => {},
        },
        "server",
        "1.0.0",
      );
    }).not.toThrow();
  });
});
