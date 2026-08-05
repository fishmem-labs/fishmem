import type {
  EvaluatedFact,
  FactMatcher,
  InferenceCaseResult,
  InferenceQualityCase,
  InferenceQualitySummary,
} from "./schema.js";

function normalized(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function containsFragment(text: string, fragment: string): boolean {
  const needle = normalized(fragment);
  if (!needle) return false;
  if (/^[\p{L}\p{N}_-]+$/u.test(needle)) {
    return new RegExp(
      `(?:^|[^\\p{L}\\p{N}_])${escapedRegExp(needle)}(?:$|[^\\p{L}\\p{N}_])`,
      "u",
    ).test(text);
  }
  return text.includes(needle);
}

export function matchesFact(
  matcher: FactMatcher,
  fact: EvaluatedFact,
): boolean {
  const text = normalized(fact.text);
  if (matcher.allText?.some((fragment) => !containsFragment(text, fragment))) {
    return false;
  }
  if (
    matcher.anyText?.length &&
    !matcher.anyText.some((fragment) => containsFragment(text, fragment))
  ) {
    return false;
  }
  if (
    matcher.subject !== undefined &&
    normalized(fact.subject) !== normalized(matcher.subject)
  ) {
    return false;
  }
  if (
    matcher.attribute !== undefined &&
    normalized(fact.attribute) !== normalized(matcher.attribute)
  ) {
    return false;
  }
  if (
    matcher.memoryTypes?.length &&
    !matcher.memoryTypes.includes(fact.memoryType)
  ) {
    return false;
  }
  return true;
}

/** Maximum bipartite match so one broad fact cannot satisfy two requirements. */
function maximumRequiredMatches(
  matchers: readonly FactMatcher[],
  facts: readonly EvaluatedFact[],
): number {
  const ownerByFact = new Array<number>(facts.length).fill(-1);

  const assign = (matcherIndex: number, visited: Set<number>): boolean => {
    for (let factIndex = 0; factIndex < facts.length; factIndex++) {
      if (
        visited.has(factIndex) ||
        !matchesFact(matchers[matcherIndex]!, facts[factIndex]!)
      ) {
        continue;
      }
      visited.add(factIndex);
      const previousOwner = ownerByFact[factIndex]!;
      if (previousOwner === -1 || assign(previousOwner, visited)) {
        ownerByFact[factIndex] = matcherIndex;
        return true;
      }
    }
    return false;
  };

  let matched = 0;
  for (let matcherIndex = 0; matcherIndex < matchers.length; matcherIndex++) {
    if (assign(matcherIndex, new Set())) matched++;
  }
  return matched;
}

export function evaluateInferenceCase(input: {
  testCase: InferenceQualityCase;
  facts: EvaluatedFact[];
  latencyMs: number;
  error?: string;
}): InferenceCaseResult {
  const requiredMatched = maximumRequiredMatches(
    input.testCase.required.map((required) => required.match),
    input.facts,
  );
  const forbidden = input.testCase.forbidden ?? [];
  const forbiddenMatched = forbidden.filter((matcher) =>
    input.facts.some((fact) => matchesFact(matcher, fact)),
  ).length;
  const minFacts = input.testCase.minFacts ?? input.testCase.required.length;
  const countCompliant =
    input.facts.length >= minFacts &&
    input.facts.length <= input.testCase.maxFacts;
  const passed =
    !input.error &&
    requiredMatched === input.testCase.required.length &&
    forbiddenMatched === 0 &&
    countCompliant;

  return {
    id: input.testCase.id,
    category: input.testCase.category,
    critical: input.testCase.critical ?? false,
    facts: input.facts,
    requiredMatched,
    requiredTotal: input.testCase.required.length,
    forbiddenMatched,
    forbiddenTotal: forbidden.length,
    countCompliant,
    passed,
    latencyMs: input.latencyMs,
    ...(input.error ? { error: input.error } : {}),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

export function summarizeInferenceQuality(
  testCases: readonly InferenceQualityCase[],
  results: readonly InferenceCaseResult[],
): InferenceQualitySummary {
  const byId = new Map(testCases.map((testCase) => [testCase.id, testCase]));
  const requiredMatched = results.reduce(
    (sum, result) => sum + result.requiredMatched,
    0,
  );
  const requiredTotal = results.reduce(
    (sum, result) => sum + result.requiredTotal,
    0,
  );
  const forbiddenMatched = results.reduce(
    (sum, result) => sum + result.forbiddenMatched,
    0,
  );
  const forbiddenTotal = results.reduce(
    (sum, result) => sum + result.forbiddenTotal,
    0,
  );
  const noMemoryResults = results.filter(
    (result) => byId.get(result.id)?.maxFacts === 0,
  );
  const noMemoryCorrect = noMemoryResults.filter(
    (result) => !result.error && result.facts.length === 0,
  ).length;
  const unwantedFacts = results.reduce(
    (sum, result) =>
      sum + Math.max(0, result.facts.length - result.requiredMatched),
    0,
  );
  const criticalLeakCount = results.filter((result) => {
    const testCase = byId.get(result.id);
    if (!testCase?.critical) return false;
    return (
      result.forbiddenMatched > 0 || result.facts.length > testCase.maxFacts
    );
  }).length;

  return {
    cases: results.length,
    passedCases: results.filter((result) => result.passed).length,
    casePassRate: ratio(
      results.filter((result) => result.passed).length,
      results.length,
    ),
    requiredMatched,
    requiredTotal,
    requiredRecall: ratio(requiredMatched, requiredTotal),
    forbiddenMatched,
    forbiddenTotal,
    forbiddenLeakRate: ratio(forbiddenMatched, forbiddenTotal),
    criticalLeakCount,
    countCompliantCases: results.filter((result) => result.countCompliant)
      .length,
    countCompliance: ratio(
      results.filter((result) => result.countCompliant).length,
      results.length,
    ),
    noMemoryCases: noMemoryResults.length,
    noMemoryCorrect,
    noMemoryAccuracy: ratio(noMemoryCorrect, noMemoryResults.length),
    unwantedFacts,
    totalFacts: results.reduce((sum, result) => sum + result.facts.length, 0),
    failedCases: results.filter((result) => result.error).length,
  };
}
