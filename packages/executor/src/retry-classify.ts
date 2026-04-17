import { TimeoutError } from "@ageflow/core";
import type { RetryErrorKind } from "@ageflow/core";

/**
 * Classify an error thrown from a function task's `execute()` call into a
 * `RetryErrorKind` that can be checked against `retry.on`.
 *
 * Classification rules:
 * - `TimeoutError` → `"timeout"`
 * - Any other thrown `Error` → `"transient"`
 *
 * Note: Zod input/output validation errors are handled BEFORE calling this
 * helper — they use the `"validation"` kind and are never retried regardless
 * of `retry.on`.
 */
export function classifyFnError(
  err: Error,
): Extract<RetryErrorKind, "transient" | "timeout"> {
  if (err instanceof TimeoutError) {
    return "timeout";
  }
  return "transient";
}
