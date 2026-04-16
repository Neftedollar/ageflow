import { describe, expect, it } from "vitest";
import { ErrorCode, McpServerError, formatErrorResult } from "../errors.js";

describe("McpServerError + formatErrorResult", () => {
  it("creates a structured error result", () => {
    const err = new McpServerError(ErrorCode.BUDGET_EXCEEDED, "spent $1.23", {
      spent: 1.23,
      limit: 1.0,
      lastTask: "verify",
    });
    const result = formatErrorResult(err);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      errorCode: "BUDGET_EXCEEDED",
      message: "spent $1.23",
      context: { spent: 1.23, limit: 1.0, lastTask: "verify" },
    });
    expect(result.content[0]?.text).toContain("spent $1.23");
  });

  it("wraps unknown errors as WORKFLOW_FAILED", () => {
    const err = new Error("something broke");
    const result = formatErrorResult(err);
    expect(result.structuredContent.errorCode).toBe("WORKFLOW_FAILED");
    expect(result.structuredContent.message).toBe("something broke");
  });

  it("handles non-Error values safely", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing non-Error input
    const result = formatErrorResult("string error" as any);
    expect(result.structuredContent.errorCode).toBe("WORKFLOW_FAILED");
    expect(result.structuredContent.message).toBe("string error");
  });
});
