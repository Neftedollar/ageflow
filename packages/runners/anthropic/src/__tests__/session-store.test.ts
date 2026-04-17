import { describe, expect, it } from "vitest";
import type { AnthropicMessage } from "../anthropic-types.js";
import { InMemoryAnthropicSessionStore } from "../session-store.js";

const msg1: AnthropicMessage = { role: "user", content: "hello" };
const msg2: AnthropicMessage = {
  role: "assistant",
  content: [{ type: "text", text: "world" }],
};

describe("InMemoryAnthropicSessionStore", () => {
  it("returns undefined for a missing handle", async () => {
    const store = new InMemoryAnthropicSessionStore();
    expect(await store.get("missing")).toBeUndefined();
  });

  it("stores and retrieves messages", async () => {
    const store = new InMemoryAnthropicSessionStore();
    await store.set("h1", [msg1, msg2]);
    const got = await store.get("h1");
    expect(got).toEqual([msg1, msg2]);
  });

  it("returns deep-cloned copies (mutation guard)", async () => {
    const store = new InMemoryAnthropicSessionStore();
    const msgs: AnthropicMessage[] = [msg1];
    await store.set("h2", msgs);
    const copy = await store.get("h2");
    // Mutating the copy must not affect stored data
    (copy as AnthropicMessage[]).push(msg2);
    const stored = await store.get("h2");
    expect(stored?.length).toBe(1);
  });

  it("deletes a session", async () => {
    const store = new InMemoryAnthropicSessionStore();
    await store.set("h3", [msg1]);
    await store.delete("h3");
    expect(await store.get("h3")).toBeUndefined();
  });

  it("delete is a no-op for non-existent handle", async () => {
    const store = new InMemoryAnthropicSessionStore();
    await expect(store.delete("nonexistent")).resolves.toBeUndefined();
  });

  it("overwrites existing session on set", async () => {
    const store = new InMemoryAnthropicSessionStore();
    await store.set("h4", [msg1]);
    await store.set("h4", [msg2]);
    const got = await store.get("h4");
    expect(got).toEqual([msg2]);
  });
});
