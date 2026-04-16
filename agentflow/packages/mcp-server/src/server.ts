import type { WorkflowDef } from "@ageflow/core";
import { resolveMcpConfig } from "@ageflow/core";
import { composeCeilings } from "./ceiling-resolver.js";
import {
  ErrorCode,
  McpServerError,
  type McpToolErrorResult,
  formatErrorResult,
} from "./errors.js";
import { type McpConnectionLike, buildMcpHooks } from "./hitl-bridge.js";
import { ProgressStreamer, type SendProgress } from "./progress-streamer.js";
import { type ToolDefinition, buildToolDefinition } from "./tool-registry.js";
import type { CliCeilings, EffectiveCeilings, HitlStrategy } from "./types.js";
import { DurationWatchdog } from "./watchdog.js";

export type RunWorkflowFn = (args: {
  workflow: WorkflowDef;
  input: unknown;
  hooks: unknown;
  signal: AbortSignal;
  effective: EffectiveCeilings;
}) => Promise<unknown>;

export interface McpServerOptions {
  readonly workflow: WorkflowDef;
  readonly cliCeilings: CliCeilings;
  readonly hitlStrategy: HitlStrategy;
  /** Custom stderr writer (for testing); defaults to process.stderr.write. */
  readonly stderr?: (line: string) => void;
  /**
   * Executor runner. Defaults to calling `@ageflow/executor`'s WorkflowExecutor.
   * Injected for testing.
   */
  readonly runWorkflow?: RunWorkflowFn;
}

export interface McpToolSuccessResult {
  readonly content: readonly { type: "text"; text: string }[];
  readonly structuredContent: Record<string, unknown>;
  readonly isError: false;
}

export type McpToolResult = McpToolSuccessResult | McpToolErrorResult;

export interface McpServerHandle {
  listTools(): Promise<ToolDefinition[]>;
  callTool(
    name: string,
    args: unknown,
    opts?: {
      connection?: McpConnectionLike;
      progressToken?: string | number;
      sendProgress?: SendProgress;
    },
  ): Promise<McpToolResult>;
  /** Attached by tests only — replaces the real executor invocation. */
  _testRunExecutor?: (
    args: unknown,
    hooks: unknown,
    signal: AbortSignal,
    effective: EffectiveCeilings,
  ) => Promise<unknown>;
}

/**
 * Compose an MCP server around a single workflow.
 *
 * The returned handle exposes listTools/callTool for wiring into the MCP
 * transport layer (stdio). A real implementation would forward these to
 * `@modelcontextprotocol/sdk`'s Server class; this minimal form is testable
 * directly without the transport.
 */
export function createMcpServer(opts: McpServerOptions): McpServerHandle {
  const resolved = resolveMcpConfig(opts.workflow.mcp);
  const stderr =
    opts.stderr ??
    ((line: string) => {
      process.stderr.write(line);
    });
  const tool = buildToolDefinition(opts.workflow);

  let inflight = false;

  const handle: McpServerHandle = {
    async listTools() {
      return [tool];
    },

    async callTool(name, args, callOpts) {
      if (name !== tool.name) {
        return formatErrorResult(
          new McpServerError(
            ErrorCode.WORKFLOW_FAILED,
            `unknown tool: ${name}`,
            { name },
          ),
        );
      }

      if (inflight) {
        return formatErrorResult(
          new McpServerError(
            ErrorCode.BUSY,
            "Another workflow run is in progress",
          ),
        );
      }
      inflight = true;

      try {
        // Validate input
        const inputTaskDef = (opts.workflow.tasks as Record<string, unknown>)[
          tool.inputTask
        ] as {
          agent: {
            input: {
              safeParse: (v: unknown) => {
                success: boolean;
                data?: unknown;
                error?: unknown;
              };
            };
          };
        };
        const parsedInput = safeParse(
          inputTaskDef.agent.input,
          args,
          ErrorCode.INPUT_VALIDATION_FAILED,
        );

        // Effective ceilings
        const effective = composeCeilings(resolved, opts.cliCeilings, stderr);

        // Progress streamer
        const streamer = new ProgressStreamer(
          callOpts?.sendProgress ?? (() => {}),
          callOpts?.progressToken,
        );

        // Emit unlimited warnings
        const unlimitedAxes: string[] = [];
        if (effective.maxCostUsd === null) unlimitedAxes.push("cost");
        if (effective.maxDurationSec === null) unlimitedAxes.push("duration");
        if (effective.maxTurns === null) unlimitedAxes.push("turns");
        if (unlimitedAxes.length > 0) streamer.unlimitedWarning(unlimitedAxes);

        // Watchdog
        const watchdog = new DurationWatchdog(effective.maxDurationSec, () => {
          throw new McpServerError(
            ErrorCode.DURATION_EXCEEDED,
            `workflow exceeded maxDurationSec=${effective.maxDurationSec}`,
          );
        });
        watchdog.start();

        // HITL bridge (requires MCP connection)
        const mcpHooks =
          callOpts?.connection !== undefined
            ? buildMcpHooks(
                callOpts.connection,
                opts.hitlStrategy,
                (taskName, message) =>
                  streamer.awaitingElicitation(taskName, message),
                opts.workflow.hooks?.onCheckpoint,
              )
            : undefined;

        // Run executor (delegated; Task 13 wires in the real executor)
        let rawOutput: unknown;
        if (handle._testRunExecutor !== undefined) {
          rawOutput = await handle._testRunExecutor(
            parsedInput,
            mcpHooks,
            watchdog.abortSignal,
            effective,
          );
        } else {
          const runner = opts.runWorkflow ?? defaultRunner;
          rawOutput = await runner({
            workflow: opts.workflow,
            input: parsedInput,
            hooks: mcpHooks,
            signal: watchdog.abortSignal,
            effective,
          });
        }
        watchdog.cancel();

        // Validate output
        const outputTaskDef = (opts.workflow.tasks as Record<string, unknown>)[
          tool.outputTask
        ] as {
          agent: {
            output: {
              safeParse: (v: unknown) => {
                success: boolean;
                data?: unknown;
                error?: unknown;
              };
            };
          };
        };
        const parsedOutput = safeParse(
          outputTaskDef.agent.output,
          rawOutput,
          ErrorCode.OUTPUT_VALIDATION_FAILED,
        );

        return {
          content: [{ type: "text", text: JSON.stringify(parsedOutput) }],
          structuredContent: parsedOutput as Record<string, unknown>,
          isError: false,
        };
      } catch (err) {
        return formatErrorResult(err);
      } finally {
        inflight = false;
      }
    },
  };

  return handle;
}

function safeParse(
  schema: {
    safeParse: (v: unknown) => {
      success: boolean;
      data?: unknown;
      error?: unknown;
    };
  },
  value: unknown,
  errorCode: (typeof ErrorCode)[keyof typeof ErrorCode],
): unknown {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new McpServerError(
      errorCode,
      `schema validation failed: ${String(result.error)}`,
      { error: result.error },
    );
  }
  return result.data;
}

// Placeholder — real executor integration lands in Task 13.
async function defaultRunner(): Promise<unknown> {
  throw new McpServerError(
    ErrorCode.WORKFLOW_FAILED,
    "executor not wired (run Task 13 to integrate)",
  );
}
