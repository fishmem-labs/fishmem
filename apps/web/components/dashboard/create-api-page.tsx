"use client";

import { Bot, Boxes, ExternalLink, Terminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import { useState } from "react";
import { CodeBlock } from "@fishmem/dashboard/code-block";
import { NodeIcon, PythonIcon } from "@/components/dashboard/lang-icons";
import { PUBLIC_API_BASE_URL } from "@/lib/config";
import { cn } from "@/lib/utils";

const API_BASE = PUBLIC_API_BASE_URL;
const DOCS_URL = "https://docs.fishmem.com";

type Category = "harness" | "sdk";

const CATEGORIES: Array<{
  key: Category;
  title: string;
  desc: string;
  icon: LucideIcon;
}> = [
  { key: "harness", title: "Agent Harness", desc: "Memory across every session", icon: Bot },
  { key: "sdk", title: "SDK Integration", desc: "Drop into your existing stack", icon: Boxes },
];

// ---------------------------------------------------------------------------
// Content — the first-party SDKs and the REST API at {host}/v1.
// ---------------------------------------------------------------------------

const HARNESS_PROMPT = `Set up FishMem memory for this agent and use it on every task.

Configure
1. Create an API key at ${API_BASE}/dashboard/api-keys
2. FishMem exposes a REST API at ${API_BASE}/v1 — authenticate with the header
   "Authorization: Bearer fm_…".
3. Verify: GET ${API_BASE}/v1/memories?user_id=demo returns 200. If not, stop and report the error.

Use memory every turn
- Before acting: POST ${API_BASE}/v1/memories/search with { "query": <the task>, "user_id": <id> };
  add the top results to your context.
- After acting: POST ${API_BASE}/v1/memories with { "messages": [...], "user_id": <id> } and a stable
  Idempotency-Key. The default infer=true extracts refined durable records. Use infer=false only
  when the submitted content is already distilled and must be stored verbatim.
- Always scope calls by user_id / agent_id / run_id so memories stay isolated per entity.`;

const HARNESS_CLI = `export FISHMEM_API_KEY="fm_xxxxxxxxxxxx"

# Add a memory
curl -X POST ${API_BASE}/v1/memories \\
  -H "Authorization: Bearer $FISHMEM_API_KEY" \\
  -H "Idempotency-Key: alex-diet-v1" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"I am vegetarian and allergic to peanuts."}],"user_id":"alex"}'

# Search memory
curl -X POST ${API_BASE}/v1/memories/search \\
  -H "Authorization: Bearer $FISHMEM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query":"dinner ideas","user_id":"alex"}'`;

type Step = { title: string; desc: string; code: string; language: string };

const SDK: Record<string, Step[]> = {
  python: [
    {
      title: "Install the SDK",
      desc: "Use the official synchronous or asynchronous Python client.",
      language: "bash",
      code: "pip install fishmem",
    },
    {
      title: "Add memory",
      desc: "Default inference stores only refined canonical records.",
      language: "python",
      code: `from fishmem import FishMem

fishmem = FishMem(api_key="fm_…", base_url="${API_BASE}")
fishmem.memories.add(
    {
        "messages": [
            {"role": "user", "content": "Hi, I'm Alex. I'm vegetarian and allergic to nuts."},
        ],
        "user_id": "alex",
    },
    idempotency_key="alex-diet-v1",
)`,
    },
    {
      title: "Search memory",
      desc: "Retrieve the most relevant memories for a query.",
      language: "python",
      code: `result = fishmem.memories.search({
    "query": "What can I cook for dinner tonight?",
    "user_id": "alex",
    "top_k": 5,
})
print(result["results"])`,
    },
  ],
  javascript: [
    {
      title: "Install the SDK",
      desc: "The default client runs in Node, Bun, Deno, Workers, and edge runtimes.",
      language: "bash",
      code: "npm install @fishmem/sdk",
    },
    {
      title: "Add memory",
      desc: "Use a stable idempotency key when a write may be retried.",
      language: "typescript",
      code: `import { FishMem } from "@fishmem/sdk";

const fishmem = new FishMem({
  apiKey: process.env.FISHMEM_API_KEY!,
  baseUrl: "${API_BASE}",
});

await fishmem.memories.add(
  {
    messages: [
      { role: "user", content: "Hi, I'm Alex. I'm a vegetarian and allergic to nuts." },
    ],
    user_id: "alex",
  },
  { idempotencyKey: "alex-diet-v1" },
);`,
    },
    {
      title: "Search memory",
      desc: "Retrieve the most relevant memories for a query.",
      language: "typescript",
      code: `const { results } = await fishmem.memories.search({
  query: "What can I cook for dinner tonight?",
  user_id: "alex",
  top_k: 5,
});
console.log(results);`,
    },
  ],
  curl: [
    {
      title: "Add memory",
      desc: "Send a POST request to add conversation history to memory.",
      language: "bash",
      code: `curl -X POST ${API_BASE}/v1/memories \\
  -H 'Authorization: Bearer fm_…' \\
  -H 'Idempotency-Key: alex-diet-v1' \\
  -H 'Content-Type: application/json' \\
  -d '{
  "messages": [
    { "role": "user", "content": "Hi, I am Alex. I am a vegetarian and allergic to nuts." }
  ],
  "user_id": "alex"
}'`,
    },
    {
      title: "Search memory",
      desc: "Send a POST request to search through a user's memory.",
      language: "bash",
      code: `curl -X POST ${API_BASE}/v1/memories/search \\
  -H 'Authorization: Bearer fm_…' \\
  -H 'Content-Type: application/json' \\
  -d '{ "query": "What can I cook for dinner tonight?", "user_id": "alex" }'`,
    },
  ],
};

const SDK_LANGS: Array<{
  key: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { key: "javascript", label: "Node.js", icon: NodeIcon },
  { key: "python", label: "Python", icon: PythonIcon },
  { key: "curl", label: "cURL", icon: Terminal },
];

// ---------------------------------------------------------------------------

export function CreateApiPage() {
  const [category, setCategory] = useState<Category>("harness");

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Install FishMem
      </h1>

      <div className="grid gap-3 md:grid-cols-2">
        {CATEGORIES.map((c) => {
          const Icon = c.icon;
          const active = category === c.key;
          return (
            <button
              className={cn(
                "flex items-center gap-3 rounded-xl bg-card px-4 py-3.5 text-left transition-colors",
                active
                  ? "ring-2 ring-foreground"
                  : "ring-1 ring-foreground/10 hover:bg-muted/50",
              )}
              key={c.key}
              onClick={() => setCategory(c.key)}
              type="button"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">
                  {c.title}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {c.desc}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {category === "harness" ? <HarnessPanel /> : null}
      {category === "sdk" ? <SdkPanel /> : null}
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{
    key: T;
    label: string;
    icon?: ComponentType<{ className?: string }>;
  }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg bg-muted p-[3px]">
      {options.map((o) => {
        const Icon = o.icon;
        return (
          <button
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors",
              value === o.key
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            key={o.key}
            onClick={() => onChange(o.key)}
            type="button"
          >
            {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function DocsLink() {
  return (
    <a
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
      href={DOCS_URL}
      target="_blank"
    >
      View Docs <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

function HarnessPanel() {
  const [tab, setTab] = useState<"prompt" | "cli">("prompt");
  return (
    <div className="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
      <div className="flex items-center justify-between">
        <Segmented
          onChange={setTab}
          options={[
            { key: "prompt", label: "Prompt" },
            { key: "cli", label: "CLI" },
          ]}
          value={tab}
        />
        <DocsLink />
      </div>
      <p className="mt-4 text-sm text-muted-foreground">
        {tab === "prompt"
          ? "Paste this into your coding agent (Claude Code, Codex, Cursor…) to wire up FishMem memory."
          : "Run this to store and search your first memory over the REST API."}
      </p>
      <div className="mt-3">
        <CodeBlock
          code={tab === "prompt" ? HARNESS_PROMPT : HARNESS_CLI}
          filename={tab === "prompt" ? "installation prompt" : undefined}
          language="bash"
        />
      </div>
    </div>
  );
}

function SdkPanel() {
  const [lang, setLang] = useState<string>("javascript");
  const steps = SDK[lang]!;
  return (
    <div className="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
      <Segmented onChange={setLang} options={SDK_LANGS} value={lang} />
      <div className="mt-6 space-y-6">
        {steps.map((step, i) => (
          <div
            className="grid gap-4 md:grid-cols-[300px_1fr] md:gap-6"
            key={step.title}
          >
            <div className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
                {i + 1}
              </span>
              <div>
                <p className="text-sm font-medium text-foreground">{step.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  {step.desc}
                </p>
              </div>
            </div>
            <CodeBlock code={step.code} language={step.language} />
          </div>
        ))}
      </div>
    </div>
  );
}
