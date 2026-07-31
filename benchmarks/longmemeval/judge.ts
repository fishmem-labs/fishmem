/**
 * Official LongMemEval QA judge, ported from
 * https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py
 *
 * The prompt templates below are quoted VERBATIM from `get_anscheck_prompt`
 * (Python `str.format` slots `{}` become the question / answer / response
 * interpolations, in that order — everything else, including the stray space
 * before "\n\nQuestion:" in two of the templates, is preserved byte-for-byte).
 *
 * Official protocol details replicated here:
 *  - single user message, n=1, temperature=0, max_tokens=10;
 *  - verdict is `'yes' in response.lower()` (substring check);
 *  - abstention variant is selected when '_abs' is in the question_id;
 *  - official default metric model: gpt-4o (gpt-4o-2024-08-06).
 */
import type { LLM } from "../../packages/fishmem/src/index.js";
import type { LongMemEvalQuestionType } from "./types.js";

/**
 * Port of `get_anscheck_prompt(task, question, answer, response, abstention)`.
 * `answer` is the gold answer (the explanation for abstention questions, the
 * rubric for single-session-preference).
 */
export function buildJudgePrompt(
  task: LongMemEvalQuestionType,
  question: string,
  answer: string,
  response: string,
  abstention: boolean,
): string {
  if (!abstention) {
    if (
      task === "single-session-user" ||
      task === "single-session-assistant" ||
      task === "multi-session"
    ) {
      return (
        "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. " +
        `\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
      );
    }
    if (task === "temporal-reasoning") {
      return (
        "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. " +
        `\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
      );
    }
    if (task === "knowledge-update") {
      return (
        "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer." +
        `\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
      );
    }
    if (task === "single-session-preference") {
      return (
        "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly." +
        `\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
      );
    }
    // Mirrors the official `raise NotImplementedError`.
    throw new Error(`NotImplementedError: unknown question_type "${task}"`);
  }
  return (
    "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not." +
    `\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`
  );
}

export interface JudgeVerdict {
  label: "yes" | "no";
  raw: string;
}

/** Run one judge call with the official sampling parameters and verdict rule. */
export async function judgeAnswer(
  llm: LLM,
  task: LongMemEvalQuestionType,
  question: string,
  goldAnswer: string,
  hypothesis: string,
  abstention: boolean,
): Promise<JudgeVerdict> {
  const prompt = buildJudgePrompt(
    task,
    question,
    goldAnswer,
    hypothesis,
    abstention,
  );
  const raw = (
    await llm.chat([{ role: "user", content: prompt }], {
      temperature: 0,
      maxTokens: 10,
    })
  ).trim();
  // Official: label = 'yes' in eval_response.lower()
  return { label: raw.toLowerCase().includes("yes") ? "yes" : "no", raw };
}
