import { describe, expect, it } from "vitest";
import { resolveLocomoGold, selectLocomoQuestions } from "../locomo/dataset.js";
import type { LocomoSample } from "../locomo/types.js";

describe("LOCOMO question protocol", () => {
  it("uses answer as gold for categories 1-4", () => {
    expect(
      resolveLocomoGold({
        category: 2,
        question: "When did it happen?",
        answer: 2024,
      }),
    ).toEqual({ answer: "2024", field: "answer" });
  });

  it("uses adversarial_answer as gold for category 5", () => {
    expect(
      resolveLocomoGold({
        category: 5,
        question: "What did Alice never say?",
        adversarial_answer: "Alice never said that.",
      }),
    ).toEqual({
      answer: "Alice never said that.",
      field: "adversarial_answer",
    });
  });

  it("never falls back to answer for category 5", () => {
    expect(
      resolveLocomoGold({
        category: 5,
        question: "Did this unsupported event happen?",
        answer: "No",
        adversarial_answer: "Yes",
      }),
    ).toEqual({ answer: "Yes", field: "adversarial_answer" });
  });

  it("fails when the category-specific gold field is missing", () => {
    expect(() =>
      resolveLocomoGold({
        category: 5,
        question: "Missing adversarial gold",
        answer: "must not be used",
      }),
    ).toThrow(/category 5 requires non-empty adversarial_answer/);
    expect(() =>
      resolveLocomoGold({
        category: 1,
        question: "Missing regular gold",
        adversarial_answer: "must not be used",
      }),
    ).toThrow(/category 1 requires non-empty answer/);
  });

  it("selects category 5 questions with their declared gold source", () => {
    const sample = {
      sample_id: "conversation-1",
      conversation: { speaker_a: "Alice", speaker_b: "Bob" },
      qa: [
        { category: 1, question: "Regular?", answer: "yes" },
        {
          category: 5,
          question: "Adversarial?",
          adversarial_answer: "no evidence",
        },
      ],
    } satisfies LocomoSample;

    expect(selectLocomoQuestions(sample, new Set([5]))).toEqual([
      {
        qa: sample.qa[1],
        questionIndex: 1,
        goldAnswer: "no evidence",
        goldField: "adversarial_answer",
      },
    ]);
  });
});
