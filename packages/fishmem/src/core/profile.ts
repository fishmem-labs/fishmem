import type { MemoryWarningCode, MemoryWarningHandler } from "../config.js";
import type { GraphStore } from "../graph/base.js";
import type { LLM } from "../llms/base.js";
import type { MemoryFilters } from "../types.js";

/**
 * Profile blocks (Letta "core memory" / Memobase profile slots / Mastra
 * observational memory): a compact, always-injectable synthesis of what is
 * known about a scope (user/agent/run). Retrieval surfaces point facts;
 * the profile carries identity, preferences, goals, and per-topic
 * aggregations ("Paintings: horse, sunset, sunrise") that top-k retrieval
 * structurally misses on enumeration and inference questions.
 *
 * Persistence: one reserved row per scope in the regular memories table
 * (deterministic id, `forgotten: true` so it never appears in recall) —
 * zero schema changes, works on every GraphStore.
 */

export const PROFILE_SYNTHESIS_SYSTEM = `You are a memory profile synthesizer.
FISHMEM_TASK: profile

You are given dated memory entries about one or more people. Write a compact
knowledge profile in markdown that captures the durable picture:

- One section per person (### Name).
- Bullet groups per topic: Identity, Relationships & family, Work & goals,
  Preferences & personality, Activities & hobbies, Possessions & pets,
  Key events (with dates, most recent last).
- AGGREGATE exhaustively: when several memories list items of the same kind
  (paintings, pets, instruments, trips), produce ONE bullet enumerating ALL
  items ("Paintings: a horse, a sunset (Oct 2023), a sunrise").
- Keep dates in "Key events". Resolve contradictions in favour of the most
  recent memory, noting the change ("moved to Berlin in Jun 2023; previously
  Paris").
- Be faithful: only what the memories support. No speculation.
- Maximum ~400 words. Plain markdown, no preamble.`;

export interface ProfileConfig {
  /** Max memories fed into one synthesis pass. */
  maxSourceMemories: number;
  /** Max characters of the stored profile. */
  maxProfileChars: number;
  /** Default number of profile sections returned by query-time recall. */
  maxSections: number;
}

export const DEFAULT_PROFILE_CONFIG: ProfileConfig = {
  maxSourceMemories: 200,
  maxProfileChars: 6000,
  maxSections: 3,
};

export interface ProfileSection {
  id: string;
  title: string;
  content: string;
  score: number;
}

/** Deterministic reserved-row id for a scope's profile. */
export function profileRowId(filters: MemoryFilters): string {
  return `fishmem-profile:${filters.namespaceId ?? ""}:${filters.userId ?? ""}:${filters.agentId ?? ""}:${filters.runId ?? ""}`;
}

export class ProfileManager {
  private readonly config: ProfileConfig;

  constructor(
    private readonly store: GraphStore,
    private readonly llm: LLM,
    config: Partial<ProfileConfig> = {},
    private readonly onWarning?: MemoryWarningHandler,
  ) {
    this.config = { ...DEFAULT_PROFILE_CONFIG, ...config };
  }

  private warn(
    code: MemoryWarningCode,
    message: string,
    error?: unknown,
    context?: Record<string, unknown>,
  ): void {
    this.onWarning?.({
      code,
      message,
      recoverable: true,
      error,
      context,
    });
  }

  /** The current profile text for a scope, or null if never synthesized. */
  async get(filters: MemoryFilters): Promise<string | null> {
    const row = await this.store.getMemory(profileRowId(filters));
    return row?.content ?? null;
  }

  /** Parse the stored profile into query-addressable sections. */
  async sections(filters: MemoryFilters): Promise<ProfileSection[]> {
    const profile = await this.get(filters);
    if (!profile) return [];
    return parseProfileSections(profile, profileRowId(filters)).map((s) => ({
      ...s,
      score: 0,
    }));
  }

  /**
   * Return the profile sections whose text best matches the query. Pure
   * lexical scoring: no LLM, no embedding call, and no extra storage.
   */
  async relevantSections(
    query: string,
    filters: MemoryFilters,
    opts: { limit?: number; minScore?: number } = {},
  ): Promise<ProfileSection[]> {
    const sections = await this.sections(filters);
    if (!sections.length) return [];
    const scored = scoreProfileSections(query, sections);
    const minScore = opts.minScore ?? 0.01;
    return scored
      .filter((s) => s.score >= minScore)
      .slice(0, opts.limit ?? this.config.maxSections);
  }

  /**
   * Re-synthesize the profile from the scope's memories (importance-ranked,
   * capped). Returns the new profile text, or null when the scope is empty.
   */
  async refresh(filters: MemoryFilters): Promise<string | null> {
    const memories = await this.store.listMemories(filters, {
      sort: "importance",
      limit: this.config.maxSourceMemories,
    });
    if (memories.length === 0) return null;

    const lines = memories
      .map((m) => {
        const date = m.eventDate
          ? `[${m.eventDate.toISOString().slice(0, 10)}] `
          : "";
        const invalid = m.validTo
          ? ` (no longer true since ${m.validTo.toISOString().slice(0, 10)})`
          : "";
        return `- ${date}${m.content}${invalid}`;
      })
      .join("\n");

    let profile: string;
    try {
      profile = await this.llm.chat(
        [
          { role: "system", content: PROFILE_SYNTHESIS_SYSTEM },
          { role: "user", content: `Memories:\n${lines}` },
        ],
        {
          temperature: 0,
          context: {
            namespaceId: filters.namespaceId,
            operation: "memory.profile.refresh",
          },
        },
      );
    } catch (error) {
      this.warn(
        "profile_refresh_failed",
        "Profile refresh failed; keeping the previous profile.",
        error,
        { ...filters },
      );
      return this.get(filters); // keep the previous profile on LLM failure
    }
    profile = profile.trim().slice(0, this.config.maxProfileChars);
    if (!profile) return this.get(filters);

    await this.persist(filters, profile);
    return profile;
  }

  private async persist(
    filters: MemoryFilters,
    content: string,
  ): Promise<void> {
    const id = profileRowId(filters);
    const existing = await this.store.getMemory(id);
    const now = new Date();
    if (existing) {
      existing.content = content;
      existing.updatedAt = now;
      await this.store.updateMemory(existing);
      return;
    }
    await this.store.saveMemory({
      id,
      content,
      memoryType: "observation",
      importance: 0,
      namespaceId: filters.namespaceId,
      userId: filters.userId,
      agentId: filters.agentId,
      runId: filters.runId,
      source: "fishmem:profile",
      metadata: { "fishmem:profile": true },
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      // Reserved row: forgotten=true keeps it out of search/recall while
      // remaining fetchable by its deterministic id.
      forgotten: true,
      tier: "graph",
    });
  }
}

function parseProfileSections(
  profile: string,
  baseId: string,
): Array<Omit<ProfileSection, "score">> {
  const sections: Array<{ title: string; lines: string[] }> = [];
  let heading = "Profile";
  let current: { title: string; lines: string[] } | null = null;
  let paragraph: { title: string; lines: string[] } | null = null;

  const flushCurrent = () => {
    if (current?.lines.length) sections.push(current);
    current = null;
  };
  const flushParagraph = () => {
    if (paragraph?.lines.length) sections.push(paragraph);
    paragraph = null;
  };

  for (const rawLine of profile.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (headingMatch) {
      flushCurrent();
      flushParagraph();
      heading = headingMatch[1]!.trim();
      continue;
    }

    if (!line.trim()) {
      flushCurrent();
      flushParagraph();
      continue;
    }

    if (/^[-*]\s+/.test(line.trimStart())) {
      flushCurrent();
      flushParagraph();
      const bullet = line.trimStart().replace(/^[-*]\s+/, "");
      const label = bullet.match(/^([^:：]{1,80})[:：]/)?.[1]?.trim();
      current = {
        title: label ? `${heading} / ${label}` : heading,
        lines: [`### ${heading}`, line.trimStart()],
      };
      continue;
    }

    if (current) {
      current.lines.push(line);
    } else {
      paragraph ??= { title: heading, lines: [`### ${heading}`] };
      paragraph.lines.push(line);
    }
  }

  flushCurrent();
  flushParagraph();

  if (!sections.length && profile.trim()) {
    sections.push({ title: "Profile", lines: [profile.trim()] });
  }

  return sections.map((section, i) => ({
    id: `${baseId}:section:${i}`,
    title: section.title,
    content: section.lines.join("\n").trim(),
  }));
}

function scoreProfileSections(
  query: string,
  sections: ProfileSection[],
): ProfileSection[] {
  const queryTerms = termSet(query);
  if (!queryTerms.size) return [];
  return sections
    .map((section) => {
      const sectionTerms = termSet(`${section.title}\n${section.content}`);
      let overlap = 0;
      for (const term of queryTerms) if (sectionTerms.has(term)) overlap++;
      const coverage = overlap / queryTerms.size;
      const exact = section.content.toLowerCase().includes(query.toLowerCase())
        ? 0.25
        : 0;
      return { ...section, score: coverage + exact };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

const PROFILE_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "what",
  "who",
  "where",
  "when",
  "which",
  "does",
  "did",
  "was",
  "were",
  "are",
  "is",
  "has",
  "have",
  "had",
  "about",
  "tell",
  "me",
  "user",
  "person",
  "their",
  "his",
  "her",
  "she",
  "him",
  "they",
]);

function termSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((term) =>
        term.length > 3 && term.endsWith("s") ? term.slice(0, -1) : term,
      )
      .filter((term) => term.length >= 2 && !PROFILE_STOPWORDS.has(term)),
  );
}
