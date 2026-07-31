import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

export const CONTEXT_TOKENIZER = "o200k_base";

/** Count benchmark context with one fixed, disclosed encoding across systems. */
export function countContextTokens(context: string): number {
  return context.length === 0 ? 0 : countTokens(context);
}
