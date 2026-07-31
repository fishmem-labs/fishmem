"use client";

import { useMutation } from "@tanstack/react-query";
import {
  ArrowUp,
  History,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  User,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { dashButton, StatusPill } from "@fishmem/dashboard/page-shell";
import { useClickOutside } from "@/hooks/use-click-outside";
import { useCurrentUser } from "@/hooks/use-user";
import {
  addMemory,
  type BeliefChainRow,
  fetchMemoryState,
  recallWithContext,
  type RecallItem,
} from "@/lib/memories-api";
import { cn } from "@/lib/utils";

/** The four RRF input lanes, with the colour each gets in the breakdown. */
const LANES: Array<{ key: keyof NonNullable<RecallItem["sources"]>; label: string; dot: string }> = [
  { key: "vector", label: "vector", dot: "bg-brand" },
  { key: "fts", label: "keyword", dot: "bg-info" },
  { key: "graph", label: "graph", dot: "bg-success" },
  { key: "temporal", label: "temporal", dot: "bg-warning" },
];

const SUGGESTIONS = [
  "I'm Alex. I'm vegetarian and allergic to peanuts.",
  "I moved from Munich to Berlin last month.",
  "What can Alex eat?",
];

const STORAGE_KEY = "fishmem:playground-threads";
const MAX_THREADS = 50;

type Turn = {
  id: string;
  text: string;
  results: RecallItem[];
  beliefs: BeliefChainRow[];
  stored: number;
  mode?: "add" | "search" | "state";
  response?: unknown;
  request?: unknown;
  contextTokens?: number;
};

type Thread = { id: string; turns: Turn[]; createdAt: number };

function freshThread(): Thread {
  return { id: crypto.randomUUID(), turns: [], createdAt: Date.now() };
}

/** Persisted (non-empty) threads from localStorage, newest first. */
function loadThreads(): Thread[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Thread[]) : [];
    return Array.isArray(parsed)
      ? parsed
          .filter((t) => t?.turns?.length)
          .map((t) => ({ ...t, createdAt: t.createdAt ?? Date.now() }))
      : [];
  } catch {
    return [];
  }
}

function threadLabel(t: Thread): string {
  const first = t.turns[0]?.text.trim();
  return first ? (first.length > 44 ? `${first.slice(0, 44)}…` : first) : "New thread";
}

function relTime(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.floor(mo / 12)}y ago`;
}

function maxFusedOf(turn: Turn): number {
  return Math.max(0.0001, ...turn.results.map((r) => r.score ?? 0));
}

export function PlaygroundPage() {
  const { jwt, workspaceId, user } = useCurrentUser();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mode, setMode] = useState<"add" | "search" | "state">("search");
  const [scopeType, setScopeType] = useState<"user_id" | "agent_id" | "run_id">(
    "user_id",
  );
  const [scopeId, setScopeId] = useState("");
  const [subject, setSubject] = useState("");
  const [attribute, setAttribute] = useState("");
  const historyRef = useRef<HTMLDivElement>(null);
  useClickOutside(historyRef, () => setHistoryOpen(false), historyOpen);

  // Restore past threads on mount and start on a fresh (unstored) one.
  useEffect(() => {
    const fresh = freshThread();
    setThreads([fresh, ...loadThreads()].slice(0, MAX_THREADS + 1));
    setCurrentId(fresh.id);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!scopeId && user?.id != null) setScopeId(String(user.id));
  }, [scopeId, user?.id]);

  // Persist only non-empty threads (a blank thread isn't stored).
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(threads.filter((t) => t.turns.length).slice(0, MAX_THREADS)),
      );
    } catch {
      // storage full / unavailable
    }
  }, [threads, hydrated]);

  const current = threads.find((t) => t.id === currentId) ?? null;
  const turns = current?.turns ?? [];
  // Scope playground memories to the signed-in user — no demo placeholder.
  const userLabel = user?.name?.trim() || user?.email || "you";
  const history = threads
    .filter((t) => t.turns.length)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_THREADS);

  const updateCurrent = (fn: (t: Thread) => Thread) =>
    setThreads((prev) => prev.map((t) => (t.id === currentId ? fn(t) : t)));

  const newThread = () => {
    const t = freshThread();
    // Drop any other blank threads — only one fresh thread at a time.
    setThreads((prev) => [t, ...prev.filter((p) => p.turns.length)].slice(0, MAX_THREADS + 1));
    setCurrentId(t.id);
    setInput("");
    setHistoryOpen(false);
  };

  const deleteThread = (id: string) => {
    if (id === currentId) {
      const t = freshThread();
      setThreads((prev) => [t, ...prev.filter((p) => p.id !== id && p.turns.length)]);
      setCurrentId(t.id);
      setInput("");
    } else {
      setThreads((prev) => prev.filter((t) => t.id !== id));
    }
  };

  const send = useMutation({
    mutationFn: async (text: string) => {
      const scope = { [scopeType]: scopeId };
      if (mode === "add") {
        const added = await addMemory(jwt ?? "", {
          messages: [{ role: "user", content: text }],
          ...scope,
          infer: true,
          workspace: workspaceId,
        });
        return {
          text,
          mode,
          results: [],
          beliefs: [],
          stored: added.length,
          response: { results: added },
          request: { content: text, infer: true, ...scope },
        };
      }
      if (mode === "state") {
        const response = await fetchMemoryState(jwt ?? "", {
          subject,
          attribute,
          ...scope,
          workspace: workspaceId,
        });
        return {
          text,
          mode,
          results: [],
          beliefs: [],
          stored: 0,
          response,
          request: { subject, attribute, ...scope },
        };
      }
      const recall = await recallWithContext(jwt ?? "", {
        query: text,
        ...scope,
        limit: 6,
        workspace: workspaceId,
      });
      return {
        text,
        mode,
        results: recall.results,
        beliefs: recall.beliefs,
        stored: 0,
        response: { results: recall.results, beliefs: recall.beliefs },
        request: { query: text, limit: 6, trace: true, ...scope },
        contextTokens: Math.ceil(
          recall.results.reduce((sum, item) => sum + item.memory.length, 0) / 4,
        ),
      };
    },
    onSuccess: (turn) => {
      updateCurrent((t) => ({
        ...t,
        turns: [...t.turns, { id: crypto.randomUUID(), ...turn }],
      }));
      setInput("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (
      !trimmed ||
      send.isPending ||
      !jwt ||
      !current ||
      !scopeId.trim() ||
      (mode === "state" && (!subject.trim() || !attribute.trim()))
    )
      return;
    send.mutate(trimmed);
  };

  const pendingText = send.isPending ? (send.variables as string) : null;

  return (
    <div className="flex h-full flex-col bg-card">
      {/* Header: title · user scope · new thread · thread history */}
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="text-sm font-medium text-foreground">Playground</span>
        <span
          className="inline-flex max-w-[200px] items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
          title={`${scopeType} = ${scopeId || "…"}`}
        >
          <User className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{userLabel}</span>
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            aria-label="New thread"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={newThread}
            title="New thread"
            type="button"
          >
            <Plus className="h-4 w-4" />
          </button>
          <div className="relative" ref={historyRef}>
            <button
              aria-label="Thread history"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((v) => !v)}
              title="Thread history"
              type="button"
            >
              <History className="h-4 w-4" />
            </button>
            {historyOpen ? (
              <div className="absolute right-0 top-10 z-40 flex min-h-[200px] w-72 flex-col overflow-hidden rounded-lg bg-popover p-1 text-popover-foreground shadow-[0_18px_46px_rgba(0,0,0,0.16)] ring-1 ring-foreground/10">
                {history.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center px-3 text-center text-[13px] text-muted-foreground">
                    No threads yet.
                  </div>
                ) : (
                  <div className="max-h-[60vh] flex-1 overflow-y-auto">
                    {history.map((t) => (
                      <div
                        className={cn(
                          "group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent",
                          t.id === currentId && "bg-accent",
                        )}
                        key={t.id}
                      >
                        <button
                          className="min-w-0 flex-1 text-left"
                          onClick={() => {
                            setCurrentId(t.id);
                            setHistoryOpen(false);
                          }}
                          type="button"
                        >
                          <span className="block truncate text-[13px] text-foreground">
                            {threadLabel(t)}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            {relTime(t.createdAt)}
                          </span>
                        </button>
                        <button
                          aria-label="Delete thread"
                          className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                          onClick={() => deleteThread(t.id)}
                          type="button"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="flex rounded-md bg-muted p-0.5">
          {(["add", "search", "state"] as const).map((value) => (
            <button
              className={cn(
                "h-7 rounded px-3 text-xs font-medium capitalize",
                mode === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground",
              )}
              key={value}
              onClick={() => setMode(value)}
              type="button"
            >
              {value}
            </button>
          ))}
        </div>
        <select
          aria-label="Scope type"
          className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
          onChange={(event) =>
            setScopeType(event.target.value as typeof scopeType)
          }
          value={scopeType}
        >
          <option value="user_id">User</option>
          <option value="agent_id">Agent</option>
          <option value="run_id">Run</option>
        </select>
        <input
          aria-label="Scope id"
          className="h-8 min-w-[180px] rounded-md border border-input bg-background px-2 text-xs text-foreground"
          onChange={(event) => setScopeId(event.target.value)}
          placeholder="Scope id"
          value={scopeId}
        />
        {mode === "state" ? (
          <>
            <input
              aria-label="State subject"
              className="h-8 min-w-[150px] rounded-md border border-input bg-background px-2 text-xs text-foreground"
              onChange={(event) => setSubject(event.target.value)}
              placeholder="Subject"
              value={subject}
            />
            <input
              aria-label="State attribute"
              className="h-8 min-w-[150px] rounded-md border border-input bg-background px-2 text-xs text-foreground"
              onChange={(event) => setAttribute(event.target.value)}
              placeholder="Attribute"
              value={attribute}
            />
          </>
        ) : null}
      </div>

      {/* Body: messages — each reply is the recalled memory context */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6">
          {turns.length === 0 && !pendingText ? (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <Sparkles className="h-6 w-6 text-muted-foreground/50" />
              <p className="max-w-sm text-sm text-muted-foreground">
                Say a couple of facts, then ask a question. Each reply is the
                memory context your LLM would receive — with the scores behind it.
              </p>
              <div className="flex flex-col gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    className="rounded-lg border border-border px-3 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-muted"
                    key={s}
                    onClick={() => submit(s)}
                    type="button"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {turns.map((turn) => (
                <MessagePair key={turn.id} turn={turn} />
              ))}
              {pendingText ? <PendingPair text={pendingText} /> : null}
            </div>
          )}
        </div>
      </div>

      {/* Footer: prompt — no border between it and the body */}
      <div className="px-4 pb-5 pt-1">
        <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-input bg-background p-2 transition-colors focus-within:border-ring">
          <textarea
            className="min-h-[96px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(input);
              }
            }}
            placeholder={
              mode === "add"
                ? "Memory content"
                : mode === "state"
                  ? "State query label"
                  : "Search query"
            }
            rows={3}
            value={input}
          />
          <button
            className={cn(dashButton.primary, "h-9 w-9 shrink-0 px-0")}
            disabled={send.isPending || !input.trim()}
            onClick={() => submit(input)}
            type="button"
          >
            {send.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-foreground px-3.5 py-2 text-[13px] leading-snug text-background">
        {text}
      </div>
    </div>
  );
}

function MessagePair({ turn }: { turn: Turn }) {
  const maxFused = maxFusedOf(turn);
  const mode = turn.mode ?? "search";
  return (
    <div className="space-y-3">
      <UserBubble text={turn.text} />
      <div className="space-y-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {mode === "add"
            ? `Stored ${turn.stored} ${turn.stored === 1 ? "memory" : "memories"}`
            : mode === "state"
              ? "State response"
              : turn.results.length
                ? `Recalled ${turn.results.length} ${turn.results.length === 1 ? "memory" : "memories"}`
                : "No memories recalled"}
        </p>
        {turn.results.length ? (
          <>
            {turn.results.map((r) => (
              <ContextItem item={r} key={r.id} maxFused={maxFused} />
            ))}
            {turn.beliefs.length > 0 ? (
              <BeliefTimelines beliefs={turn.beliefs} />
            ) : null}
          </>
        ) : turn.response !== undefined ? (
          <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs text-foreground">
            {JSON.stringify(turn.response, null, 2)}
          </pre>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            Nothing matched yet — say a few facts, then ask.
          </p>
        )}
        {turn.request !== undefined ? (
          <details className="rounded-md border border-border px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              Request / response
              {turn.contextTokens !== undefined
                ? ` · ${turn.contextTokens} context tokens`
                : ""}
            </summary>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <pre className="max-h-56 overflow-auto bg-muted/30 p-2 font-mono text-[11px] text-foreground">
                {JSON.stringify(turn.request, null, 2)}
              </pre>
              <pre className="max-h-56 overflow-auto bg-muted/30 p-2 font-mono text-[11px] text-foreground">
                {JSON.stringify(turn.response, null, 2)}
              </pre>
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function PendingPair({ text }: { text: string }) {
  return (
    <div className="space-y-3">
      <UserBubble text={text} />
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Recalling…
      </div>
    </div>
  );
}

function ContextItem({ item, maxFused }: { item: RecallItem; maxFused: number }) {
  const fused = item.score ?? 0;
  const sources = item.sources;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] leading-snug text-foreground">{item.memory}</p>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {fused.toFixed(3)}
        </span>
      </div>
      {/* Fused-score bar: width relative to the top hit, so ranking reads visually. */}
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground/70"
          style={{ width: `${Math.round((fused / maxFused) * 100)}%` }}
        />
      </div>
      {sources ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {LANES.map((lane) => {
            const v = sources[lane.key];
            if (v == null) return null;
            return (
              <span
                className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground"
                key={lane.key}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", lane.dot)} />
                {lane.label}
                <span className="font-mono tabular-nums text-foreground/70">
                  {v.toFixed(2)}
                </span>
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function BeliefTimelines({ beliefs }: { beliefs: BeliefChainRow[] }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Belief timeline
      </p>
      <div className="space-y-3">
        {beliefs.map((chain) => (
          <div key={`${chain.subject}-${chain.attribute}`}>
            <p className="text-[12px] font-medium text-foreground">
              {chain.subject} · {chain.attribute}
            </p>
            <ul className="mt-1 space-y-0.5">
              {chain.entries.map((e) => (
                <li
                  className="flex items-center gap-2 text-[12px] leading-snug"
                  key={e.id}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      e.current ? "bg-success" : "bg-muted-foreground/40",
                    )}
                  />
                  <span
                    className={cn(
                      e.current
                        ? "text-foreground"
                        : "text-muted-foreground line-through",
                    )}
                  >
                    {e.content}
                  </span>
                  {e.current ? (
                    <StatusPill tone="success">current</StatusPill>
                  ) : e.validTo ? (
                    <span className="text-[11px] text-muted-foreground">
                      until {e.validTo.slice(0, 10)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
