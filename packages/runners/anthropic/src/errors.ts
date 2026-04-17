/**
 * errors.ts
 *
 * Re-exports shared errors from runner-api and adds AnthropicRequestError.
 */

export {
  MaxToolRoundsError,
  ToolNotFoundError,
  McpPoolCollisionError,
} from "@ageflow/runner-api";

export { AgentFlowError } from "@ageflow/core";

import { AgentFlowError } from "@ageflow/core";

export class AnthropicRequestError extends AgentFlowError {
  readonly code = "anthropic_request_failed" as const;
  constructor(
    readonly status: number,
    readonly body: string,
    options?: ErrorOptions,
  ) {
    super(`Anthropic API request failed (${status}): ${body}`, options);
  }
}
