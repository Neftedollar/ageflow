import { describe, expect, it } from "vitest";
import {
  AnthropicRequestError,
  AnthropicRunner,
  InMemoryAnthropicSessionStore,
  MaxToolRoundsError,
  McpPoolCollisionError,
  ToolNotFoundError,
} from "../index.js";
import type {
  AnthropicMessage,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicRunnerConfig,
  AnthropicSessionStore,
  AnthropicToolSchema,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ThinkingConfig,
  ToolResultBlock,
  ToolUseBlock,
} from "../index.js";

describe("barrel exports", () => {
  it("AnthropicRunner is exported and instantiable", () => {
    const runner = new AnthropicRunner({ apiKey: "k" });
    expect(runner).toBeInstanceOf(AnthropicRunner);
  });

  it("InMemoryAnthropicSessionStore is exported and instantiable", () => {
    const store = new InMemoryAnthropicSessionStore();
    expect(store).toBeInstanceOf(InMemoryAnthropicSessionStore);
  });

  it("AnthropicRequestError is exported and instantiable", () => {
    const err = new AnthropicRequestError(400, "bad request");
    expect(err).toBeInstanceOf(AnthropicRequestError);
    expect(err.status).toBe(400);
    expect(err.body).toBe("bad request");
    expect(err.code).toBe("anthropic_request_failed");
  });

  it("MaxToolRoundsError is re-exported", () => {
    const err = new MaxToolRoundsError(10);
    expect(err).toBeInstanceOf(MaxToolRoundsError);
    expect(err.code).toBe("tool_loop_exceeded");
  });

  it("ToolNotFoundError is re-exported", () => {
    const err = new ToolNotFoundError("my_tool");
    expect(err).toBeInstanceOf(ToolNotFoundError);
    expect(err.code).toBe("tool_not_found");
  });

  it("McpPoolCollisionError is re-exported", () => {
    const err = new McpPoolCollisionError("my-server");
    expect(err).toBeInstanceOf(McpPoolCollisionError);
    expect(err.code).toBe("mcp_pool_collision");
  });

  it("type-level: AnthropicMessage can be used as annotation", () => {
    const msg: AnthropicMessage = { role: "user", content: "hello" };
    expect(msg.role).toBe("user");
  });

  it("type-level: ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock compile", () => {
    const text: TextBlock = { type: "text", text: "hi" };
    const toolUse: ToolUseBlock = {
      type: "tool_use",
      id: "id1",
      name: "tool",
      input: {},
    };
    const thinking: ThinkingBlock = {
      type: "thinking",
      thinking: "thoughts",
    };
    expect(text.type).toBe("text");
    expect(toolUse.type).toBe("tool_use");
    expect(thinking.type).toBe("thinking");
  });

  it("type-level: AnthropicToolSchema compiles", () => {
    const schema: AnthropicToolSchema = {
      name: "foo",
      description: "bar",
      input_schema: { type: "object" },
    };
    expect(schema.name).toBe("foo");
  });

  it("type-level: ThinkingConfig compiles", () => {
    const cfg: ThinkingConfig = { type: "enabled", budget_tokens: 5000 };
    expect(cfg.type).toBe("enabled");
  });

  // Compile-time checks: these just need to import without error
  it("all type-only imports resolve (AnthropicRunnerConfig, AnthropicSessionStore, etc.)", () => {
    // If these types weren't exported the import at the top would fail to compile
    const _config: AnthropicRunnerConfig = { apiKey: "k" };
    const _store: AnthropicSessionStore = new InMemoryAnthropicSessionStore();
    expect(_config.apiKey).toBe("k");
    expect(_store).toBeTruthy();
  });
});
