/**
 * anthropic-types.ts
 *
 * Type definitions for the Anthropic Messages API (/v1/messages).
 * Covers the subset used by this runner (text, tool_use, tool_result blocks).
 */

// ─── Content blocks ───────────────────────────────────────────────────────────

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock;

// ─── Messages ─────────────────────────────────────────────────────────────────

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
}

export interface UserTextMessage {
  role: "user";
  content: string;
}

export interface UserToolResultMessage {
  role: "user";
  content: ToolResultBlock[];
}

export type AnthropicMessage =
  | AssistantMessage
  | UserTextMessage
  | UserToolResultMessage;

// ─── Tool schemas ─────────────────────────────────────────────────────────────

export interface AnthropicToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

// ─── Extended thinking ────────────────────────────────────────────────────────

export interface ThinkingConfig {
  type: "enabled";
  budget_tokens: number;
}

// ─── Request / Response ───────────────────────────────────────────────────────

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  tools?: AnthropicToolSchema[];
  thinking?: ThinkingConfig;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  model: string;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}
