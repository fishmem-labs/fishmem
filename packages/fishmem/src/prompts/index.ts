import type { Message } from "../types.js";

/**
 * Fact-extraction prompt. Distils a conversation into a list of atomic,
 * self-contained facts worth remembering. Modelled on mem0's extraction step.
 *
 * The `FISHMEM_TASK:` marker lets the offline MockLLM recognise the task; real
 * models simply ignore it.
 */
export const FACT_EXTRACTION_SYSTEM = `You are a memory extraction engine.
FISHMEM_TASK: extract

Read the conversation and extract atomic, self-contained facts worth
remembering long-term: identities, preferences, decisions, goals, todos,
relationships, possessions, activities, and durable facts or events. Ignore
small talk and ephemeral chatter.

Rules:
- Be exhaustive: extract EVERY distinct fact, not a summary. When a message
  mentions several items (e.g. three pets, two hobbies, multiple people),
  emit one fact per item — never collapse a list into one fact.
- Preserve concrete details VERBATIM: proper names, titles of books/songs/
  shows, performer and brand names, place names, dates, numbers, durations,
  colours. Never replace a specific with a generic ("recommended the novel
  'The Overstory'", NOT "recommended a book").
- When someone shares a photo, record what it shows as a fact about them
  ("Sam shared a photo of a red ceramic vase they made").
- Record stated reasons, realizations, feelings, and motivations as facts
  ("After the marathon, Sam realized rest days matter").
- Each fact must stand on its own without the surrounding conversation.
  Name the person it is about explicitly; resolve pronouns to concrete
  entities ("Sam plays the cello", not "she plays it").
- Anchor time: if the conversation has a date (e.g. "(conversation date:
  ...)"), resolve relative references ("yesterday", "last week", "next
  month") to absolute dates and include the date in the fact ("Sam ran the
  city marathon on 12 March 2024"). For events, always keep the date when it
  is known or derivable. Never guess a date that cannot be derived.
- Prefer present tense for ongoing states, past tense with dates for events.
- Keep each fact concise (one clause where possible).
- If there is nothing worth remembering, return an empty list.

Respond with a single JSON object. Each fact is an object with:
- "text": the fact.
- "event_date": ISO date (YYYY-MM-DD, or YYYY-MM / YYYY if partially known)
  when the fact happened or began; null when undatable.
- "entities": the named entities the fact mentions (people, places,
  organizations, named things) — exact surface forms, deduplicated.
- "subject": the single entity the fact is primarily about.
- "attribute": a short snake_case key for the aspect of the subject this
  fact states ("residence", "job", "pet", "allergy", "hobby", "event") —
  facts about the same subject+attribute describe the same belief slot.
- "type": classify the fact as exactly one of:
  - "fact": something that is true (a state/attribute, e.g. lives in X, has a pet)
  - "preference": something the user likes or dislikes
  - "decision": a choice that was made
  - "identity": core, durable info about who someone is (rarely changes)
  - "event": something that happened at a point in time (append-only; events
    do NOT supersede each other)
  - "observation": something merely noticed
  - "goal": something someone wants to achieve
  - "todo": an actionable task or reminder
  Default to "fact" if unsure.
- "cardinality": for this subject+attribute, can only ONE value be true at a
  time, or can several coexist?
  - "single": a new value REPLACES the old one (residence, job, age, marital
    status, current employer) — you can only live in one place at a time.
  - "multi": several values coexist (pets, hobbies, skills, friends, children,
    languages spoken) — having a dog doesn't undo having a cat.
  Default "single".

{"facts": [
  {"text": "Sam ran the city marathon on 12 March 2024", "event_date": "2024-03-12",
   "entities": ["Sam", "city marathon"], "subject": "Sam", "attribute": "event",
   "type": "event", "cardinality": "multi"},
  {"text": "Sam plays the cello", "event_date": null,
   "entities": ["Sam"], "subject": "Sam", "attribute": "instrument",
   "type": "fact", "cardinality": "multi"},
  {"text": "Sam lives in Berlin", "event_date": null,
   "entities": ["Sam", "Berlin"], "subject": "Sam", "attribute": "residence",
   "type": "fact", "cardinality": "single"}
]}`;

export function buildExtractionMessages(
  conversation: string,
  systemPrompt: string = FACT_EXTRACTION_SYSTEM,
): Message[] {
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: conversation },
  ];
}

/** Flatten an `AddInput` (string | Message | Message[]) into a transcript. */
export function messagesToTranscript(messages: Message[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
}

/**
 * Episode gist prompt — one dated paragraph compressing a raw conversation
 * chunk. Gists are the middle resolution between atomic facts and the
 * profile: context assembly substitutes many same-episode facts with one
 * gist under token-budget pressure.
 */
export const EPISODE_GIST_SYSTEM = `You are a memory gist writer.
FISHMEM_TASK: gist

Compress the conversation into ONE dense paragraph (50-90 words) that keeps:
who was involved, what happened or was decided, concrete details (names,
dates, numbers), and anything with lasting relevance. Write in past tense,
third person, no preamble — output the paragraph only.`;

/**
 * MDL merge prompt — produce the shortest faithful summary of two
 * near-duplicate memories. The caller applies the MDL acceptance test:
 * merge only if the summary encodes shorter than the originals.
 */
export const MDL_MERGE_SYSTEM = `You are a memory compressor.
FISHMEM_TASK: merge

Two near-duplicate memories follow. Write ONE sentence that preserves every
distinct detail from both (names, dates, numbers). Output the sentence only.`;
