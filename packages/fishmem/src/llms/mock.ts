import type { Message } from "../types.js";
import type { LLM, LLMChatOptions } from "./base.js";

export type MockResponder = (
  messages: Message[],
  options?: LLMChatOptions,
) => string;

/**
 * Offline LLM for tests and zero-config runs.
 *
 * By default it recognises fishmem's internal task via the `FISHMEM_TASK:`
 * marker embedded in the system prompt:
 *  - `extract`: naive sentence/line splitting of the user content into facts.
 *
 * Pass a custom `responder` to script exact responses in tests.
 */
export class MockLLM implements LLM {
  private readonly responder?: MockResponder;

  constructor(responder?: MockResponder) {
    this.responder = responder;
  }

  async chat(messages: Message[], options?: LLMChatOptions): Promise<string> {
    if (this.responder) return this.responder(messages, options);

    const joined = messages.map((m) => m.content).join("\n");
    if (joined.includes("FISHMEM_TASK: extract")) {
      return JSON.stringify({ facts: extractFacts(messages) });
    }
    // Fallback: echo last user message.
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    return lastUser?.content ?? "";
  }
}

function extractFacts(messages: Message[]): string[] {
  // Use the last user message as the content to distil.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  // Extraction receives a role-prefixed transcript. Strip those transport
  // labels so the mock mirrors a real model's semantic output.
  const text = (lastUser?.content ?? "").replace(
    /^(?:system|user|assistant|tool):\s*/gmu,
    "",
  );
  return text
    .split(/[\n.!?。！？]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
