export const ErrorCode = {
  INPUT_VALIDATION_FAILED: "INPUT_VALIDATION_FAILED",
  OUTPUT_VALIDATION_FAILED: "OUTPUT_VALIDATION_FAILED",
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  DURATION_EXCEEDED: "DURATION_EXCEEDED",
  TURNS_EXCEEDED: "TURNS_EXCEEDED",
  WORKFLOW_FAILED: "WORKFLOW_FAILED",
  HITL_ELICITATION_UNSUPPORTED: "HITL_ELICITATION_UNSUPPORTED",
  HITL_DENIED: "HITL_DENIED",
  HITL_CANCELLED: "HITL_CANCELLED",
  WORKFLOW_NOT_MCP_EXPOSABLE: "WORKFLOW_NOT_MCP_EXPOSABLE",
  RUNNER_PREFLIGHT_FAILED: "RUNNER_PREFLIGHT_FAILED",
  BUSY: "BUSY",
  SERVER_SHUTDOWN: "SERVER_SHUTDOWN",
  DAG_INVALID: "DAG_INVALID",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class McpServerError extends Error {
  constructor(
    public readonly errorCode: ErrorCodeValue,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "McpServerError";
  }
}

export interface McpToolErrorResult {
  readonly content: readonly { type: "text"; text: string }[];
  readonly structuredContent: {
    readonly errorCode: ErrorCodeValue;
    readonly message: string;
    readonly context?: Record<string, unknown>;
  };
  readonly isError: true;
}

export function formatErrorResult(err: unknown): McpToolErrorResult {
  if (err instanceof McpServerError) {
    return {
      content: [{ type: "text", text: err.message }],
      structuredContent: {
        errorCode: err.errorCode,
        message: err.message,
        context: err.context,
      },
      isError: true,
    };
  }

  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : JSON.stringify(err);

  return {
    content: [{ type: "text", text: message }],
    structuredContent: {
      errorCode: ErrorCode.WORKFLOW_FAILED,
      message,
    },
    isError: true,
  };
}
