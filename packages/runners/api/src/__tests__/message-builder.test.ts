import { describe, expect, it } from "vitest";
import { buildInitialMessages, toolsToSchemas } from "../message-builder.js";
import type { ChatMessage } from "../openai-types.js";
import type { ToolRegistry } from "../types.js";

describe("buildInitialMessages", () => {
  it("user-only prompt with no system and no history", () => {
    const msgs = buildInitialMessages({
      prompt: "hi",
      systemPrompt: undefined,
      history: undefined,
    });
    expect(msgs).toEqual([{ role: "user", content: "hi" }]);
  });

  it("prepends system prompt when provided", () => {
    const msgs = buildInitialMessages({
      prompt: "hi",
      systemPrompt: "You are strict.",
      history: undefined,
    });
    expect(msgs[0]).toEqual({ role: "system", content: "You are strict." });
    expect(msgs[1]).toEqual({ role: "user", content: "hi" });
  });

  it("appends user after existing history", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier answer" },
    ];
    const msgs = buildInitialMessages({
      prompt: "next",
      systemPrompt: undefined,
      history,
    });
    expect(msgs.length).toBe(4);
    expect(msgs[3]).toEqual({ role: "user", content: "next" });
  });

  it("P2-6: replaces stale system message with new systemPrompt on resumed sessions", () => {
    // Executor regenerates system prompt with per-task output schema on every
    // spawn. The new systemPrompt must replace the old one so stale schema
    // instructions do not persist across resumed sessions.
    const history: ChatMessage[] = [
      { role: "system", content: "old schema" },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
    ];
    const msgs = buildInitialMessages({
      prompt: "next",
      systemPrompt: "new schema",
      history,
    });
    // Exactly one system message
    const systemMsgs = msgs.filter((m) => m.role === "system");
    expect(systemMsgs.length).toBe(1);
    // Must be the NEW prompt, not the old one
    expect(systemMsgs[0]).toEqual({ role: "system", content: "new schema" });
    // Must appear first
    expect(msgs[0]).toEqual({ role: "system", content: "new schema" });
    // Old system message must be gone — remaining history preserved
    expect(msgs.filter((m) => m.content === "old schema").length).toBe(0);
    // User prompt is last
    expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: "next" });
  });
});

describe("toolsToSchemas — empty-allowlist / deny-all semantics (#160)", () => {
  const registry: ToolRegistry = {
    my_tool: {
      description: "a tool",
      parameters: { type: "object", properties: {} },
      execute: async () => "result",
    },
  };

  it("returns undefined when names is undefined (no restriction)", () => {
    expect(toolsToSchemas(registry, undefined)).toBeUndefined();
  });

  it("returns [] when names is [] (explicit deny-all)", () => {
    const result = toolsToSchemas(registry, []);
    expect(result).toEqual([]);
  });

  it("returns matching schemas for a non-empty allowlist", () => {
    const result = toolsToSchemas(registry, ["my_tool"]);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.function.name).toBe("my_tool");
  });

  it("returns [] (not undefined) for an allowlist with no registry matches", () => {
    // All names unknown — but list is defined → deny-all semantics preserved
    const result = toolsToSchemas(registry, ["unknown_tool"]);
    // The function skips unknown names but still returns an array (possibly empty)
    // since the caller explicitly provided a non-empty allowlist
    expect(Array.isArray(result)).toBe(true);
  });
});
