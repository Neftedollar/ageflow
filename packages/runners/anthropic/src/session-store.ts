/**
 * session-store.ts
 *
 * AnthropicSessionStore interface and in-memory implementation.
 * Stores conversation history as AnthropicMessage arrays, keyed by session handle.
 */

import type { AnthropicMessage } from "./anthropic-types.js";

export interface AnthropicSessionStore {
  get(handle: string): Promise<AnthropicMessage[] | undefined>;
  set(handle: string, messages: AnthropicMessage[]): Promise<void>;
  delete(handle: string): Promise<void>;
}

/**
 * Default session store. Map<handle, AnthropicMessage[]>, process-local.
 * Stores deep-cloned copies so external mutation of message objects
 * cannot silently rewrite recorded history.
 */
export class InMemoryAnthropicSessionStore implements AnthropicSessionStore {
  private readonly data = new Map<string, AnthropicMessage[]>();

  async get(handle: string): Promise<AnthropicMessage[] | undefined> {
    const got = this.data.get(handle);
    return got ? structuredClone(got) : undefined;
  }

  async set(handle: string, messages: AnthropicMessage[]): Promise<void> {
    this.data.set(handle, structuredClone(messages));
  }

  async delete(handle: string): Promise<void> {
    this.data.delete(handle);
  }
}
