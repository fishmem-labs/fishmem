"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Eye, EyeOff, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { dashButton, inputClass } from "@fishmem/dashboard/page-shell";
import { Select } from "@fishmem/dashboard/select";
import { useCurrentUser } from "@/hooks/use-user";
import {
  type EngineTestResult,
  fetchEngineConfig,
  reembedMemories,
  testEngineConfig,
  updateEngineConfig,
} from "@/lib/api";
import { cn } from "@/lib/utils";

/** OpenAI-compatible embedder presets (provider stays "openai", baseURL points
 * at the endpoint). Any provider exposing an OpenAI-style /embeddings endpoint
 * works — Ollama / TEI / vLLM / LM Studio go under Custom with their baseURL. */
const EMBEDDER_PRESETS = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "",
    model: "text-embedding-3-small",
    models: [
      "text-embedding-3-small",
      "text-embedding-3-large",
      "text-embedding-ada-002",
    ],
  },
  {
    id: "jina",
    label: "Jina",
    baseUrl: "https://api.jina.ai/v1",
    model: "jina-embeddings-v3",
    models: ["jina-embeddings-v3", "jina-embeddings-v2-base-en"],
  },
  {
    id: "voyage",
    label: "Voyage",
    baseUrl: "https://api.voyageai.com/v1",
    model: "voyage-3",
    models: ["voyage-3", "voyage-3-lite", "voyage-3-large", "voyage-code-3"],
  },
  {
    id: "together",
    label: "Together",
    baseUrl: "https://api.together.xyz/v1",
    model: "BAAI/bge-large-en-v1.5",
    models: ["BAAI/bge-large-en-v1.5", "BAAI/bge-base-en-v1.5"],
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    model: "nomic-embed-text",
    models: ["nomic-embed-text", "mxbai-embed-large", "bge-m3", "all-minilm"],
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    baseUrl: "",
    model: "",
    models: [],
  },
];

const LLM_PRESETS = [
  {
    id: "openai",
    label: "OpenAI",
    provider: "openai",
    baseUrl: "",
    model: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4.1-mini", "o3-mini"],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    provider: "anthropic",
    baseUrl: "",
    model: "claude-3-5-haiku-latest",
    models: [
      "claude-3-5-haiku-latest",
      "claude-3-5-sonnet-latest",
      "claude-3-7-sonnet-latest",
    ],
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    provider: "openai",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.1",
    models: ["llama3.1", "llama3.2", "qwen2.5", "mistral", "gemma2"],
  },
  {
    id: "groq",
    label: "Groq",
    provider: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    provider: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    models: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet"],
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    provider: "openai",
    baseUrl: "",
    model: "",
    models: [],
  },
];

const CONFIG_TABS = [
  { id: "llm", label: "LLM" },
  { id: "embedder", label: "Embedder" },
  { id: "database", label: "Database" },
] as const;

type ConfigTab = (typeof CONFIG_TABS)[number]["id"];

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1.5 block text-[13px] font-medium text-foreground">
      {children}
    </label>
  );
}

/** Password input with a reveal toggle, plus a "falls back to <ENV>" hint so the
 * UI maps to deploy-time env vars. */
function KeyInput({
  value,
  onChange,
  disabled,
  placeholder,
  envHint,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  placeholder: string;
  envHint?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <div className="relative">
        <input
          className={cn(inputClass, "pr-10")}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          type={show && value ? "text" : "password"}
          value={value}
        />
        <button
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          disabled={disabled || !value}
          onClick={() => setShow((v) => !v)}
          tabIndex={-1}
          type="button"
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {envHint ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Falls back to{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10.5px] text-foreground">
            {envHint}
          </code>{" "}
          from env if blank.
        </p>
      ) : null}
    </div>
  );
}

function TestResultLine({ result }: { result?: EngineTestResult }) {
  if (!result) return null;
  if (result.ok) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-success">
        <Check className="h-3.5 w-3.5" />
        Connected
        {result.dim ? ` · ${result.dim}-dim` : ""}
        {result.latencyMs != null ? ` · ${result.latencyMs}ms` : ""}
      </span>
    );
  }
  return (
    <span className="inline-flex items-start gap-1.5 text-[12px] text-destructive">
      <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {result.message ?? "Test failed"}
    </span>
  );
}

export function EngineConfigForm({ onSaved }: { onSaved?: () => void }) {
  const { jwt, workspaceId } = useCurrentUser();
  const queryClient = useQueryClient();
  const config = useQuery({
    queryKey: ["engine-config", jwt],
    queryFn: () => fetchEngineConfig(jwt!),
    enabled: Boolean(jwt),
  });

  const [tab, setTab] = useState<ConfigTab>("llm");
  const [embPreset, setEmbPreset] = useState("openai");
  const [embModel, setEmbModel] = useState("");
  const [embBase, setEmbBase] = useState("");
  const [embKey, setEmbKey] = useState("");
  const [llmPreset, setLlmPreset] = useState("openai");
  const [llmModel, setLlmModel] = useState("");
  const [llmBase, setLlmBase] = useState("");
  const [llmKey, setLlmKey] = useState("");
  const [derivationEnabled, setDerivationEnabled] = useState(false);

  const data = config.data;
  useEffect(() => {
    if (!data) return;
    setEmbModel(data.embedderModel || "text-embedding-3-small");
    setEmbBase(data.embedderBaseUrl || "");
    setEmbPreset(
      EMBEDDER_PRESETS.find((p) => p.baseUrl === data.embedderBaseUrl)?.id ??
        (data.embedderBaseUrl ? "custom" : "openai"),
    );
    setLlmBase(data.llmBaseUrl || "");
    setLlmModel(data.llmModel || "");
    setLlmPreset(
      data.llmProvider === "anthropic"
        ? "anthropic"
        : (LLM_PRESETS.find(
            (p) => p.provider === "openai" && p.baseUrl === data.llmBaseUrl,
          )?.id ?? (data.llmBaseUrl ? "custom" : "openai")),
    );
    setDerivationEnabled(data.derivationEnabled);
  }, [data]);

  const canEdit = data?.canEdit ?? false;
  const llmProvider =
    LLM_PRESETS.find((p) => p.id === llmPreset)?.provider ?? "openai";
  const embModelHints =
    EMBEDDER_PRESETS.find((p) => p.id === embPreset)?.models ?? [];
  const llmModelHints =
    LLM_PRESETS.find((p) => p.id === llmPreset)?.models ?? [];
  const embChanged =
    Boolean(data) &&
    (embModel !== data?.embedderModel ||
      embBase !== (data?.embedderBaseUrl || "") ||
      Boolean(embKey));

  const save = useMutation({
    mutationFn: () =>
      updateEngineConfig(jwt!, {
        embedderModel: embModel,
        embedderBaseUrl: embBase,
        embedderApiKey: embKey || undefined,
        llmProvider,
        llmModel,
        llmBaseUrl: llmBase,
        llmApiKey: llmKey || undefined,
        derivationEnabled,
      }),
    onSuccess: () => {
      setEmbKey("");
      setLlmKey("");
      toast.success("Configuration saved");
      void queryClient.invalidateQueries({ queryKey: ["engine-config"] });
      onSaved?.();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  // Re-embed runs against the *active* embedder. If the form has unsaved
  // embedder changes, persist them first (which resets the engine singleton)
  // so the re-embed uses the new model rather than the old one.
  const reembed = useMutation({
    mutationFn: async () => {
      if (embChanged) await save.mutateAsync();
      return reembedMemories(jwt!, workspaceId);
    },
    onSuccess: (r) =>
      toast.success(`Re-embedded ${r.reembedded}/${r.total} memories`),
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Re-embed failed"),
  });

  // Live provider check on the current (possibly unsaved) draft.
  const testEmbedder = useMutation({
    mutationFn: () =>
      testEngineConfig(jwt!, {
        target: "embedder",
        embedderModel: embModel,
        embedderBaseUrl: embBase,
        embedderApiKey: embKey || undefined,
      }),
  });
  const testLlm = useMutation({
    mutationFn: () =>
      testEngineConfig(jwt!, {
        target: "llm",
        llmProvider,
        llmModel,
        llmBaseUrl: llmBase,
        llmApiKey: llmKey || undefined,
      }),
  });

  if (config.isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading configuration…
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <nav aria-label="Configuration sections" className="border-b border-border">
        <div className="flex gap-6 overflow-x-auto">
          {CONFIG_TABS.map((t) => (
            <button
              className={cn(
                "h-10 shrink-0 border-b-2 text-[13px] font-medium transition-colors",
                tab === t.id
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              key={t.id}
              onClick={() => setTab(t.id)}
              type="button"
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      <div className="mt-7 space-y-6">
        {tab === "embedder" ? (
          <Section
            desc="Always OpenAI-compatible. Pick a preset, or Custom for any /embeddings endpoint (Ollama / TEI / vLLM)."
            title="Embedder"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Provider</Label>
                <Select
                  className="w-full"
                  disabled={!canEdit}
                  onChange={(id) => {
                    setEmbPreset(id);
                    const p = EMBEDDER_PRESETS.find((x) => x.id === id);
                    if (p && id !== "custom") {
                      setEmbBase(p.baseUrl);
                      if (p.model) setEmbModel(p.model);
                    }
                  }}
                  options={EMBEDDER_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
                  value={embPreset}
                />
              </div>
              <div>
                <Label>Model</Label>
                <input
                  className={inputClass}
                  disabled={!canEdit}
                  list="fm-emb-models"
                  onChange={(e) => setEmbModel(e.target.value)}
                  value={embModel}
                />
                <datalist id="fm-emb-models">
                  {embModelHints.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
              <div className="sm:col-span-2">
                <Label>Base URL</Label>
                <input
                  className={inputClass}
                  disabled={!canEdit}
                  onChange={(e) => setEmbBase(e.target.value)}
                  placeholder="https://api.openai.com/v1 (blank = OpenAI)"
                  value={embBase}
                />
                {data?.embedderBaseUrlFromEnv ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    From <code className="font-mono">OPENAI_BASE_URL</code> (env).
                    Saving stores it here.
                  </p>
                ) : null}
              </div>
              <div className="sm:col-span-2">
                <Label>API key</Label>
                <KeyInput
                  disabled={!canEdit}
                  envHint="OPENAI_API_KEY"
                  onChange={setEmbKey}
                  placeholder={
                    data?.embedderApiKeySet
                      ? "•••• already set — leave blank to keep"
                      : data?.envEmbedderKey
                        ? "Using OPENAI_API_KEY from env — override here"
                        : "fm_…"
                  }
                  value={embKey}
                />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                className={dashButton.outline}
                disabled={testEmbedder.isPending}
                onClick={() => testEmbedder.mutate()}
                type="button"
              >
                {testEmbedder.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Test embedding
              </button>
              <TestResultLine result={testEmbedder.data} />
            </div>

            {embChanged ? (
              <div className="mt-3 rounded-lg bg-warning/10 px-3 py-2.5">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <p className="text-[12px] leading-relaxed text-warning">
                    Changing the embedder invalidates existing memory vectors —
                    they won’t be searchable until re-embedded. Same-dimension
                    models work directly; switching dimensions on a fixed-dim
                    store (pgvector / qdrant) needs a store reset.
                  </p>
                </div>
                {canEdit ? (
                  <button
                    className={cn(dashButton.secondary, "mt-2.5 ml-6")}
                    disabled={reembed.isPending}
                    onClick={() => reembed.mutate()}
                    type="button"
                  >
                    {reembed.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    Save &amp; re-embed all memories
                  </button>
                ) : null}
              </div>
            ) : null}
          </Section>
        ) : null}

        {tab === "llm" ? (
          <Section
            desc="Used once by infer=true to extract refined canonical records. The same extraction can feed optional provenance-linked state projections."
            title="LLM"
          >
            <label className="mb-4 flex items-center gap-3 text-[13px] text-foreground">
              <input
                checked={derivationEnabled}
                disabled={!canEdit}
                onChange={(event) => setDerivationEnabled(event.target.checked)}
                type="checkbox"
              />
              Build derived state and profile projections from canonical records
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Provider</Label>
                <Select
                  className="w-full"
                  disabled={!canEdit}
                  onChange={(id) => {
                    setLlmPreset(id);
                    const p = LLM_PRESETS.find((x) => x.id === id);
                    if (p && id !== "custom") {
                      setLlmBase(p.baseUrl);
                      if (p.model) setLlmModel(p.model);
                    }
                  }}
                  options={LLM_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
                  value={llmPreset}
                />
              </div>
              <div>
                <Label>Model</Label>
                <input
                  className={inputClass}
                  disabled={!canEdit}
                  list="fm-llm-models"
                  onChange={(e) => setLlmModel(e.target.value)}
                  value={llmModel}
                />
                <datalist id="fm-llm-models">
                  {llmModelHints.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
              {llmPreset !== "anthropic" ? (
                <div className="sm:col-span-2">
                  <Label>Base URL</Label>
                  <input
                    className={inputClass}
                    disabled={!canEdit}
                    onChange={(e) => setLlmBase(e.target.value)}
                    placeholder="https://api.openai.com/v1 (blank = OpenAI)"
                    value={llmBase}
                  />
                  {data?.llmBaseUrlFromEnv ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      From <code className="font-mono">OPENAI_BASE_URL</code>{" "}
                      (env). Saving stores it here.
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="sm:col-span-2">
                <Label>API key</Label>
                <KeyInput
                  disabled={!canEdit}
                  envHint={
                    llmProvider === "anthropic"
                      ? "ANTHROPIC_API_KEY"
                      : "OPENAI_API_KEY"
                  }
                  onChange={setLlmKey}
                  placeholder={
                    data?.llmApiKeySet
                      ? "•••• already set — leave blank to keep"
                      : llmProvider === "anthropic"
                        ? data?.envAnthropicKey
                          ? "Using ANTHROPIC_API_KEY from env — override here"
                          : "key…"
                        : data?.envEmbedderKey
                          ? "Using OPENAI_API_KEY from env — override here"
                          : "key…"
                  }
                  value={llmKey}
                />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                className={dashButton.outline}
                disabled={testLlm.isPending}
                onClick={() => testLlm.mutate()}
                type="button"
              >
                {testLlm.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Test connection
              </button>
              <TestResultLine result={testLlm.data} />
            </div>
          </Section>
        ) : null}

        {tab === "database" ? (
          <Section
            desc="Where memories (vectors + graph) are stored. Fixed at deploy time via env — change it via FISHMEM_DB / DATABASE_URL and restart."
            title="Database"
          >
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="inline-flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-1.5 text-muted-foreground">
                Backend
                <span className="font-mono text-foreground">{data?.store}</span>
                <span className="inline-flex items-center rounded-md bg-warning/15 px-1.5 py-0.5 text-[10.5px] font-medium text-warning">
                  env · restart to change
                </span>
              </span>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5",
                  data?.configured
                    ? "bg-success/10 text-success"
                    : "bg-destructive/10 text-destructive",
                )}
              >
                <Check className="h-3.5 w-3.5" />
                {data?.configured ? "Configured" : "Not configured"}
              </span>
            </div>
          </Section>
        ) : null}
      </div>

      {tab === "database" ? null : canEdit ? (
        <div className="mt-7 flex justify-end border-t border-border pt-5">
          <button
            className={dashButton.primary}
            disabled={save.isPending}
            onClick={() => save.mutate()}
            type="button"
          >
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save configuration
          </button>
        </div>
      ) : (
        <p className="mt-7 border-t border-border pt-5 text-[13px] text-muted-foreground">
          Only an admin can change the engine configuration.
        </p>
      )}
    </div>
  );
}

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-[14px] font-medium text-foreground">{title}</h3>
      <p className="mt-0.5 mb-3 text-xs text-muted-foreground">{desc}</p>
      {children}
    </section>
  );
}
