/**
 * OFFICIAL BEAM prompt strings, extracted byte-for-byte from
 * https://github.com/mohammadtavakoli78/BEAM (MIT-licensed code):
 *
 *  - UNIFIED_LLM_JUDGE_BASE_PROMPT  <- src/prompts.py  `unified_llm_judge_base_prompt`
 *  - ANSWER_GENERATION_FOR_RAG      <- src/prompts.py  `answer_generation_for_rag`
 *  - LLM_EQUIVALENCE_SYSTEM         <- src/evaluation/compute_metrics.py `llm_equivalence`
 *                                      (system message; the "exaplanation" typo is official)
 *
 * This file is GENERATED from the official sources to preserve every byte
 * (including Unicode curly quotes inside the judge prompt and trailing
 * whitespace). Do not reflow or "fix" the text.
 */

/** `unified_llm_judge_base_prompt` — slots: <question> <rubric_item> <llm_response>. */
export const UNIFIED_LLM_JUDGE_BASE_PROMPT =
  '\nYou are an expert evaluator tasked with judging whether the LLM\'s response demonstrates compliance with the specified RUBRIC CRITERION.\n\n## EVALUATION INPUTS\n- QUESTION (what the user asked): <question>\n- RUBRIC CRITERION (what to check): <rubric_item>\n- RESPONSE TO EVALUATE: <llm_response>\n\n## EVALUATION RUBRIC:\nThe rubric defines a specific requirement, constraint, or expected behavior that the LLM response should demonstrate. \n\n**IMPORTANT**: Pay careful attention to whether the rubric specifies:\n- **Positive requirements** (things the response SHOULD include/do)\n- **Negative constraints** (things the response SHOULD NOT include/do, often indicated by "no", "not", "avoid", "absent")\n\n## RESPONSIVENESS REQUIREMENT (anchored to the QUESTION)\nA compliant response must be **on-topic with respect to the QUESTION** and attempt to answer it.\n- If the response does not address the QUESTION, score **0.0** and stop.\n- For negative constraints, both must hold: (a) the response is responsive to the QUESTION, and (b) the prohibited element is absent.\n\n## SEMANTIC TOLERANCE RULES:\nJudge by meaning, not exact wording.\n- Accept **paraphrases** and **synonyms** that preserve intent.\n- **Case/punctuation/whitespace** differences must be ignored.\n- **Numbers/currencies/dates** may appear in equivalent forms (e.g., \u201c$68,000\u201d, \u201c68k\u201d, \u201c68,000 USD\u201d, or \u201csixty-eight thousand dollars\u201d). Treat them as equal when numerically equivalent.\n- If the rubric expects a number or duration, prefer **normalized comparison** (extract and compare values) over string matching.\n\n## STYLE NEUTRALITY (prevents style contamination):\nIgnore tone, politeness, length, and flourish unless the rubric explicitly requires a format/structure (e.g., \u201citemized list\u201d, \u201cno citations\u201d, \u201cone sentence\u201d).\n- Do **not** penalize hedging, voice, or verbosity if content satisfies the rubric.\n- Only evaluate format when the rubric **explicitly** mandates it.\n\n## SCORING SCALE:\n- **1.0 (Complete Compliance)**: Fully complies with the rubric criterion.\n  - Positive: required element present, accurate, properly executed (allowing semantic equivalents).\n  - Negative: prohibited element **absent** AND response is **responsive**.\n  \n- **0.5 (Partial Compliance)**: Partially complies.\n  - Positive: element present but minor inaccuracies/incomplete execution.\n  - Negative: generally responsive and mostly avoids the prohibited element but with minor/edge violations.\n  \n- **0.0 (No Compliance)**: Fails to comply.\n  - Positive: required element missing or incorrect.\n  - Negative: prohibited element present **or** response is non-responsive/evasive even if the element is absent.\n\n## EVALUATION INSTRUCTIONS:\n1. **Understand the Requirement**: Determine if the rubric is asking for something to be present (positive) or absent (negative/constraint).\n\n2. **Parse Compound Statements**: If the rubric contains multiple elements connected by "and" or commas, evaluate whether:\n   - **All elements** must be present for full compliance (1.0)\n   - **Some elements** present indicates partial compliance (0.5)\n   - **No elements** present indicates no compliance (0.0)\n   \n3. **Check Compliance**: \n   - For positive requirements: Look for the presence and quality of the required element\n   - For negative constraints: Look for the absence of the prohibited element\n\n4. **Assign Score**: Based on compliance with the specific rubric criterion according to the scoring scale above.\n\n5. **Provide Reasoning**: Explain whether the rubric criterion was satisfied and justify the score.\n\n## OUTPUT FORMAT:\nReturn your evaluation in JSON format with two fields:\n\n{\n   "score": [your score: 1.0, 0.5, or 0.0],\n   "reason": "[detailed explanation of whether the rubric criterion was satisfied and why this justified the assigned score]"\n}\n\nNOTE: ONLY output the json object, without any explanation before or after that\n';

/** `answer_generation_for_rag` — slots: <context> <question>. */
export const ANSWER_GENERATION_FOR_RAG =
  "\nYou are an assistant that MUST answer questions using ONLY the information provided in the context below. \n\nSTRICT INSTRUCTIONS:\n1. Answer ONLY based on the provided context\n2. Do NOT use your internal knowledge\n\nCONTEXT:\n<context>\n\nQUESTION:\n<question>\n\nANSWER REQUIREMENTS:\n- Be direct and concise\n- Only output the answer to the question without any explanation \n\nRESPONSE:\n";

/** System message of `llm_equivalence` (event-ordering alignment classifier). */
export const LLM_EQUIVALENCE_SYSTEM =
  "\n            You are a binary classifier.\n            If the TWO snippets describe the SAME event/fact, reply **YES**\n            Otherwise reply **NO**. No extra words.\n            DO NOT provide any exaplanation.\n        ";

/**
 * User message of `llm_equivalence`, reproducing the Python f-string
 * (real newlines from the `\n` escapes plus the original indentation):
 *
 *   f"""First snippet: {first_paragraph} \n
 *                          Second snippet: {second_paragraph}
 *                       """
 */
export function llmEquivalenceUser(
  firstParagraph: string,
  secondParagraph: string,
): string {
  return (
    `First snippet: ${firstParagraph} \n\n` +
    `                       Second snippet: ${secondParagraph}\n` +
    `                    `
  );
}
