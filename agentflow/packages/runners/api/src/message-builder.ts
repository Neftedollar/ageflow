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
