# @ageflow/learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-evolving skill layer to AgentFlow that collects execution traces, injects learned skills into agent prompts, and improves skills via LLM reflection with DAG-aware credit assignment.

**Architecture:** Two new packages (`@ageflow/learning` for interfaces/hooks/workflows, `@ageflow/learning-sqlite` for SQLite store). Minimal changes to `@ageflow/core` (one new hook + one new TaskMetrics field) and `@ageflow/executor` (~20 lines). Learning workflows are built with `defineAgent`/`defineWorkflow` — the system learns through itself.

**Tech Stack:** TypeScript, Zod, bun:sqlite, sqlite-vec (optional), Vitest

**Spec:** `docs/superpowers/specs/2026-04-17-agentflow-learning-design.md`

---

## File Structure

### Modified files

| File | Change |
|------|--------|
| `packages/core/src/types.ts` | Add `getSystemPromptPrefix` to `WorkflowHooks`, add `promptSent` to `TaskMetrics` |
| `packages/core/src/index.ts` | No change — types already exported |
| `packages/executor/src/node-runner.ts` | Prepend hook prefix to systemPrompt, populate `promptSent` in metrics |
| `packages/executor/src/workflow-executor.ts` | Pass `promptSent` through to TaskMetrics |
| `packages/cli/src/bin.ts` | Register learn + feedback commands |
| `package.json` (root) | No change — `packages/*` glob already covers new packages |

### New files — `packages/learning/`

| File | Purpose |
|------|---------|
| `packages/learning/package.json` | Package manifest |
| `packages/learning/tsconfig.json` | TypeScript config |
| `packages/learning/src/index.ts` | Public API barrel |
| `packages/learning/src/types.ts` | `SkillRecord`, `ExecutionTrace`, `TaskTrace`, `Feedback`, `TraceFilter`, `ScoredSkill` |
| `packages/learning/src/interfaces.ts` | `SkillStore`, `TraceStore` interfaces |
| `packages/learning/src/hooks.ts` | `createLearningHooks()` — trace collection + skill injection |
| `packages/learning/src/scoring.ts` | EMA score calculation + rollback logic |
| `packages/learning/src/workflows/reflection.ts` | `reflectionWorkflow` — credit assignment + skill generation |
| `packages/learning/src/workflows/evaluation.ts` | `evaluationWorkflow` — hypothetical comparison |
| `packages/learning/src/workflows/promotion.ts` | `promotionWorkflow` — versioning + rollback |
| `packages/learning/src/__tests__/types.test.ts` | Type/schema tests |
| `packages/learning/src/__tests__/hooks.test.ts` | Hook behavior tests |
| `packages/learning/src/__tests__/scoring.test.ts` | Score accumulation tests |
| `packages/learning/src/__tests__/workflows.test.ts` | Learning workflow tests |

### New files — `packages/learning-sqlite/`

| File | Purpose |
|------|---------|
| `packages/learning-sqlite/package.json` | Package manifest |
| `packages/learning-sqlite/tsconfig.json` | TypeScript config |
| `packages/learning-sqlite/src/index.ts` | Public API barrel |
| `packages/learning-sqlite/src/sqlite-skill-store.ts` | `SqliteSkillStore` implementing `SkillStore` |
| `packages/learning-sqlite/src/sqlite-trace-store.ts` | `SqliteTraceStore` implementing `TraceStore` |
| `packages/learning-sqlite/src/sqlite-learning-store.ts` | `SqliteLearningStore` convenience (both interfaces) |
| `packages/learning-sqlite/src/migrations.ts` | Schema creation SQL |
| `packages/learning-sqlite/src/__tests__/store.test.ts` | Store CRUD + search tests |

### New files — CLI

| File | Purpose |
|------|---------|
| `packages/cli/src/commands/learn.ts` | `agentwf learn status/evaluate/promote/export/import` |
| `packages/cli/src/commands/feedback.ts` | `agentwf feedback <traceId>` |

---

## Phase 1: Core Hooks + TaskMetrics

### Task 1: Add `getSystemPromptPrefix` hook and `promptSent` metric to core types

**Files:**
- Modify: `packages/core/src/types.ts:465-503`
- Test: `packages/core/src/__tests__/types.test-d.ts` (type-level test)

- [ ] **Step 1: Add `promptSent` to TaskMetrics**

In `packages/core/src/types.ts`, find `TaskMetrics` (line 465) and add:

```ts
export interface TaskMetrics {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
  readonly retries: number;
  /** Estimated USD cost based on model and token counts. */
  readonly estimatedCost: number;
  /** The full prompt as sent to the runner (including any injected prefixes). */
  readonly promptSent?: string;
}
```

- [ ] **Step 2: Add `getSystemPromptPrefix` to WorkflowHooks**

In same file, find `WorkflowHooks` (line 482) and add before the closing brace:

```ts
export interface WorkflowHooks<T extends TasksMap = TasksMap> {
  readonly onTaskStart?: (taskName: keyof T & string) => void;
  readonly onTaskComplete?: (
    taskName: keyof T & string,
    output: unknown,
    metrics: TaskMetrics,
  ) => void;
  readonly onTaskError?: (
    taskName: keyof T & string,
    error: Error,
    attempt: number,
  ) => void;
  readonly onCheckpoint?: (taskName: keyof T & string, message: string) => void;
  readonly onWorkflowComplete?: (
    result: unknown,
    summary: WorkflowMetrics,
  ) => void;
  /**
   * Returns extra context to prepend to the agent's system prompt.
   * Called before each task spawn. Learning hooks use this to inject skills.
   * Generic — useful beyond learning (per-task instructions, env context).
   */
  readonly getSystemPromptPrefix?: (
    taskName: keyof T & string,
  ) => string | undefined;
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd packages/core && bun run typecheck`
Expected: PASS (new optional fields are backward-compatible)

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(core): #24 — add getSystemPromptPrefix hook + promptSent metric"
```

### Task 2: Wire hooks into executor

**Files:**
- Modify: `packages/executor/src/node-runner.ts:134-138`
- Modify: `packages/executor/src/workflow-executor.ts:424-429,691-696`
- Test: `packages/executor/src/__tests__/node-runner.test.ts`

- [ ] **Step 1: Write failing test — systemPrompt prefix injection**

Create test in `packages/executor/src/__tests__/node-runner.test.ts` (append to existing):

```ts
describe("getSystemPromptPrefix hook", () => {
  it("prepends prefix to systemPrompt when hook returns content", async () => {
    // ... setup a workflow with getSystemPromptPrefix hook
    // Assert spawn was called with systemPrompt starting with prefix
  });

  it("leaves systemPrompt unchanged when hook returns undefined", async () => {
    // ... setup without hook
    // Assert systemPrompt is unchanged
  });
});
```

Note: exact test code depends on existing test patterns in node-runner.test.ts. Read the file and follow the mock-runner pattern already established there.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/executor && bun run test -- --grep "getSystemPromptPrefix"`
Expected: FAIL

- [ ] **Step 3: Implement prefix injection in node-runner.ts**

In `packages/executor/src/node-runner.ts`, find where `spawnArgs` is built (line ~134):

```ts
// Before:
const spawnArgs: import("@ageflow/core").RunnerSpawnArgs = {
  prompt,
  taskName,
  systemPrompt: buildOutputSchemaPrompt(resolvedDef.output),
};

// After:
const baseSystemPrompt = buildOutputSchemaPrompt(resolvedDef.output);
const prefix = hooks?.getSystemPromptPrefix?.(taskName);
const spawnArgs: import("@ageflow/core").RunnerSpawnArgs = {
  prompt,
  taskName,
  systemPrompt: prefix
    ? `${prefix}\n\n${baseSystemPrompt}`
    : baseSystemPrompt,
};
```

Note: `hooks` must be threaded through to `runNode`. Check the function signature — it may need a new parameter or access via the workflow-executor context.

- [ ] **Step 4: Populate `promptSent` in TaskMetrics**

In `packages/executor/src/workflow-executor.ts`, where `taskMetrics` is built before `onTaskComplete` (around lines 410-425):

Add `promptSent` to the metrics object:

```ts
const taskMetrics: TaskMetrics = {
  tokensIn: result.tokensIn,
  tokensOut: result.tokensOut,
  latencyMs: Date.now() - taskStart,
  retries: attempt - 1,
  estimatedCost: this.budgetTracker.costFor(model, result.tokensIn, result.tokensOut),
  promptSent: spawnArgs.systemPrompt
    ? `${spawnArgs.systemPrompt}\n\n${spawnArgs.prompt}`
    : spawnArgs.prompt,
};
```

Do this at BOTH `onTaskComplete` call sites (lines ~425 and ~692).

- [ ] **Step 5: Run tests**

Run: `cd packages/executor && bun run test`
Expected: ALL PASS (163+ existing + 2 new)

- [ ] **Step 6: Run typecheck across monorepo**

Run: `bun run typecheck`
Expected: 23/23 PASS

- [ ] **Step 7: Commit**

```bash
git add packages/executor/src/node-runner.ts packages/executor/src/workflow-executor.ts packages/executor/src/__tests__/node-runner.test.ts
git commit -m "feat(executor): #24 — wire getSystemPromptPrefix hook + promptSent metric"
```

---

## Phase 2: @ageflow/learning — Types + Interfaces

### Task 3: Scaffold learning package

**Files:**
- Create: `packages/learning/package.json`
- Create: `packages/learning/tsconfig.json`
- Create: `packages/learning/src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@ageflow/learning",
  "version": "0.3.0",
  "description": "Self-evolving skill layer for ageflow — trace collection, skill injection, LLM reflection with DAG-aware credit assignment",
  "homepage": "https://github.com/Neftedollar/ageflow/tree/master/packages/learning",
  "type": "module",
  "private": false,
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
  "peerDependencies": {
    "@ageflow/executor": "workspace:*"
  },
  "peerDependenciesMeta": {
    "@ageflow/executor": { "optional": true }
  },
  "devDependencies": {
    "@ageflow/executor": "workspace:*",
    "@types/node": "^22.0.0",
    "vitest": "^2.1.0",
    "zod": "^3.23.0"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test-d.ts", "dist", "node_modules"]
}
```

- [ ] **Step 3: Create empty barrel**

`packages/learning/src/index.ts`:
```ts
// @ageflow/learning — Self-evolving skill layer
// Public API exported below as types/interfaces are added.
```

- [ ] **Step 4: Install deps**

Run: `bun install`
Expected: clean install, new workspace member detected

- [ ] **Step 5: Verify typecheck**

Run: `bun run typecheck`
Expected: new package included in turbo graph, PASS

- [ ] **Step 6: Commit**

```bash
git add packages/learning/
git commit -m "chore(learning): #24 — scaffold @ageflow/learning package"
```

### Task 4: Define types (SkillRecord, ExecutionTrace, Feedback)

**Files:**
- Create: `packages/learning/src/types.ts`
- Test: `packages/learning/src/__tests__/types.test.ts`

- [ ] **Step 1: Write type definitions with Zod schemas**

`packages/learning/src/types.ts`:

```ts
import { z } from "zod";

// ─── Feedback ─────────────────────────────────────────────────────────────────

export const FeedbackSchema = z.object({
  rating: z.enum(["positive", "negative", "mixed"]),
  comment: z.string().optional(),
  source: z.enum(["human", "ci", "monitoring"]),
  timestamp: z.string().datetime(),
});

export type Feedback = z.infer<typeof FeedbackSchema>;

// ─── TaskTrace ────────────────────────────────────────────────────────────────

export const TaskTraceSchema = z.object({
  taskName: z.string(),
  agentRunner: z.string(),
  prompt: z.string(),
  output: z.string(),
  parsedOutput: z.unknown(),
  success: z.boolean(),
  skillsApplied: z.array(z.string()),
  tokensIn: z.number(),
  tokensOut: z.number(),
  durationMs: z.number(),
  retryCount: z.number(),
});

export type TaskTrace = z.infer<typeof TaskTraceSchema>;

// ─── ExecutionTrace ───────────────────────────────────────────────────────────

export const ExecutionTraceSchema = z.object({
  id: z.string().uuid(),
  workflowName: z.string(),
  runAt: z.string().datetime(),
  success: z.boolean(),
  totalDurationMs: z.number(),
  taskTraces: z.array(TaskTraceSchema),
  workflowInput: z.unknown(),
  workflowOutput: z.unknown(),
  feedback: z.array(FeedbackSchema),
});

export type ExecutionTrace = z.infer<typeof ExecutionTraceSchema>;

// ─── SkillRecord ──────────────────────────────────────────────────────────────

export const SkillRecordSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  content: z.string(),
  targetAgent: z.string(),
  targetWorkflow: z.string().optional(),
  version: z.number().int().nonnegative(),
  parentId: z.string().uuid().optional(),
  status: z.enum(["active", "retired"]),
  score: z.number().min(0).max(1),
  runCount: z.number().int().nonnegative(),
  bestInLineage: z.boolean(),
  createdAt: z.string().datetime(),
});

export type SkillRecord = z.infer<typeof SkillRecordSchema>;

// ─── Query types ──────────────────────────────────────────────────────────────

export interface ScoredSkill {
  readonly skill: SkillRecord;
  /** Retrieval relevance score (0-1), NOT quality score. */
  readonly relevance: number;
}

export interface TraceFilter {
  readonly workflowName?: string;
  readonly since?: string;
  readonly limit?: number;
  readonly hasFeedback?: boolean;
}

// ─── Learning config ──────────────────────────────────────────────────────────

export interface LearningThresholds {
  /** Score below which reflection triggers skill rewrite. Default: 0.7 */
  readonly reflectionThreshold: number;
  /** Score drop from best-in-lineage that triggers rollback. Default: 0.15 */
  readonly rollbackMargin: number;
  /** Minimum runs before rollback decision. Default: 3 */
  readonly minRunsBeforeRollback: number;
  /** EMA smoothing factor. Default: 0.3 */
  readonly emaAlpha: number;
  /** EMA alpha when delayed feedback contradicts immediate. Default: 0.5 */
  readonly feedbackAlpha: number;
}

export const DEFAULT_THRESHOLDS: LearningThresholds = {
  reflectionThreshold: 0.7,
  rollbackMargin: 0.15,
  minRunsBeforeRollback: 3,
  emaAlpha: 0.3,
  feedbackAlpha: 0.5,
};

export type ReflectEvery = "always" | "on-failure" | "on-feedback" | number;

export interface LearningConfig {
  readonly strategy: "autonomous" | "hitl";
  readonly reflectEvery: ReflectEvery;
  readonly thresholds: LearningThresholds;
}

export const DEFAULT_CONFIG: LearningConfig = {
  strategy: "autonomous",
  reflectEvery: "always",
  thresholds: DEFAULT_THRESHOLDS,
};
```

- [ ] **Step 2: Write schema validation tests**

`packages/learning/src/__tests__/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ExecutionTraceSchema,
  FeedbackSchema,
  SkillRecordSchema,
  TaskTraceSchema,
} from "../types.js";

describe("FeedbackSchema", () => {
  it("accepts valid feedback", () => {
    const result = FeedbackSchema.safeParse({
      rating: "negative",
      comment: "PR rejected",
      source: "human",
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid rating", () => {
    const result = FeedbackSchema.safeParse({
      rating: "terrible",
      source: "human",
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});

describe("SkillRecordSchema", () => {
  it("accepts valid skill record", () => {
    const result = SkillRecordSchema.safeParse({
      id: crypto.randomUUID(),
      name: "analyze-root-cause-v1",
      description: "Improved root cause analysis",
      content: "# Skill\nAlways check adjacent modules...",
      targetAgent: "analyze",
      version: 1,
      parentId: undefined,
      status: "active",
      score: 0.8,
      runCount: 5,
      bestInLineage: true,
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects score > 1", () => {
    const result = SkillRecordSchema.safeParse({
      id: crypto.randomUUID(),
      name: "test",
      description: "test",
      content: "test",
      targetAgent: "test",
      version: 0,
      status: "active",
      score: 1.5,
      runCount: 0,
      bestInLineage: false,
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});

describe("ExecutionTraceSchema", () => {
  it("accepts valid trace with empty feedback", () => {
    const result = ExecutionTraceSchema.safeParse({
      id: crypto.randomUUID(),
      workflowName: "bug-fix",
      runAt: new Date().toISOString(),
      success: true,
      totalDurationMs: 5000,
      taskTraces: [],
      workflowInput: { file: "main.ts" },
      workflowOutput: { fixed: true },
      feedback: [],
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd packages/learning && bun run test`
Expected: 4 tests PASS

- [ ] **Step 4: Commit**

```bash
git add packages/learning/src/types.ts packages/learning/src/__tests__/types.test.ts
git commit -m "feat(learning): #24 — SkillRecord, ExecutionTrace, Feedback types with Zod schemas"
```

### Task 5: Define store interfaces

**Files:**
- Create: `packages/learning/src/interfaces.ts`

- [ ] **Step 1: Write interfaces**

`packages/learning/src/interfaces.ts`:

```ts
import type {
  ExecutionTrace,
  Feedback,
  ScoredSkill,
  SkillRecord,
  TraceFilter,
} from "./types.js";

/** Persistent storage for learned skills. */
export interface SkillStore {
  save(skill: SkillRecord): Promise<void>;
  get(id: string): Promise<SkillRecord | null>;
  getByTarget(
    targetAgent: string,
    targetWorkflow?: string,
  ): Promise<SkillRecord[]>;
  getActiveForTask(
    taskName: string,
    workflowName?: string,
  ): Promise<SkillRecord | null>;
  getBestInLineage(skillId: string): Promise<SkillRecord | null>;
  search(query: string, limit: number): Promise<ScoredSkill[]>;
  list(): Promise<SkillRecord[]>;
  retire(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Persistent storage for workflow execution traces + feedback. */
export interface TraceStore {
  saveTrace(trace: ExecutionTrace): Promise<void>;
  getTrace(id: string): Promise<ExecutionTrace | null>;
  getTraces(filter: TraceFilter): Promise<ExecutionTrace[]>;
  addFeedback(traceId: string, feedback: Feedback): Promise<void>;
}
```

- [ ] **Step 2: Update barrel export**

`packages/learning/src/index.ts`:

```ts
// Types
export type {
  ExecutionTrace,
  Feedback,
  LearningConfig,
  LearningThresholds,
  ReflectEvery,
  ScoredSkill,
  SkillRecord,
  TaskTrace,
  TraceFilter,
} from "./types.js";

export {
  DEFAULT_CONFIG,
  DEFAULT_THRESHOLDS,
  ExecutionTraceSchema,
  FeedbackSchema,
  SkillRecordSchema,
  TaskTraceSchema,
} from "./types.js";

// Interfaces
export type { SkillStore, TraceStore } from "./interfaces.js";
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/learning/src/interfaces.ts packages/learning/src/index.ts
git commit -m "feat(learning): #24 — SkillStore + TraceStore interfaces"
```

---

## Phase 3: @ageflow/learning-sqlite — Store Implementation

### Task 6: Scaffold learning-sqlite package

**Files:**
- Create: `packages/learning-sqlite/package.json`
- Create: `packages/learning-sqlite/tsconfig.json`
- Create: `packages/learning-sqlite/src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@ageflow/learning-sqlite",
  "version": "0.3.0",
  "description": "SQLite + sqlite-vec storage for @ageflow/learning — skills, traces, vector search",
  "homepage": "https://github.com/Neftedollar/ageflow/tree/master/packages/learning-sqlite",
  "type": "module",
  "private": false,
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
    "@ageflow/learning": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "vitest": "^2.1.0"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Create tsconfig.json** (same pattern as learning)

- [ ] **Step 3: Create empty barrel + bun install**

- [ ] **Step 4: Commit**

```bash
git add packages/learning-sqlite/
git commit -m "chore(learning-sqlite): #24 — scaffold @ageflow/learning-sqlite package"
```

### Task 7: SQLite migrations

**Files:**
- Create: `packages/learning-sqlite/src/migrations.ts`

- [ ] **Step 1: Write schema SQL**

`packages/learning-sqlite/src/migrations.ts`:

```ts
/** SQL statements to initialize the learning database schema. */
export const MIGRATIONS = [
  // Skills table
  `CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    content TEXT NOT NULL,
    target_agent TEXT NOT NULL,
    target_workflow TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    parent_id TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'retired')),
    score REAL NOT NULL DEFAULT 0.5,
    run_count INTEGER NOT NULL DEFAULT 0,
    best_in_lineage INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    FOREIGN KEY (parent_id) REFERENCES skills(id)
  )`,

  // Index for task+workflow lookup
  `CREATE INDEX IF NOT EXISTS idx_skills_target
   ON skills(target_agent, target_workflow, status)`,

  // FTS5 for keyword search fallback
  `CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
    name, description, content='skills', content_rowid='rowid'
  )`,

  // Traces table
  `CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    workflow_name TEXT NOT NULL,
    run_at TEXT NOT NULL,
    success INTEGER NOT NULL,
    total_duration_ms INTEGER NOT NULL,
    task_traces TEXT NOT NULL,
    workflow_input TEXT,
    workflow_output TEXT,
    feedback TEXT NOT NULL DEFAULT '[]'
  )`,

  // Index for workflow lookup
  `CREATE INDEX IF NOT EXISTS idx_traces_workflow
   ON traces(workflow_name, run_at DESC)`,
] as const;
```

- [ ] **Step 2: Commit**

```bash
git add packages/learning-sqlite/src/migrations.ts
git commit -m "feat(learning-sqlite): #24 — SQLite schema migrations"
```

### Task 8: SqliteSkillStore implementation

**Files:**
- Create: `packages/learning-sqlite/src/sqlite-skill-store.ts`
- Test: `packages/learning-sqlite/src/__tests__/store.test.ts`

- [ ] **Step 1: Write failing tests for SkillStore CRUD**

`packages/learning-sqlite/src/__tests__/store.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillRecord } from "@ageflow/learning";
import { SqliteSkillStore } from "../sqlite-skill-store.js";
import { MIGRATIONS } from "../migrations.js";

function makeSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: crypto.randomUUID(),
    name: "test-skill",
    description: "A test skill",
    content: "# Skill\nDo the thing well.",
    targetAgent: "analyze",
    version: 0,
    status: "active",
    score: 0.5,
    runCount: 0,
    bestInLineage: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("SqliteSkillStore", () => {
  let db: Database;
  let store: SqliteSkillStore;

  beforeEach(() => {
    db = new Database(":memory:");
    for (const sql of MIGRATIONS) db.run(sql);
    store = new SqliteSkillStore(db);
  });

  afterEach(() => db.close());

  it("save + get round-trips a skill", async () => {
    const skill = makeSkill();
    await store.save(skill);
    const loaded = await store.get(skill.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe(skill.name);
    expect(loaded!.content).toBe(skill.content);
  });

  it("getActiveForTask returns the active skill for a task", async () => {
    const s1 = makeSkill({ targetAgent: "fix", status: "active" });
    const s2 = makeSkill({ targetAgent: "fix", status: "retired" });
    await store.save(s1);
    await store.save(s2);
    const active = await store.getActiveForTask("fix");
    expect(active).not.toBeNull();
    expect(active!.id).toBe(s1.id);
  });

  it("retire sets status to retired", async () => {
    const skill = makeSkill();
    await store.save(skill);
    await store.retire(skill.id);
    const loaded = await store.get(skill.id);
    expect(loaded!.status).toBe("retired");
  });

  it("search finds skills by keyword (FTS5 fallback)", async () => {
    const skill = makeSkill({ description: "root cause analysis for TypeScript" });
    await store.save(skill);
    const results = await store.search("root cause", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.skill.id).toBe(skill.id);
  });

  it("getBestInLineage returns highest-scoring version", async () => {
    const v1 = makeSkill({ version: 0, score: 0.6, bestInLineage: false });
    const v2 = makeSkill({ version: 1, score: 0.9, parentId: v1.id, bestInLineage: true });
    const v3 = makeSkill({ version: 2, score: 0.4, parentId: v2.id, bestInLineage: false });
    await store.save(v1);
    await store.save(v2);
    await store.save(v3);
    const best = await store.getBestInLineage(v3.id);
    expect(best).not.toBeNull();
    expect(best!.id).toBe(v2.id);
  });
});
```

- [ ] **Step 2: Implement SqliteSkillStore**

`packages/learning-sqlite/src/sqlite-skill-store.ts` — implement each method using `bun:sqlite` prepared statements. Key patterns:
- `save()`: INSERT OR REPLACE + FTS5 sync
- `get()`: SELECT by id → map row to SkillRecord
- `getActiveForTask()`: SELECT WHERE target_agent = ? AND status = 'active' ORDER BY score DESC LIMIT 1
- `search()`: Query FTS5 table, join back to skills, return ScoredSkill[]
- `getBestInLineage()`: Traverse parent_id chain, find max score
- `retire()`: UPDATE status = 'retired'

- [ ] **Step 3: Run tests**

Run: `cd packages/learning-sqlite && bun run test`
Expected: 5 tests PASS

- [ ] **Step 4: Commit**

```bash
git add packages/learning-sqlite/src/sqlite-skill-store.ts packages/learning-sqlite/src/__tests__/store.test.ts
git commit -m "feat(learning-sqlite): #24 — SqliteSkillStore with FTS5 search"
```

### Task 9: SqliteTraceStore + SqliteLearningStore

**Files:**
- Create: `packages/learning-sqlite/src/sqlite-trace-store.ts`
- Create: `packages/learning-sqlite/src/sqlite-learning-store.ts`
- Test: append to `packages/learning-sqlite/src/__tests__/store.test.ts`

- [ ] **Step 1: Write failing tests for TraceStore**

Add to existing test file:

```ts
describe("SqliteTraceStore", () => {
  it("save + get round-trips a trace", async () => { /* ... */ });
  it("addFeedback appends to existing trace", async () => { /* ... */ });
  it("getTraces filters by workflowName", async () => { /* ... */ });
  it("getTraces filters by hasFeedback", async () => { /* ... */ });
});
```

- [ ] **Step 2: Implement SqliteTraceStore**

JSON-serialize `taskTraces` and `feedback` arrays into TEXT columns.
`addFeedback()`: SELECT trace → JSON.parse feedback → push new entry → UPDATE.

- [ ] **Step 3: Create SqliteLearningStore convenience class**

`packages/learning-sqlite/src/sqlite-learning-store.ts`:

```ts
import { Database } from "bun:sqlite";
import type { SkillStore, TraceStore } from "@ageflow/learning";
import { MIGRATIONS } from "./migrations.js";
import { SqliteSkillStore } from "./sqlite-skill-store.js";
import { SqliteTraceStore } from "./sqlite-trace-store.js";

/**
 * Convenience wrapper — single SQLite database backing both stores.
 * Implements SkillStore & TraceStore.
 */
export class SqliteLearningStore implements SkillStore, TraceStore {
  private readonly skillStore: SqliteSkillStore;
  private readonly traceStore: SqliteTraceStore;

  constructor(pathOrDb: string | Database) {
    const db =
      typeof pathOrDb === "string" ? new Database(pathOrDb) : pathOrDb;
    for (const sql of MIGRATIONS) db.run(sql);
    this.skillStore = new SqliteSkillStore(db);
    this.traceStore = new SqliteTraceStore(db);
  }

  // Delegate all SkillStore methods
  save = this.skillStore.save.bind(this.skillStore);
  get = this.skillStore.get.bind(this.skillStore);
  getByTarget = this.skillStore.getByTarget.bind(this.skillStore);
  getActiveForTask = this.skillStore.getActiveForTask.bind(this.skillStore);
  getBestInLineage = this.skillStore.getBestInLineage.bind(this.skillStore);
  search = this.skillStore.search.bind(this.skillStore);
  list = this.skillStore.list.bind(this.skillStore);
  retire = this.skillStore.retire.bind(this.skillStore);
  delete = this.skillStore.delete.bind(this.skillStore);

  // Delegate all TraceStore methods
  saveTrace = this.traceStore.saveTrace.bind(this.traceStore);
  getTrace = this.traceStore.getTrace.bind(this.traceStore);
  getTraces = this.traceStore.getTraces.bind(this.traceStore);
  addFeedback = this.traceStore.addFeedback.bind(this.traceStore);
}
```

- [ ] **Step 4: Update barrel + run tests + commit**

```bash
git commit -m "feat(learning-sqlite): #24 — SqliteTraceStore + SqliteLearningStore"
```

---

## Phase 4: createLearningHooks — Trace Collection + Skill Injection

### Task 10: Implement createLearningHooks

**Files:**
- Create: `packages/learning/src/hooks.ts`
- Test: `packages/learning/src/__tests__/hooks.test.ts`

- [ ] **Step 1: Write failing tests**

Key test cases:
- `createLearningHooks` returns a `WorkflowHooks` object with all required callbacks
- `getSystemPromptPrefix` returns skill content when active skill exists for task
- `getSystemPromptPrefix` returns undefined when no skill exists
- `onWorkflowComplete` saves ExecutionTrace to traceStore
- `onWorkflowComplete` respects `reflectEvery` rate limiting
- TaskTrace records include `skillsApplied` from injected skills

- [ ] **Step 2: Implement hooks.ts**

Core logic:
1. On `onTaskStart`: look up active skill via `skillStore.getActiveForTask(taskName, workflowName)`, cache it
2. `getSystemPromptPrefix`: return cached skill content (or undefined)
3. On `onTaskComplete`: build TaskTrace from metrics + cached context
4. On `onWorkflowComplete`: assemble ExecutionTrace from accumulated TaskTraces, save to traceStore, optionally trigger reflectionWorkflow

- [ ] **Step 3: Export from barrel + run all tests + commit**

```bash
git commit -m "feat(learning): #24 — createLearningHooks with trace collection + skill injection"
```

---

## Phase 5: Scoring Logic

### Task 11: EMA score calculation + rollback

**Files:**
- Create: `packages/learning/src/scoring.ts`
- Test: `packages/learning/src/__tests__/scoring.test.ts`

- [ ] **Step 1: Write tests**

```ts
describe("updateScore (EMA)", () => {
  it("applies EMA with default alpha 0.3", () => { /* ... */ });
  it("uses higher alpha for delayed feedback", () => { /* ... */ });
  it("clamps score to [0, 1]", () => { /* ... */ });
});

describe("shouldRollback", () => {
  it("returns false when runCount < minRuns", () => { /* ... */ });
  it("returns false when score is within rollback margin", () => { /* ... */ });
  it("returns true when score drops below best - margin", () => { /* ... */ });
});
```

- [ ] **Step 2: Implement scoring.ts**

```ts
import type { LearningThresholds } from "./types.js";

export function updateScore(
  currentScore: number,
  signal: number,
  isDelayedFeedback: boolean,
  thresholds: LearningThresholds,
): number {
  const alpha = isDelayedFeedback ? thresholds.feedbackAlpha : thresholds.emaAlpha;
  const raw = alpha * signal + (1 - alpha) * currentScore;
  return Math.max(0, Math.min(1, raw));
}

export function shouldRollback(
  currentScore: number,
  bestScore: number,
  runCount: number,
  thresholds: LearningThresholds,
): boolean {
  if (runCount < thresholds.minRunsBeforeRollback) return false;
  return currentScore < bestScore - thresholds.rollbackMargin;
}
```

- [ ] **Step 3: Run tests + commit**

```bash
git commit -m "feat(learning): #24 — EMA scoring + rollback logic"
```

---

## Phase 6: Reflection Workflow

### Task 12: Credit assignment + skill generation agents

**Files:**
- Create: `packages/learning/src/workflows/reflection.ts`
- Test: `packages/learning/src/__tests__/workflows.test.ts`

- [ ] **Step 1: Define creditAssignment agent**

```ts
import { defineAgent, defineWorkflow } from "@ageflow/core";
import { z } from "zod";

const CreditResultSchema = z.object({
  workflowScore: z.number().min(0).max(1),
  taskScores: z.record(
    z.string(),
    z.object({
      score: z.number().min(0).max(1),
      creditWeight: z.number().min(0).max(1),
      diagnosis: z.string(),
      improvementHint: z.string(),
    }),
  ),
  workflowLevelInsight: z.string().optional(),
});

export const creditAssignmentAgent = defineAgent({
  runner: "api",  // configurable — user can re-register
  model: "claude-sonnet-4-6",
  input: z.object({
    currentTrace: z.string(),      // JSON-serialized ExecutionTrace
    historicalTraces: z.string(),   // JSON-serialized ExecutionTrace[]
    dagStructure: z.string(),      // task names + dependencies
  }),
  output: CreditResultSchema,
  prompt: (input) => `You are a workflow quality analyst...
[CRAFT DETAILED PROMPT - see spec §9.2 for requirements]

Current execution trace:
${input.currentTrace}

Historical traces (training set — generalize, don't memorize):
${input.historicalTraces}

DAG structure:
${input.dagStructure}

Return JSON matching the output schema.`,
});
```

- [ ] **Step 2: Define generateSkillDrafts agent**

Similar pattern — sonnet-tier agent that takes diagnosis + improvementHint
and generates/updates a SkillRecord.

- [ ] **Step 3: Define reflectionWorkflow**

```ts
export const reflectionWorkflow = defineWorkflow({
  name: "__ageflow_reflection",
  tasks: {
    creditAssignment: {
      agent: creditAssignmentAgent,
      input: ({ currentTrace, historicalTraces, dagStructure }) => ({
        currentTrace,
        historicalTraces,
        dagStructure,
      }),
    },
    generateSkills: {
      agent: generateSkillDraftsAgent,
      dependsOn: ["creditAssignment"] as const,
      input: (ctx) => ({
        creditResult: JSON.stringify(ctx.creditAssignment),
        // ... existing skills, task traces for low-scoring tasks
      }),
    },
  },
});
```

- [ ] **Step 4: Write tests using createTestHarness**

Mock both agents, verify:
- creditAssignment receives correct trace format
- generateSkills only fires for tasks below threshold
- Output SkillRecords have correct lineage (parentId)

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(learning): #24 — reflectionWorkflow with credit assignment + skill generation"
```

---

## Phase 7: Evaluation + Promotion Workflows

### Task 13: Hypothetical evaluation workflow

**Files:**
- Create: `packages/learning/src/workflows/evaluation.ts`

Simpler workflow — one agent that compares skill vs no-skill hypothetically.
Test with mocked agent. Commit separately.

### Task 14: Promotion workflow (deterministic)

**Files:**
- Create: `packages/learning/src/workflows/promotion.ts`

No LLM — pure logic. Uses `shouldRollback()` from scoring.ts.
Reads skills from store, checks scores, promotes/retires/rollbacks.
Fully testable without mocks.

---

## Phase 8: CLI Subcommands

### Task 15: `agentwf learn` + `agentwf feedback` commands

**Files:**
- Create: `packages/cli/src/commands/learn.ts`
- Create: `packages/cli/src/commands/feedback.ts`
- Modify: `packages/cli/src/bin.ts`

Follow existing Commander.js pattern. Each command:
- `learn status` — list active skills with scores
- `learn evaluate` — run evaluationWorkflow
- `learn promote` — run promotionWorkflow
- `learn export` — dump skills as .skill.md files
- `learn import <path>` — import .skill.md
- `feedback <traceId> --rating --comment` — add delayed feedback

---

## Verification Checklist

After all phases:

- [ ] `bun install` — clean
- [ ] `bun run typecheck` — all packages pass (25+ tasks)
- [ ] `bun run test` — all packages pass (650+ tests)
- [ ] `bun run lint` — 0 errors
- [ ] `bun run build` — all dist/ produced
- [ ] Integration: existing workflows work unchanged without learning
- [ ] Integration: workflow with `createLearningHooks()` collects traces
- [ ] Integration: injected skills appear in agent systemPrompt
