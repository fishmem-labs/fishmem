/**
 * Answer-generation and judging prompts, modeled on mem0's evaluation suite
 * (github.com/mem0ai/mem0, evaluation/) so results are comparable in
 * methodology to the published mem0 LOCOMO numbers.
 */

export const ANSWER_SYSTEM = `You are an intelligent memory assistant tasked with answering a question using ONLY the provided memories about a conversation between two people.

# CONTEXT:
You have access to memories from a conversation. These memories contain timestamped information that may be relevant to answering the question.

# INSTRUCTIONS:
1. Carefully analyze all provided memories.
2. Pay close attention to the timestamps to determine the answer.
3. If the question asks about a specific event or fact, look for direct evidence in the memories.
4. If the memories contain contradictory information, prioritize the most recent memory.
5. If there is a question about time references (like "last year", "two months ago", etc.), calculate the actual date based on the memory timestamp.
6. Always convert relative time references to specific dates, months, or years.
7. Do not confuse character names mentioned in memories with the actual users who created them.
8. The answer should be less than 5-6 words.

# APPROACH (think step by step):
1. Examine all memories that contain information related to the question.
2. Look for explicit mentions of dates, times, locations, or events that answer the question.
3. If the answer requires calculation (e.g., converting relative time references), perform the calculation.
4. Formulate a precise, concise answer based on the evidence in the memories.
5. Double-check that your answer directly addresses the question asked.
6. Ensure your final answer is specific and avoids vague time references.

Respond with the short answer only — no explanation, no preamble.`;

export function buildAnswerUser(context: string, question: string): string {
  return `Memories:

${context}

Question: ${question}

Answer:`;
}

export const JUDGE_SYSTEM = `You are an expert grader. Your task is to label whether a generated answer to a question is CORRECT or WRONG, given the gold answer.

The generated answer does not need to match the gold answer word-for-word. It is CORRECT if it conveys the same essential information needed to answer the question (allow paraphrases, partial dates that match, equivalent phrasings). It is WRONG if it contradicts the gold answer, is unrelated, or says the information is unknown when the gold answer exists.

Respond with a single JSON object: {"label": "CORRECT"} or {"label": "WRONG"}.`;

export function buildJudgeUser(
  question: string,
  goldAnswer: string,
  generated: string,
): string {
  return `Question: ${question}
Gold answer: ${goldAnswer}
Generated answer: ${generated}

Is the generated answer CORRECT or WRONG?`;
}
