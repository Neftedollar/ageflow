import { defineAgent, defineWorkflow } from "@ageflow/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpServer } from "../../server.js";

describe("createMcpServer (integration)", () => {
  const greetAgent = defineAgent({
    runner: "claude",
    model: "claude-sonnet-4-6",
    input: z.object({ name: z.string() }),
    output: z.object({ greeting: z.string() }),
    prompt: ({ name }) => `say hi to ${name}`,
  });

  const workflow = defineWorkflow({
    name: "greet",
    mcp: { description: "Greet someone", maxCostUsd: 0.5 },
    tasks: { greet: { agent: greetAgent } },
  });

  it("lists the workflow as a single tool", async () => {
    const server = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "fail",
    });
    const tools = await server.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("greet");
    expect(tools[0]?.description).toBe("Greet someone");
  });

  it("rejects call with invalid input", async () => {
    const server = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "fail",
    });
    const result = await server.callTool("greet", { name: 123 });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).errorCode).toBe(
      "INPUT_VALIDATION_FAILED",
    );
  });

  it("returns BUSY when a call is already in flight", async () => {
    const server = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "fail",
    });
    // Mock executor to hang so we can test concurrency
    const hangPromise = new Promise(() => {});
    (server as any)._testRunExecutor = () => hangPromise;

    server.callTool("greet", { name: "a" }); // no await
    const result = await server.callTool("greet", { name: "b" });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).errorCode).toBe("BUSY");
  });
});
