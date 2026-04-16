# `@ageflow/runner-api` — Implementation Plan

**Date:** 2026-04-16
**Issue:** #30
**Spec:** `docs/superpowers/specs/2026-04-16-api-runner-design.md`
**Status:** Ready to execute

---

## Goal

Ship `@ageflow/runner-api` — a `Runner` implementation that talks to any
OpenAI-compatible chat completions endpoint via `fetch()`. Supports
multi-round tool calling internally, pluggable session storage, and
returns `ToolCallRecord[]` for observability. Zero external deps.

## Architecture

```
@ageflow/core (existing)
  ├── add optional RunnerSpawnResult.toolCalls?: readonly ToolCallRecord[]
  └── export ToolCallRecord type

@ageflow/runner-api (new)
  ├── types.ts            — ApiRunnerConfig, ToolRegistry, ToolDefinition re-exports
  ├── openai-types.ts     — OpenAI chat completion request/response types
  ├── session-store.ts    — SessionStore iface + InMemorySessionStore
  ├── message-builder.ts  — builds messages[] from system/prompt/history
  ├── tool-loop.ts        — POST /chat/completions loop until no tool_calls
  ├── api-runner.ts       — Runner impl: validate() + spawn()
  └── index.ts            — public exports
```

## Tech stack

- Runtime: Bun / Node 20+ (uses built-in `fetch`, `crypto.randomUUID`)
- Types: TypeScript strict, extends `tsconfig.base.json`
- Tests: Vitest (`environment: "node"`)
- Lint: Biome (inherited from repo root)
- Zero runtime deps beyond `@ageflow/core` (workspace)

## Runner contract (reference — `packages/core/src/types.ts` lines 71–110)

```ts
interface RunnerSpawnArgs {
  prompt: string;
  model?: string;
  tools?: readonly string[];            // names to filter registry by
  skills?: readonly string[];           // ignored by api runner
  mcps?: readonly MCPConfig[];          // ignored by api runner (v1)
  sessionHandle?: string;
  permissions?: Readonly<Record<string, boolean>>;
  systemPrompt?: string;
  taskName?: string;
}

interface RunnerSpawnResult {
  readonly stdout: string;
  readonly sessionHandle: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  // NEW (Phase 2): readonly toolCalls?: readonly ToolCallRecord[];
}

interface Runner {
  validate(): Promise<{ ok: boolean; version?: string; error?: string }>;
  spawn(args: RunnerSpawnArgs): Promise<RunnerSpawnResult>;
}
```

`RunnerSpawnResult.toolCalls` does **not** yet exist in core. Phase 2 adds it
as an optional field (backward-compatible — claude/codex runners keep
returning results without it).

---

## File structure

### New files

| Path | Purpose |
|------|---------|
| `packages/runners/api/package.json` | Workspace manifest (`@ageflow/runner-api`) |
| `packages/runners/api/tsconfig.json` | Extends base; `rootDir: src`, path alias for `@ageflow/core` |
| `packages/runners/api/vitest.config.ts` | Vitest config (`environment: "node"`) |
| `packages/runners/api/README.md` | Usage, provider table, examples |
| `packages/runners/api/src/index.ts` | Public exports |
| `packages/runners/api/src/types.ts` | `ApiRunnerConfig`, `ToolRegistry`, `ToolDefinition` |
| `packages/runners/api/src/openai-types.ts` | OpenAI protocol types (subset) |
| `packages/runners/api/src/session-store.ts` | `SessionStore` iface + `InMemorySessionStore` |
| `packages/runners/api/src/message-builder.ts` | Build `ChatMessage[]` from args + history |
| `packages/runners/api/src/tool-loop.ts` | Multi-round tool call loop + token accounting |
| `packages/runners/api/src/api-runner.ts` | `ApiRunner` class (`Runner` impl) |
| `packages/runners/api/src/errors.ts` | `MaxToolRoundsError`, `ApiRequestError`, `ToolNotFoundError` |
| `packages/runners/api/src/__tests__/session-store.test.ts` | In-memory store tests |
| `packages/runners/api/src/__tests__/message-builder.test.ts` | Message-building tests |
| `packages/runners/api/src/__tests__/tool-loop.test.ts` | Tool-loop tests (mock `fetch`) |
| `packages/runners/api/src/__tests__/api-runner.test.ts` | ApiRunner integration tests (mock `fetch`) |
| `examples/api-runner/package.json` | Example workspace |
| `examples/api-runner/workflow.ts` | Minimal workflow using `api` runner |
| `examples/api-runner/agents/summarize.ts` | Single agent definition |
| `examples/api-runner/__mocks__/fetch-mock.ts` | Injected fetch for offline demo run |
| `examples/api-runner/README.md` | How to run against OpenAI / Ollama |

### Modified files

| Path | Change |
|------|--------|
| `packages/core/src/types.ts` | Add `ToolCallRecord`; add optional `toolCalls?` to `RunnerSpawnResult` |
| `packages/core/src/index.ts` | Re-export `ToolCallRecord` |
| `packages/core/src/__tests__/types.test-d.ts` *(or new)* | Type-level assertion that `toolCalls` is optional |
| `package.json` (root workspaces) | Include `packages/runners/api` and `examples/api-runner` (matches existing glob) |
| `tsconfig.base.json` | No change expected — already used by sibling runners |
| `CLAUDE.md` (agentflow) | Mention new runner in package list |

---

## Phases

Each task = one commit with a fixed message. TDD order: failing test first,
then implementation, then green.

### Phase 1 — Package scaffold

**Task 1.1 — workspace manifest + tsconfig + vitest**

1. Create `packages/runners/api/package.json`:

```json
{
  "name": "@ageflow/runner-api",
  "version": "0.1.0",
  "description": "OpenAI-compatible HTTP runner for ageflow (OpenAI, Groq, Together, Ollama, vLLM, LM Studio, Azure).",
  "type": "module",
  "private": false,
  "sideEffects": false,
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "biome check src/"
  },
  "dependencies": {
    "@ageflow/core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "vitest": "^2.1.0",
    "zod": "^3.23.0"
  },
  "license": "MIT"
}
```

2. Create `packages/runners/api/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "tsBuildInfoFile": "dist/.tsbuildinfo",
    "paths": { "@ageflow/core": ["../../core/src/index.ts"] }
  },
  "references": [{ "path": "../../core" }],
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "dist"]
}
```

3. Create `packages/runners/api/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
```

4. Create empty `packages/runners/api/src/index.ts` with `export {};` so
   `bun install && bun run typecheck --filter @ageflow/runner-api` passes.
5. Verify scaffold:
   - `bun install` at repo root succeeds
   - `bun run --filter @ageflow/runner-api typecheck` passes
   - `bun run --filter @ageflow/runner-api test` reports 0 tests (passWithNoTests)

**Commit:** `feat(runner-api): scaffold @ageflow/runner-api package (#30)`

---

### Phase 2 — `ToolCallRecord` in `@ageflow/core`

Additive, backward-compatible change. All four existing runners keep passing.

**Task 2.1 — failing test: `RunnerSpawnResult.toolCalls` is optional + typed**

1. Add `packages/core/src/__tests__/runner-result.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { RunnerSpawnResult, ToolCallRecord } from "../index.js";

describe("RunnerSpawnResult", () => {
  it("allows toolCalls to be omitted (backward compat)", () => {
    const r: RunnerSpawnResult = {
      stdout: "hi",
      sessionHandle: "s1",
      tokensIn: 1,
      tokensOut: 2,
    };
    expect(r.toolCalls).toBeUndefined();
  });

  it("accepts a ToolCallRecord[]", () => {
    const record: ToolCallRecord = {
      name: "readFile",
      args: { path: "./x" },
      result: "contents",
      durationMs: 42,
    };
    const r: RunnerSpawnResult = {
      stdout: "ok",
      sessionHandle: "s2",
      tokensIn: 10,
      tokensOut: 20,
      toolCalls: [record],
    };
    expect(r.toolCalls?.[0]?.name).toBe("readFile");
  });
});
```

2. Run `bun run --filter @ageflow/core test`. Fails (`ToolCallRecord` not
   exported).

**Task 2.2 — implement in core**

1. In `packages/core/src/types.ts`, add below the existing
   `RunnerSpawnResult` block:

```ts
/**
 * Observability record for a single tool invocation performed by a runner.
 * Non-normative — runners that do not perform tool calls omit this.
 */
export interface ToolCallRecord {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: unknown;
  readonly durationMs: number;
}
```

2. Extend `RunnerSpawnResult`:

```ts
export interface RunnerSpawnResult {
  readonly stdout: string;
  readonly sessionHandle: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /**
   * Tool-call observability trail. Runners that do not perform tool calls
   * (e.g. subprocess runners) MAY omit this. Executor passes through to
   * `TaskMetrics` / `ExecutionTrace` when present.
   */
  readonly toolCalls?: readonly ToolCallRecord[];
}
```

3. In `packages/core/src/index.ts`, add `export type { ToolCallRecord }` to
   the existing re-export block.
4. Run `bun run --filter @ageflow/core test && bun run --filter @ageflow/core typecheck`. Green.
5. Run `bun run typecheck` at repo root. Other packages still compile
   (claude, codex, executor, testing all only read the required fields).

**Commit:** `feat(core): add ToolCallRecord + optional RunnerSpawnResult.toolCalls (#30)`

---

### Phase 3 — `SessionStore` interface + `InMemorySessionStore`

Pure, no I/O, trivial to test.

**Task 3.1 — failing test**

Create `packages/runners/api/src/__tests__/session-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { InMemorySessionStore } from "../session-store.js";
import type { ChatMessage } from "../openai-types.js";

const msg: ChatMessage = { role: "user", content: "hello" };

describe("InMemorySessionStore", () => {
  it("returns undefined for unknown handles", async () => {
    const store = new InMemorySessionStore();
    expect(await store.get("missing")).toBeUndefined();
  });

  it("round-trips messages via set/get", async () => {
    const store = new InMemorySessionStore();
    await store.set("h1", [msg]);
    expect(await store.get("h1")).toEqual([msg]);
  });

  it("isolates keys", async () => {
    const store = new InMemorySessionStore();
    await store.set("a", [msg]);
    await store.set("b", [{ role: "user", content: "other" }]);
    expect((await store.get("a"))?.[0]?.content).toBe("hello");
    expect((await store.get("b"))?.[0]?.content).toBe("other");
  });

  it("delete removes the handle", async () => {
    const store = new InMemorySessionStore();
    await store.set("gone", [msg]);
    await store.delete("gone");
    expect(await store.get("gone")).toBeUndefined();
  });

  it("stored snapshots are independent of the caller's array mutation", async () => {
    const store = new InMemorySessionStore();
    const live: ChatMessage[] = [msg];
    await store.set("h", live);
    live.push({ role: "user", content: "added after" });
    const got = await store.get("h");
    expect(got?.length).toBe(1);
  });
});
```

Run `vitest` → fails (no module).

**Task 3.2 — implement**

First add the protocol types placeholder so the test import resolves.

`packages/runners/api/src/openai-types.ts` (minimum needed for Phase 3; extended in Phase 4):

```ts
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
```

`packages/runners/api/src/session-store.ts`:

```ts
import type { ChatMessage } from "./openai-types.js";

export interface SessionStore {
  get(handle: string): Promise<ChatMessage[] | undefined>;
  set(handle: string, messages: ChatMessage[]): Promise<void>;
  delete(handle: string): Promise<void>;
}

/**
 * Default session store. Map<handle, ChatMessage[]>, process-local.
 * Stores copies so external mutation cannot change recorded history.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly data = new Map<string, ChatMessage[]>();

  async get(handle: string): Promise<ChatMessage[] | undefined> {
    const got = this.data.get(handle);
    return got ? [...got] : undefined;
  }

  async set(handle: string, messages: ChatMessage[]): Promise<void> {
    this.data.set(handle, [...messages]);
  }

  async delete(handle: string): Promise<void> {
    this.data.delete(handle);
  }
}
```

Run tests → green.

**Commit:** `feat(runner-api): SessionStore interface + InMemorySessionStore (#30)`

---

### Phase 4 — Tool loop (request builder, response parser, invocation)

#### Task 4.1 — types + errors

`packages/runners/api/src/types.ts`:

```ts
import type { SessionStore } from "./session-store.js";
export type { SessionStore } from "./session-store.js";
export type { ToolCallRecord } from "@ageflow/core";

export interface ToolDefinition {
  /** Human-readable description surfaced to the model. */
  description: string;
  /** JSON schema for the tool's arguments (OpenAI function-call format). */
  parameters: Record<string, unknown>;
  /** Synchronous or async. Errors are caught and sent back to the model. */
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

export type ToolRegistry = Record<string, ToolDefinition>;

export interface ApiRunnerConfig {
  /** e.g. "https://api.openai.com/v1" — no trailing slash. */
  baseUrl: string;
  apiKey: string;
  /** Fallback model when AgentDef.model is not set. */
  defaultModel?: string;
  tools?: ToolRegistry;
  sessionStore?: SessionStore;
  /** Default: 10. Hard ceiling against infinite tool loops. */
  maxToolRounds?: number;
  /** Default: 120_000ms. Per individual API call. */
  requestTimeout?: number;
  /** Extra headers (Helicone, Portkey, Azure `api-version`). */
  headers?: Record<string, string>;
  /** Injectable fetch for testing. Default: globalThis.fetch. */
  fetch?: typeof fetch;
}
```

`packages/runners/api/src/errors.ts`:

```ts
import { AgentFlowError } from "@ageflow/core";

export class MaxToolRoundsError extends AgentFlowError {
  readonly code = "tool_loop_exceeded" as const;
  constructor(readonly rounds: number, options?: ErrorOptions) {
    super(`Tool loop exceeded max rounds: ${rounds}`, options);
  }
}

export class ApiRequestError extends AgentFlowError {
  readonly code = "api_request_failed" as const;
  constructor(
    readonly status: number,
    readonly body: string,
    options?: ErrorOptions,
  ) {
    super(`API request failed (${status}): ${body}`, options);
  }
}

export class ToolNotFoundError extends AgentFlowError {
  readonly code = "tool_not_found" as const;
  constructor(readonly toolName: string, options?: ErrorOptions) {
    super(`Tool not registered: ${toolName}`, options);
  }
}
```

Verify: `bun run --filter @ageflow/runner-api typecheck` passes.

**Commit:** `feat(runner-api): public types + errors (#30)`

#### Task 4.2 — complete OpenAI protocol types

Extend `openai-types.ts` with request/response shapes:

```ts
export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
```

No runtime code, no separate test. (Indirectly exercised by Task 4.3/4.4.)

**Commit:** `feat(runner-api): OpenAI chat-completion protocol types (#30)`

#### Task 4.3 — failing test: message builder

`packages/runners/api/src/__tests__/message-builder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildInitialMessages } from "../message-builder.js";
import type { ChatMessage } from "../openai-types.js";

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

  it("does not duplicate system when history already has one", () => {
    const history: ChatMessage[] = [{ role: "system", content: "old" }];
    const msgs = buildInitialMessages({
      prompt: "p",
      systemPrompt: "new",
      history,
    });
    // history wins — new systemPrompt only prepended if history has no system
    expect(msgs.filter((m) => m.role === "system").length).toBe(1);
    expect(msgs[0]).toEqual({ role: "system", content: "old" });
  });
});
```

Run → fails (no module).

#### Task 4.4 — implement message builder

`packages/runners/api/src/message-builder.ts`:

```ts
import type { ChatMessage, ToolSchema } from "./openai-types.js";
import type { ToolRegistry } from "./types.js";

export interface BuildMessagesInput {
  prompt: string;
  systemPrompt: string | undefined;
  history: ChatMessage[] | undefined;
}

/**
 * Build the initial messages[] array for a new (or resumed) session.
 * Rule: system message present in history takes precedence; otherwise
 * the provided systemPrompt is prepended when non-empty.
 */
export function buildInitialMessages(input: BuildMessagesInput): ChatMessage[] {
  const history = input.history ?? [];
  const hasSystem = history.some((m) => m.role === "system");
  const out: ChatMessage[] = [];

  if (!hasSystem && input.systemPrompt && input.systemPrompt.length > 0) {
    out.push({ role: "system", content: input.systemPrompt });
  }

  out.push(...history);
  out.push({ role: "user", content: input.prompt });
  return out;
}

/**
 * Convert the subset of the runner's tool registry named in `names` into
 * OpenAI tool schemas. Unknown names are ignored (executor is responsible
 * for validating tool names against the registry before spawn).
 */
export function toolsToSchemas(
  registry: ToolRegistry,
  names: readonly string[] | undefined,
): ToolSchema[] | undefined {
  if (!names || names.length === 0) return undefined;
  const out: ToolSchema[] = [];
  for (const name of names) {
    const def = registry[name];
    if (!def) continue;
    out.push({
      type: "function",
      function: {
        name,
        description: def.description,
        parameters: def.parameters,
      },
    });
  }
  return out.length > 0 ? out : undefined;
}
```

Run tests → green.

**Commit:** `feat(runner-api): message builder + tool-schema projection (#30)`

#### Task 4.5 — failing test: tool loop (mock `fetch`)

`packages/runners/api/src/__tests__/tool-loop.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runToolLoop } from "../tool-loop.js";
import type { ChatCompletionResponse } from "../openai-types.js";
import type { ToolRegistry } from "../types.js";
import { MaxToolRoundsError } from "../errors.js";

function makeResponse(body: ChatCompletionResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const terminalAssistant: ChatCompletionResponse = {
  choices: [
    {
      message: { role: "assistant", content: "done", tool_calls: undefined },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

describe("runToolLoop", () => {
  it("returns assistant content when no tool_calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(terminalAssistant));
    const res = await runToolLoop({
      baseUrl: "https://example",
      apiKey: "k",
      headers: {},
      fetch: fetchMock as unknown as typeof fetch,
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      tools: undefined,
      registry: {},
      maxRounds: 10,
      requestTimeout: 1000,
    });
    expect(res.finalText).toBe("done");
    expect(res.toolCalls).toEqual([]);
    expect(res.tokensIn).toBe(3);
    expect(res.tokensOut).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("executes a tool, sends result back, sums tokens across rounds", async () => {
    const withToolCall: ChatCompletionResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "echo", arguments: JSON.stringify({ s: "hi" }) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(withToolCall))
      .mockResolvedValueOnce(makeResponse(terminalAssistant));

    const registry: ToolRegistry = {
      echo: {
        description: "echo",
        parameters: { type: "object" },
        execute: ({ s }) => `echoed:${s as string}`,
      },
    };

    const res = await runToolLoop({
      baseUrl: "https://example",
      apiKey: "k",
      headers: {},
      fetch: fetchMock as unknown as typeof fetch,
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: { name: "echo", description: "echo", parameters: {} },
        },
      ],
      registry,
      maxRounds: 10,
      requestTimeout: 1000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.finalText).toBe("done");
    expect(res.toolCalls.length).toBe(1);
    expect(res.toolCalls[0]?.name).toBe("echo");
    expect(res.toolCalls[0]?.args).toEqual({ s: "hi" });
    expect(res.toolCalls[0]?.result).toBe("echoed:hi");
    expect(res.tokensIn).toBe(13);   // 10 + 3
    expect(res.tokensOut).toBe(7);   // 5 + 2
  });

  it("catches tool errors and feeds them back to the model", async () => {
    const withToolCall: ChatCompletionResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_err",
                type: "function",
                function: { name: "boom", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(withToolCall))
      .mockResolvedValueOnce(makeResponse(terminalAssistant));

    const registry: ToolRegistry = {
      boom: {
        description: "",
        parameters: {},
        execute: () => {
          throw new Error("kaboom");
        },
      },
    };

    const res = await runToolLoop({
      baseUrl: "https://example",
      apiKey: "k",
      headers: {},
      fetch: fetchMock as unknown as typeof fetch,
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: undefined,
      registry,
      maxRounds: 10,
      requestTimeout: 1000,
    });
    expect(res.toolCalls[0]?.result).toMatch(/kaboom/);
  });

  it("throws MaxToolRoundsError when ceiling exceeded", async () => {
    const withToolCall: ChatCompletionResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_loop",
                type: "function",
                function: { name: "noop", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(withToolCall));
    const registry: ToolRegistry = {
      noop: { description: "", parameters: {}, execute: () => "ok" },
    };

    await expect(
      runToolLoop({
        baseUrl: "https://example",
        apiKey: "k",
        headers: {},
        fetch: fetchMock as unknown as typeof fetch,
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: undefined,
        registry,
        maxRounds: 2,
        requestTimeout: 1000,
      }),
    ).rejects.toBeInstanceOf(MaxToolRoundsError);
  });
});
```

Run → fails (no module).

#### Task 4.6 — implement tool loop

`packages/runners/api/src/tool-loop.ts`:

```ts
import type { ToolCallRecord } from "@ageflow/core";
import { ApiRequestError, MaxToolRoundsError } from "./errors.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ToolSchema,
} from "./openai-types.js";
import type { ToolRegistry } from "./types.js";

export interface RunToolLoopInput {
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[] | undefined;
  registry: ToolRegistry;
  maxRounds: number;
  requestTimeout: number;
}

export interface RunToolLoopResult {
  finalText: string;
  tokensIn: number;
  tokensOut: number;
  toolCalls: ToolCallRecord[];
  finalMessages: ChatMessage[];
}

export async function runToolLoop(
  input: RunToolLoopInput,
): Promise<RunToolLoopResult> {
  const messages: ChatMessage[] = [...input.messages];
  const toolCalls: ToolCallRecord[] = [];
  let tokensIn = 0;
  let tokensOut = 0;

  for (let round = 0; round < input.maxRounds; round++) {
    const body: ChatCompletionRequest = {
      model: input.model,
      messages,
      ...(input.tools ? { tools: input.tools } : {}),
    };

    const resp = await postChat(input, body);
    tokensIn += resp.usage.prompt_tokens;
    tokensOut += resp.usage.completion_tokens;

    const choice = resp.choices[0];
    if (!choice) {
      throw new ApiRequestError(500, "no choices in response");
    }
    const assistant = choice.message;

    // Persist assistant turn (content may be null when only tool_calls are returned).
    messages.push({
      role: "assistant",
      content: assistant.content ?? "",
      ...(assistant.tool_calls ? { tool_calls: assistant.tool_calls } : {}),
    });

    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      return {
        finalText: assistant.content ?? "",
        tokensIn,
        tokensOut,
        toolCalls,
        finalMessages: messages,
      };
    }

    for (const call of calls) {
      const name = call.function.name;
      const rawArgs = call.function.arguments;
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = rawArgs === "" ? {} : (JSON.parse(rawArgs) as Record<string, unknown>);
      } catch {
        parsedArgs = { __raw: rawArgs };
      }

      const def = input.registry[name];
      const startedAt = Date.now();
      let result: unknown;
      try {
        if (!def) {
          result = `error: tool "${name}" is not registered`;
        } else {
          result = await def.execute(parsedArgs);
        }
      } catch (err) {
        result = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      const durationMs = Date.now() - startedAt;

      toolCalls.push({ name, args: parsedArgs, result, durationMs });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
  }

  throw new MaxToolRoundsError(input.maxRounds);
}

async function postChat(
  input: RunToolLoopInput,
  body: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.requestTimeout);
  try {
    const resp = await input.fetch(`${input.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
        ...input.headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new ApiRequestError(resp.status, text);
    }
    return (await resp.json()) as ChatCompletionResponse;
  } finally {
    clearTimeout(timer);
  }
}
```

Run tests → green.

**Commit:** `feat(runner-api): multi-round tool loop with ToolCallRecord capture (#30)`

---

### Phase 5 — `ApiRunner` class (`Runner` impl)

#### Task 5.1 — failing test: spawn + session round-trip

`packages/runners/api/src/__tests__/api-runner.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ApiRunner } from "../api-runner.js";
import { InMemorySessionStore } from "../session-store.js";
import type { ChatCompletionResponse } from "../openai-types.js";

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const terminalAssistant: ChatCompletionResponse = {
  choices: [
    { message: { role: "assistant", content: "hello world" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
};

describe("ApiRunner.spawn", () => {
  it("performs a single completion and returns stdout + token counts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(terminalAssistant));
    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      defaultModel: "gpt-4o",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const res = await runner.spawn({
      prompt: "say hi",
      model: "gpt-4o",
      sessionHandle: undefined,
    });

    expect(res.stdout).toBe("hello world");
    expect(res.tokensIn).toBe(4);
    expect(res.tokensOut).toBe(3);
    expect(res.sessionHandle.length).toBeGreaterThan(0);
    expect(res.toolCalls).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses defaultModel when args.model is not set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(terminalAssistant));
    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      defaultModel: "gpt-4o-mini",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await runner.spawn({ prompt: "x" });
    const firstCall = fetchMock.mock.calls[0];
    const body = JSON.parse(firstCall?.[1]?.body as string) as { model: string };
    expect(body.model).toBe("gpt-4o-mini");
  });

  it("persists history to the session store under sessionHandle", async () => {
    const store = new InMemorySessionStore();
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(terminalAssistant));
    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      defaultModel: "gpt-4o",
      sessionStore: store,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const first = await runner.spawn({ prompt: "p1" });
    const history = await store.get(first.sessionHandle);
    expect(history?.length).toBeGreaterThanOrEqual(2); // user + assistant
  });

  it("resumes when sessionHandle is provided", async () => {
    const store = new InMemorySessionStore();
    await store.set("existing", [
      { role: "system", content: "sys" },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(terminalAssistant));
    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      defaultModel: "gpt-4o",
      sessionStore: store,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const res = await runner.spawn({ prompt: "next", sessionHandle: "existing" });
    expect(res.sessionHandle).toBe("existing");

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages.length).toBe(4); // system + earlier user + earlier assistant + next user
    expect(body.messages[3]?.content).toBe("next");
  });

  it("injects systemPrompt when provided and no prior system message exists", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(terminalAssistant));
    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await runner.spawn({ prompt: "x", model: "m", systemPrompt: "be concise" });
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]).toEqual({ role: "system", content: "be concise" });
  });
});
```

Run → fails.

#### Task 5.2 — implement ApiRunner

`packages/runners/api/src/api-runner.ts`:

```ts
import type { Runner, RunnerSpawnArgs, RunnerSpawnResult } from "@ageflow/core";
import { buildInitialMessages, toolsToSchemas } from "./message-builder.js";
import type { ChatMessage } from "./openai-types.js";
import { InMemorySessionStore, type SessionStore } from "./session-store.js";
import { runToolLoop } from "./tool-loop.js";
import type { ApiRunnerConfig, ToolRegistry } from "./types.js";

const DEFAULT_MAX_ROUNDS = 10;
const DEFAULT_TIMEOUT_MS = 120_000;

export class ApiRunner implements Runner {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string | undefined;
  private readonly tools: ToolRegistry;
  private readonly sessionStore: SessionStore;
  private readonly maxToolRounds: number;
  private readonly requestTimeout: number;
  private readonly headers: Record<string, string>;
  private readonly fetch: typeof fetch;

  constructor(config: ApiRunnerConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel;
    this.tools = config.tools ?? {};
    this.sessionStore = config.sessionStore ?? new InMemorySessionStore();
    this.maxToolRounds = config.maxToolRounds ?? DEFAULT_MAX_ROUNDS;
    this.requestTimeout = config.requestTimeout ?? DEFAULT_TIMEOUT_MS;
    this.headers = config.headers ?? {};
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  async validate(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const resp = await this.fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...this.headers,
        },
      });
      if (!resp.ok) {
        return { ok: false, error: `${resp.status} ${resp.statusText}` };
      }
      const body = (await resp.json()) as {
        data?: Array<{ id?: string }>;
      };
      const firstId = body.data?.[0]?.id;
      return firstId ? { ok: true, version: firstId } : { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async spawn(args: RunnerSpawnArgs): Promise<RunnerSpawnResult> {
    const model = args.model ?? this.defaultModel;
    if (!model) {
      throw new Error("ApiRunner.spawn: model not set and no defaultModel configured");
    }

    const handle = args.sessionHandle && args.sessionHandle.length > 0
      ? args.sessionHandle
      : crypto.randomUUID();

    const history: ChatMessage[] | undefined = args.sessionHandle
      ? await this.sessionStore.get(args.sessionHandle)
      : undefined;

    const initialMessages = buildInitialMessages({
      prompt: args.prompt,
      systemPrompt: args.systemPrompt,
      history,
    });

    const toolSchemas = toolsToSchemas(this.tools, args.tools);

    const loop = await runToolLoop({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      headers: this.headers,
      fetch: this.fetch,
      model,
      messages: initialMessages,
      tools: toolSchemas,
      registry: this.tools,
      maxRounds: this.maxToolRounds,
      requestTimeout: this.requestTimeout,
    });

    await this.sessionStore.set(handle, loop.finalMessages);

    return {
      stdout: loop.finalText,
      sessionHandle: handle,
      tokensIn: loop.tokensIn,
      tokensOut: loop.tokensOut,
      toolCalls: loop.toolCalls,
    };
  }
}
```

#### Task 5.3 — wire exports

`packages/runners/api/src/index.ts`:

```ts
export { ApiRunner } from "./api-runner.js";
export { InMemorySessionStore } from "./session-store.js";
export {
  MaxToolRoundsError,
  ApiRequestError,
  ToolNotFoundError,
} from "./errors.js";
export type {
  ApiRunnerConfig,
  ToolRegistry,
  ToolDefinition,
  SessionStore,
  ToolCallRecord,
} from "./types.js";
```

Run `bun run --filter @ageflow/runner-api test` → green.

**Commit:** `feat(runner-api): ApiRunner class with session persistence (#30)`

---

### Phase 6 — `validate()` via `GET /models` (covered; add explicit tests)

**Task 6.1 — failing test**

Append to `src/__tests__/api-runner.test.ts`:

```ts
describe("ApiRunner.validate", () => {
  it("returns ok + version from the first model id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const res = await runner.validate();
    expect(res.ok).toBe(true);
    expect(res.version).toBe("gpt-4o");
  });

  it("returns { ok: false } on 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("unauthorized", { status: 401, statusText: "Unauthorized" }),
    );
    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "bad",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const res = await runner.validate();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("401");
  });

  it("returns { ok: false } when fetch throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const runner = new ApiRunner({
      baseUrl: "http://localhost:1",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const res = await runner.validate();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ECONNREFUSED");
  });

  it("trailing slash on baseUrl is normalized", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "m" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1/",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await runner.validate();
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("https://example.test/v1/models");
  });
});
```

**Task 6.2 — implement**

Already implemented in Phase 5 task 5.2 (`validate()` uses
`${this.baseUrl}/models`). Run tests → green. If any fail, adjust
normalization / branches in `api-runner.ts`.

**Commit:** `test(runner-api): validate() via GET /models (success, 401, network error) (#30)`

---

### Phase 7 — Extended testing (backward compat + integration via mocked fetch)

**Task 7.1 — backward compat assertion**

Add to `packages/runners/claude/src/__tests__/claude-runner.test.ts`:

```ts
it("does not set toolCalls on RunnerSpawnResult", async () => {
  const stdout = makeJsonlOutput("x");
  const spawn = (): SpawnResult => makeSpawnResult(stdout);
  const runner = new ClaudeRunner({ spawn });
  const res = await runner.spawn({ prompt: "p" });
  expect(res.toolCalls).toBeUndefined();
});
```

Run → passes (field is optional, claude runner doesn't set it).

**Task 7.2 — integration test (env-gated real fetch)**

Add `packages/runners/api/src/__tests__/integration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ApiRunner } from "../api-runner.js";

const url = process.env.AGENTFLOW_TEST_API_URL;
const key = process.env.AGENTFLOW_TEST_API_KEY;
const model = process.env.AGENTFLOW_TEST_API_MODEL ?? "gpt-4o-mini";

const maybe = url && key ? describe : describe.skip;

maybe("ApiRunner (live)", () => {
  it("completes a trivial prompt", async () => {
    const runner = new ApiRunner({ baseUrl: url!, apiKey: key!, defaultModel: model });
    const res = await runner.spawn({ prompt: "Reply with the single word: pong" });
    expect(res.stdout.toLowerCase()).toContain("pong");
    expect(res.tokensIn).toBeGreaterThan(0);
    expect(res.tokensOut).toBeGreaterThan(0);
  }, 30_000);
});
```

**Commit:** `test(runner-api): backward-compat + env-gated live integration (#30)`

---

### Phase 8 — Example workspace `examples/api-runner/`

**Task 8.1 — scaffold**

1. `examples/api-runner/package.json`:

```json
{
  "name": "@ageflow-example/api-runner",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "demo": "bun workflow.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ageflow/core": "workspace:*",
    "@ageflow/runner-api": "workspace:*",
    "@ageflow/executor": "workspace:*",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "vitest": "^2.1.0"
  }
}
```

2. `examples/api-runner/tsconfig.json` (extend base, include `*.ts`).

3. `examples/api-runner/agents/summarize.ts`:

```ts
import { defineAgent } from "@ageflow/core";
import { z } from "zod";

export const summarize = defineAgent({
  runner: "api",
  model: "gpt-4o-mini",
  input: z.object({ text: z.string() }),
  output: z.object({ summary: z.string() }),
  prompt: (i) =>
    `Summarize the following in one sentence as JSON {"summary": string}:\n\n${i.text}`,
});
```

4. `examples/api-runner/workflow.ts`:

```ts
import { defineWorkflow, registerRunner } from "@ageflow/core";
import { ApiRunner } from "@ageflow/runner-api";
import { summarize } from "./agents/summarize.js";

registerRunner(
  "api",
  new ApiRunner({
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY ?? "",
    defaultModel: "gpt-4o-mini",
  }),
);

export const workflow = defineWorkflow({
  name: "api-runner-demo",
  tasks: {
    summarize: { agent: summarize, input: { text: "AgentFlow ships the API runner." } },
  },
});
```

5. `examples/api-runner/__mocks__/fetch-mock.ts` — injectable `fetch`
   returning a canned `ChatCompletionResponse` for offline demo (mirrors
   existing `examples/mcp-server/__mocks__`).

6. `examples/api-runner/README.md` — provider table + env vars.

**Task 8.2 — integration test using `createTestHarness`**

`examples/api-runner/workflow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@ageflow/testing";
import { workflow } from "./workflow.js";

describe("api-runner demo workflow", () => {
  it("produces a summary via mock agent", async () => {
    const harness = createTestHarness(workflow);
    harness.mockAgent("summarize", { summary: "ageflow ships api runner" });
    const res = await harness.run({});
    expect(res.output.summarize.summary).toContain("api runner");
  });
});
```

Run `bun run --filter @ageflow-example/api-runner test` → green.

**Commit:** `docs(runner-api): example workspace with mocked demo + harness test (#30)`

---

### Phase 9 — Publish prep

**Task 9.1 — README**

Write `packages/runners/api/README.md` with:

- Installation (`bun add @ageflow/runner-api`)
- Quick start (the `registerRunner("api", new ApiRunner(...))` snippet)
- Provider compatibility table (OpenAI, Groq, Together, Ollama, vLLM, LM Studio, Azure — from the spec)
- Tool registry example (`readFile` / `writeFile`)
- Session persistence + custom `SessionStore` example (Redis stub)
- Observability: `result.toolCalls` → `ExecutionTrace`
- Limits: `maxToolRounds`, `requestTimeout`, `headers`

**Task 9.2 — root updates**

1. Ensure root `package.json` `workspaces` glob already covers
   `packages/runners/*` and `examples/*`. If not, add
   `"packages/runners/api"` and `"examples/api-runner"`.
2. `agentflow/CLAUDE.md`: add `@ageflow/runner-api` under "Phases
   complete" (or the equivalent package list).
3. Run top-level checks:
   - `bun run typecheck` (all packages)
   - `bun run test` (all packages)
   - `bun run lint`

**Commit:** `docs(runner-api): README + publish metadata + root workspace wiring (#30)`

---

## Verification checklist

- [ ] `bun run --filter @ageflow/core test` — `ToolCallRecord` test green; claude/codex backward-compat test green
- [ ] `bun run --filter @ageflow/runner-api typecheck && test` — all four unit suites green (session, builder, tool-loop, api-runner) plus `validate()` suite
- [ ] `bun run --filter @ageflow/runner-api test -- --coverage` — `api-runner.ts`, `tool-loop.ts`, `message-builder.ts`, `session-store.ts` above 90 %
- [ ] `AGENTFLOW_TEST_API_URL=http://localhost:11434/v1 AGENTFLOW_TEST_API_KEY=ollama bun run --filter @ageflow/runner-api test` — live integration against Ollama
- [ ] `AGENTFLOW_TEST_API_URL=https://api.openai.com/v1 AGENTFLOW_TEST_API_KEY=$OPENAI_API_KEY bun run --filter @ageflow/runner-api test` — live integration against OpenAI
- [ ] `bun run --filter @ageflow-example/api-runner test` — example workflow green with mocked harness
- [ ] `bun run typecheck && bun run test && bun run lint` at repo root — everything green

## Open questions

- **Deny-by-default tools (`permissions` arg).** Spec doesn't say — proposed:
  in `spawn()`, if `args.permissions` is set, intersect with `args.tools`
  so disallowed names never reach the model. Current plan ignores
  `permissions` for v1; decision before Phase 5 finalization.
- **MCP passthrough.** API runner has no native MCP. Plan: ignore
  `args.mcps` silently (same as skills). Flag-and-warn is v2 territory.
- **Azure `api-version` header.** Plan leaves it to user `headers` option.
  Could pre-bake a helper once v2 adds per-provider presets.
- **Streaming.** Out of scope (spec §"Out of scope"); confirmed.
- **OpenAI `usage` null cases.** Some gateways (Ollama with older
  versions) omit `usage`. Plan defensively reads `?? 0`.
