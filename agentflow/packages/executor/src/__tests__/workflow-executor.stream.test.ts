import { defineAgent, defineWorkflow, registerRunner, unregisterRunner } from "@ageflow/core";
import type { Runner, WorkflowEvent } from "@ageflow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowExecutor } from "../workflow-executor.js";

const fakeRunner: Runner = {
  validate: async () => ({ ok: true }),
  spawn: async () => ({
    stdout: JSON.stringify({ summary: "ok" }),
    sessionHandle: "s",
    tokensIn: 1,
    tokensOut: 2,
  }),
};

const agent = defineAgent({
  runner: "fake",
  input: z.object({}),
  output: z.object({ summary: z.string() }),
  prompt: () => "go",
});

const wf = defineWorkflow({
  name: "demo",
  tasks: {
    a: { agent, input: {} },
    b: { agent, input: {}, dependsOn: ["a"] as const },
  },
});

beforeEach(() => registerRunner("fake", fakeRunner));
afterEach(() => unregisterRunner("fake"));

describe("WorkflowExecutor.stream (happy path)", () => {
  it("yields workflow:start → task:start/task:complete × 2 → workflow:complete", async () => {
    const executor = new WorkflowExecutor(wf);
    const events: WorkflowEvent[] = [];
    const gen = executor.stream({});
    let result: IteratorResult<WorkflowEvent, unknown>;
    do {
      result = await gen.next();
      if (!result.done) events.push(result.value);
    } while (!result.done);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("workflow:start");
    expect(types).toContain("task:start");
    expect(types).toContain("task:complete");
    expect(types[types.length - 1]).toBe("workflow:complete");
    // Exactly 2 task:start / 2 task:complete
    expect(types.filter((t) => t === "task:start").length).toBe(2);
    expect(types.filter((t) => t === "task:complete").length).toBe(2);
    // All events share the same runId and workflowName === "demo"
    const runIds = new Set(events.map((e) => e.runId));
    expect(runIds.size).toBe(1);
    for (const e of events) expect(e.workflowName).toBe("demo");
  });
});

describe("WorkflowExecutor.stream (task failure)", () => {
  it("emits task:error with terminal:true and a terminal workflow:error", async () => {
    const boom: Runner = {
      validate: async () => ({ ok: true }),
      spawn: async () => {
        throw new Error("subprocess failure");
      },
    };
    registerRunner("boom", boom);
    try {
      const a = defineAgent({
        runner: "boom",
        input: z.object({}),
        output: z.object({ x: z.string() }),
        prompt: () => "go",
        retry: { max: 1, on: ["subprocess_error"], backoff: "fixed" },
      });
      const wfx = defineWorkflow({
        name: "bad",
        tasks: { t: { agent: a, input: {} } },
      });
      const executor = new WorkflowExecutor(wfx);
      const events: WorkflowEvent[] = [];
      const gen = executor.stream({});
      try {
        for await (const ev of gen) events.push(ev);
      } catch {
        // driver throws — we still collected the events
      }
      const taskErr = events.find((e) => e.type === "task:error");
      expect(taskErr).toBeDefined();
      if (taskErr?.type === "task:error") {
        expect(taskErr.terminal).toBe(true);
      }
      expect(events[events.length - 1]?.type).toBe("workflow:error");
    } finally {
      unregisterRunner("boom");
    }
  });
});
