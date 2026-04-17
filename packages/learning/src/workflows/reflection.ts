import { defineAgent, defineWorkflow } from "@ageflow/core";
import type { BoundCtx } from "@ageflow/core";
import { WorkflowExecutor } from "@ageflow/executor";
import { z } from "zod";
import type { SkillStore, TraceStore } from "../interfaces.js";
import type { ExecutionTrace, SkillRecord, TaskTrace } from "../types.js";
import { DEFAULT_THRESHOLDS } from "../types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default score threshold below which a task is flagged for skill generation. */
const DEFAULT_SKILL_THRESHOLD = 0.7;

/** Fraction of historical traces used as training set. Remaining = held-out. */
const TRAIN_SPLIT = 0.6;

// ─── Credit assignment output schema ─────────────────────────────────────────

const TaskCreditSchema = z.object({
  score: z.number().min(0).max(1),
  creditWeight: z.number().min(0).max(1),
  diagnosis: z.string(),
  improvementHint: z.string(),
});

export const CreditResultSchema = z.object({
  workflowScore: z.number().min(0).max(1),
  taskScores: z.record(z.string(), TaskCreditSchema),
  workflowLevelInsight: z.string().optional(),
});

export type CreditResult = z.infer<typeof CreditResultSchema>;

// ─── Skill draft output schema ────────────────────────────────────────────────

export const SkillDraftSchema = z.object({
  taskName: z.string(),
  skillName: z.string(),
  description: z.string(),
  content: z.string(),
  isUpdate: z.boolean(),
  existingSkillId: z.string().optional(),
});

export type SkillDraft = z.infer<typeof SkillDraftSchema>;

export const GenerateSkillDraftsOutputSchema = z.object({
  skills: z.array(SkillDraftSchema),
});

export type GenerateSkillDraftsOutput = z.infer<
  typeof GenerateSkillDraftsOutputSchema
>;

// ─── Input schemas ────────────────────────────────────────────────────────────

const CreditAssignmentInputSchema = z.object({
  currentTrace: z.string(), // JSON-serialized ExecutionTrace
  historicalTraces: z.string(), // JSON-serialized ExecutionTrace[] (train set)
  dagStructure: z.string(), // JSON-serialized task dependency map
  workflowName: z.string(),
});

const GenerateSkillDraftsInputSchema = z.object({
  creditResult: z.string(), // JSON-serialized CreditResult
  taskTraces: z.string(), // JSON-serialized TaskTrace[] for low-scoring tasks
  existingSkills: z.string(), // JSON-serialized SkillRecord[] (current active skills for those tasks)
  heldOutTraces: z.string(), // JSON-serialized ExecutionTrace[] (test set for generalization check)
  skillThreshold: z.number(),
  workflowName: z.string(),
});

// ─── Agent: creditAssignmentAgent ─────────────────────────────────────────────

/**
 * LLM agent (opus-tier) that assigns credit/blame to each task in the DAG.
 *
 * PROMPT DESIGN RATIONALE:
 *
 * The credit assignment problem is fundamentally about separating task-level
 * responsibility from inherited context. A task can fail for two reasons:
 *   1. It received bad input from an upstream task (not its fault).
 *   2. It processed valid input poorly (its fault).
 *
 * The prompt explicitly asks the LLM to distinguish these cases and do
 * "backpropagation" — tracing downstream failures back to their upstream root
 * causes. This prevents unjustly penalizing tasks that were set up to fail.
 *
 * Train/test split awareness: the agent only sees 60% of historical traces
 * (training set). The held-out 40% is used downstream in skill generation to
 * check that new skills generalize beyond the training cases.
 *
 * The output is Zod-validated — raw LLM text never reaches downstream agents.
 */
export const creditAssignmentAgent = defineAgent({
  runner: "api",
  model: "claude-opus-4-5",
  input: CreditAssignmentInputSchema,
  output: CreditResultSchema,
  sanitizeInput: true,
  prompt: ({ currentTrace, historicalTraces, dagStructure, workflowName }) =>
    `
You are an expert AI systems analyst performing DAG-aware credit assignment for the workflow: "${workflowName}".

Your task is to analyze a completed workflow execution and assign credit/blame scores to each task in the DAG, using principles similar to backpropagation in neural networks.

## Current Execution Trace
${currentTrace}

## Historical Traces (Training Set — 60% of available data)
These are past runs of the same workflow. You are seeing only a training subset to ensure your analysis generalizes beyond specific cases.
${historicalTraces}

## DAG Structure
${dagStructure}

## Credit Assignment Rules

### Core Principle: Separate Task Responsibility from Inherited Context
A task that failed may have done so because:
1. **Upstream cause**: It received bad input from a predecessor task — it did its job correctly given what it received.
2. **Own cause**: It produced poor output despite receiving adequate input — the task itself underperformed.

You MUST distinguish between these. Do not penalize a task for failures that originated upstream.

### Backpropagation Algorithm
Walk the DAG in reverse topological order (leaves first, roots last):
1. Start with the final workflow outcome (success/fail + quality signals from feedback if present).
2. For each leaf task: assign initial score based on its direct output quality.
3. For each intermediate task: consider (a) its own output quality AND (b) whether downstream failures trace back to this task's output.
4. Delayed feedback (in trace.feedback[]) outweighs immediate success/fail signals — weight it 2x when they conflict.

### Credit Weight
creditWeight represents this task's proportional contribution to the overall workflow result (sum of weights ≈ 1.0 across all tasks). Tasks with more downstream dependents carry more weight.

### Diagnosis Requirements
For each task, write a precise diagnosis:
- What specifically went right or wrong in THIS task's output?
- Is the root cause here, or was this task a victim of upstream failure?
- Cite specific evidence from the trace (output content, token counts, error messages).

### Improvement Hints
improvementHint should be actionable and GENERALIZABLE — describe what kind of skill injection would help this task class perform better. Not a case-specific fix — a reusable improvement direction.

### Train/Test Awareness
You are analyzing a TRAINING subset of historical traces. Your credit assignment must generalize to new runs, not memorize these specific cases. Look for patterns across multiple traces, not one-off occurrences.

## Output Format
Respond with a JSON object matching this exact schema:
{
  "workflowScore": <number 0-1, overall workflow quality>,
  "taskScores": {
    "<taskName>": {
      "score": <number 0-1, task-level quality>,
      "creditWeight": <number 0-1, proportional contribution>,
      "diagnosis": "<precise explanation citing evidence>",
      "improvementHint": "<generalizable improvement direction>"
    }
  },
  "workflowLevelInsight": "<optional: DAG-level pattern observed across historical traces>"
}
`.trim(),
});

// ─── Agent: generateSkillDraftsAgent ─────────────────────────────────────────

/**
 * LLM agent (sonnet-tier, execution) that generates new/updated SkillRecord content.
 *
 * PROMPT DESIGN RATIONALE:
 *
 * This agent only fires for tasks that scored below the threshold (default 0.7).
 * It receives the credit assignment diagnosis + improvement hint, the task's
 * actual traces, and any existing skill content for that task.
 *
 * Key constraints enforced in the prompt:
 *   1. GENERALIZABILITY: Skills must work across diverse inputs, not just fix
 *      the specific failure seen in training traces.
 *   2. PRESERVATION: When updating an existing skill, preserve what works —
 *      only improve the specific aspect identified in the diagnosis.
 *   3. VALIDATION: The held-out traces are shown so the agent can self-check
 *      whether its generated skill would have helped those unseen cases.
 *   4. MARKDOWN FORMAT: Skills are plain markdown — human-readable, LLM-readable,
 *      git-diffable. No code execution, no dynamic imports.
 *
 * The output schema is strict: taskName + skillName + description + content.
 * The content field is the actual markdown injected into the agent's system prompt.
 */
export const generateSkillDraftsAgent = defineAgent({
  runner: "api",
  model: "claude-sonnet-4-5",
  input: GenerateSkillDraftsInputSchema,
  output: GenerateSkillDraftsOutputSchema,
  sanitizeInput: true,
  prompt: ({
    creditResult,
    taskTraces,
    existingSkills,
    heldOutTraces,
    skillThreshold,
    workflowName,
  }) =>
    `
You are an expert prompt engineer generating skill injections for AI agents in the workflow: "${workflowName}".

A "skill" is a markdown text block injected into an agent's system prompt to improve its performance. Skills are data, not code — the agent reads and follows the instructions.

## Credit Assignment Results
${creditResult}

## Task Traces for Low-Scoring Tasks (score < ${skillThreshold})
These are the actual inputs, outputs, and errors for the tasks that need improvement.
${taskTraces}

## Existing Skills (Current Active Skills for These Tasks)
${existingSkills}

## Held-Out Validation Traces (Unseen Test Cases)
These traces were NOT used for credit assignment. Use them to validate that your generated skills would generalize — they should help on these cases too, not just the training cases above.
${heldOutTraces}

## Skill Generation Rules

### Only Generate Skills for Low-Scoring Tasks
Only produce skills for tasks with score < ${skillThreshold}. Skip high-performing tasks.

### Generalizability Requirement (CRITICAL)
Skills MUST work across diverse inputs, not just patch the specific failure you see in the training traces. Before finalizing a skill, mentally apply it to the held-out validation traces. If it only helps the specific training case, rewrite it to be more general.

Ask yourself: "Would this skill help a competent agent across different inputs, or is it just a one-off fix?"

### When Updating Existing Skills
- READ the existing skill content carefully.
- PRESERVE everything that works — only modify the specific aspect the diagnosis identifies as problematic.
- DO NOT rewrite a skill from scratch unless the diagnosis indicates the existing approach is fundamentally flawed.
- Increment the conceptual version in the skill name (e.g., v1 → v2).

### When Creating New Skills
- Focus on the root cause identified in the diagnosis, not symptoms.
- Write clear, actionable instructions the agent can follow.
- Include concrete examples where helpful (e.g., preferred output format, decision criteria).
- Keep skills focused — one skill per failure mode. Do not bundle multiple improvement areas.

### Skill Content Format
Write skills as markdown. Structure:
- Start with a brief context sentence ("When analyzing root causes...")
- List concrete instructions (bullet points preferred)
- Include anti-patterns to avoid if relevant
- Keep concise — 100-300 words is ideal. Longer is not better.

### Self-Validation Step
For each skill you generate, check: "Would this skill have improved performance on the held-out validation traces?" If no, revise until it would.

## Output Format
Respond with a JSON object matching this schema:
{
  "skills": [
    {
      "taskName": "<task name>",
      "skillName": "<descriptive-name-v1>",
      "description": "<one sentence: what this skill improves, used for retrieval>",
      "content": "<markdown skill content to inject into agent system prompt>",
      "isUpdate": <true if updating existing skill, false if new>,
      "existingSkillId": "<uuid of existing skill if isUpdate=true>"
    }
  ]
}

Only include tasks that need new or updated skills (score < ${skillThreshold}).
If all tasks are performing well, return { "skills": [] }.
`.trim(),
});

// ─── Reflection Workflow ──────────────────────────────────────────────────────

export const reflectionWorkflow = defineWorkflow({
  name: "__ageflow_reflection",
  tasks: {
    creditAssignment: {
      agent: creditAssignmentAgent,
      input: {
        currentTrace: "",
        historicalTraces: "",
        dagStructure: "",
        workflowName: "",
      },
    },
    generateSkills: {
      agent: generateSkillDraftsAgent,
      dependsOn: ["creditAssignment"] as const,
      input: (ctx: BoundCtx<["creditAssignment"]>) => {
        // creditAssignment output is injected at runtime via runReflection()
        // We access the credit result from ctx
        const credit = ctx.creditAssignment.output as CreditResult;
        return {
          creditResult: JSON.stringify(credit),
          taskTraces: "",
          existingSkills: "",
          heldOutTraces: "",
          skillThreshold: DEFAULT_THRESHOLDS.reflectionThreshold,
          workflowName: "",
        };
      },
    },
  },
});

// ─── runReflection() helper ───────────────────────────────────────────────────

export interface ReflectionInput {
  /** The current execution trace to reflect on. */
  currentTrace: ExecutionTrace;
  /** Task dependency map (taskName → list of dependsOn task names). */
  dagStructure: Record<string, readonly string[]>;
  /** Stores for reading historical traces + writing new skills. */
  skillStore: SkillStore;
  traceStore: TraceStore;
  /** Score threshold — tasks below this get skill generation. Default: 0.7 */
  skillThreshold?: number;
  /** Model override for credit assignment agent. Default: claude-opus-4-5 */
  creditModel?: string;
  /** Model override for skill generation agent. Default: claude-sonnet-4-5 */
  skillModel?: string;
}

export interface ReflectionSummary {
  workflowScore: number;
  skillsGenerated: number;
  skillsUpdated: number;
  tasksReflected: string[];
  taskScores: Record<string, number>;
}

/**
 * Run the reflection workflow for a completed execution trace.
 *
 * Steps:
 *   1. Fetch historical traces from the store.
 *   2. Split 60/40 train/test.
 *   3. Serialize everything and run reflectionWorkflow via WorkflowExecutor.
 *   4. Parse credit assignment results.
 *   5. For each low-scoring task, save a new/updated SkillRecord to the store.
 *   6. Return a summary.
 */
export async function runReflection(
  input: ReflectionInput,
): Promise<ReflectionSummary> {
  const threshold =
    input.skillThreshold ?? DEFAULT_THRESHOLDS.reflectionThreshold;

  // 1. Fetch historical traces (excluding the current one)
  const allHistorical = await input.traceStore.getTraces({
    workflowName: input.currentTrace.workflowName,
    limit: 50,
  });
  const historical = allHistorical.filter(
    (t) => t.id !== input.currentTrace.id,
  );

  // 2. Split 60/40 train/test
  const splitIndex = Math.ceil(historical.length * TRAIN_SPLIT);
  const trainSet = historical.slice(0, splitIndex);
  const testSet = historical.slice(splitIndex);

  // 3. Serialize inputs for credit assignment
  const currentTraceJson = JSON.stringify(input.currentTrace);
  const trainSetJson = JSON.stringify(trainSet);
  const dagJson = JSON.stringify(input.dagStructure);

  // 4. Run credit assignment via WorkflowExecutor
  //    We build a workflow with dynamic inputs baked in at the task level.
  const dynamicWorkflow = defineWorkflow({
    name: "__ageflow_reflection",
    tasks: {
      creditAssignment: {
        agent: {
          ...creditAssignmentAgent,
          ...(input.creditModel ? { model: input.creditModel } : {}),
        },
        input: {
          currentTrace: currentTraceJson,
          historicalTraces: trainSetJson,
          dagStructure: dagJson,
          workflowName: input.currentTrace.workflowName,
        },
      },
      generateSkills: {
        agent: {
          ...generateSkillDraftsAgent,
          ...(input.skillModel ? { model: input.skillModel } : {}),
        },
        dependsOn: ["creditAssignment"] as const,
        input: async (ctx: BoundCtx<["creditAssignment"]>) => {
          const credit = ctx.creditAssignment.output as CreditResult;

          // Collect task traces for low-scoring tasks only
          const lowScoringTasks = Object.entries(credit.taskScores)
            .filter(([, ts]) => ts.score < threshold)
            .map(([name]) => name);

          const lowTaskTraces: TaskTrace[] =
            input.currentTrace.taskTraces.filter((tt) =>
              lowScoringTasks.includes(tt.taskName),
            );

          // Fetch existing skills for those tasks
          const existingSkillsPromises = lowScoringTasks.map((taskName) =>
            input.skillStore.getActiveForTask(
              taskName,
              input.currentTrace.workflowName,
            ),
          );
          const existingSkillsResolved = await Promise.all(
            existingSkillsPromises,
          );
          const existingSkills = existingSkillsResolved.filter(
            (s): s is SkillRecord => s !== null,
          );

          return {
            creditResult: JSON.stringify(credit),
            taskTraces: JSON.stringify(lowTaskTraces),
            existingSkills: JSON.stringify(existingSkills),
            heldOutTraces: JSON.stringify(testSet),
            skillThreshold: threshold,
            workflowName: input.currentTrace.workflowName,
          };
        },
      },
    },
  });

  const executor = new WorkflowExecutor(dynamicWorkflow);
  const result = await executor.run();

  // 5. Parse results
  const creditOutput = result.outputs.creditAssignment as CreditResult;
  const skillsOutput = result.outputs
    .generateSkills as GenerateSkillDraftsOutput;

  // 6. Save new/updated skills to store
  let skillsGenerated = 0;
  let skillsUpdated = 0;

  for (const draft of skillsOutput.skills) {
    // Find existing skill to determine lineage
    const existing =
      draft.isUpdate && draft.existingSkillId
        ? await input.skillStore.get(draft.existingSkillId)
        : null;

    const newVersion = existing ? existing.version + 1 : 1;

    const skillRecord: SkillRecord = {
      id: crypto.randomUUID(),
      name: draft.skillName,
      description: draft.description,
      content: draft.content,
      targetAgent: draft.taskName,
      targetWorkflow: input.currentTrace.workflowName,
      version: newVersion,
      status: "active",
      score: 0.5, // neutral starting score — will be updated after real runs
      runCount: 0,
      bestInLineage: true, // starts as best until proven otherwise
      createdAt: new Date().toISOString(),
      ...(draft.existingSkillId ? { parentId: draft.existingSkillId } : {}),
    };

    // If updating, retire the old version
    if (draft.isUpdate && draft.existingSkillId) {
      await input.skillStore.retire(draft.existingSkillId);
      skillsUpdated++;
    } else {
      skillsGenerated++;
    }

    await input.skillStore.save(skillRecord);
  }

  // 7. Build summary
  const taskScores: Record<string, number> = {};
  for (const [taskName, ts] of Object.entries(creditOutput.taskScores)) {
    taskScores[taskName] = ts.score;
  }

  return {
    workflowScore: creditOutput.workflowScore,
    skillsGenerated,
    skillsUpdated,
    tasksReflected: Object.keys(creditOutput.taskScores),
    taskScores,
  };
}
