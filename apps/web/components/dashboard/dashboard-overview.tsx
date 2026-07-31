"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  Check,
  FolderCog,
  KeyRound,
  ListChecks,
  Loader2,
  Plug,
  Sparkles,
  TestTube2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  bucketizeMetrics,
  type MetricBucket,
} from "@fishmem/dashboard/metrics";
import { MemoryHome } from "@fishmem/dashboard/memory-home";
import {
  DateRangeFilter,
  type TimeWindow,
  windowContains,
} from "@/components/dashboard/date-range-filter";
import { useCurrentUser } from "@/hooks/use-user";
import {
  fetchApiTokens,
  fetchEngineConfig,
  fetchRequests,
  type RequestEvent,
} from "@/lib/api";
import { fetchAllMemories, type MemoryRow } from "@/lib/memories-api";
import { cn, formatNumber } from "@/lib/utils";
import { compact, LineChart } from "@/components/dashboard/charts";

type LegendItem = { key: string; label: string; dot: string; count: number };
type Series = { key: string; label: string; dot: string; color: string };

const REQUEST_SERIES: Array<Series & { kinds: string[] }> = [
  { key: "add", label: "ADD", dot: "bg-success", color: "--success", kinds: ["memories.add", "memories.add_raw"] },
  { key: "search", label: "SEARCH", dot: "bg-brand", color: "--brand", kinds: ["memories.search"] },
  { key: "get_all", label: "GET ALL", dot: "bg-info", color: "--info", kinds: ["memories.list"] },
  { key: "delete", label: "DELETE", dot: "bg-destructive", color: "--destructive", kinds: ["memories.delete", "memories.delete_all"] },
];

const ENTITY_SERIES: Series[] = [
  { key: "user", label: "USERS", dot: "bg-brand", color: "--brand" },
  { key: "run", label: "RUNS", dot: "bg-warning", color: "--warning" },
  { key: "agent", label: "AGENTS", dot: "bg-success", color: "--success" },
  { key: "app", label: "APPS", dot: "bg-info", color: "--info" },
];

function requestSeriesKey(kind: string): string | null {
  for (const s of REQUEST_SERIES) if (s.kinds.includes(kind)) return s.key;
  return null;
}

/** One entry per distinct entity, stamped at its first-seen time (so the time
 * buckets sum to the distinct-entity total the legend shows). */
function entityFirstSeen(
  memories: MemoryRow[],
): Array<{ t: number; key: string }> {
  const seen = new Map<string, { t: number; key: string }>();
  for (const m of memories) {
    let key: string | null = null;
    let id: string | null = null;
    if (m.user_id) {
      key = "user";
      id = m.user_id;
    } else if (m.agent_id) {
      key = "agent";
      id = m.agent_id;
    } else if (m.run_id) {
      key = "run";
      id = m.run_id;
    }
    if (!key || !id) continue;
    const t = new Date(m.created_at).getTime();
    const ek = `${key}:${id}`;
    const prev = seen.get(ek);
    if (!prev || t < prev.t) seen.set(ek, { t, key });
  }
  return [...seen.values()];
}

function memoryContext(memory: MemoryRow) {
  if (memory.user_id) return `user · ${memory.user_id}`;
  if (memory.agent_id) return `agent · ${memory.agent_id}`;
  if (memory.run_id) return `run · ${memory.run_id}`;
  return "unscoped";
}

export function DashboardOverview() {
  const { jwt, workspaceId } = useCurrentUser();
  const [window, setWindow] = useState<TimeWindow>({ kind: "all" });

  const requests = useQuery({
    queryKey: ["requests", jwt, workspaceId, "all"],
    queryFn: () => fetchRequests(jwt!, "all", workspaceId),
    enabled: Boolean(jwt && workspaceId),
  });
  const memories = useQuery({
    queryKey: ["memories", jwt, workspaceId, "overview"],
    queryFn: () => fetchAllMemories(jwt!, { workspace: workspaceId }),
    enabled: Boolean(jwt && workspaceId),
  });

  const events = useMemo<RequestEvent[]>(
    () =>
      (requests.data?.data ?? []).filter((e) => windowContains(e.createdAt, window)),
    [requests.data?.data, window],
  );
  const scopedMemories = useMemo<MemoryRow[]>(
    () => (memories.data ?? []).filter((m) => windowContains(m.created_at, window)),
    [memories.data, window],
  );

  const requestLegend: LegendItem[] = REQUEST_SERIES.map((s) => ({
    key: s.key,
    label: s.label,
    dot: s.dot,
    count: events.filter((e) => s.kinds.includes(e.kind)).length,
  }));

  const requestBuckets = useMemo(
    () =>
      bucketizeMetrics(
        window,
        events
          .map((e) => ({
            t: new Date(e.createdAt).getTime(),
            key: requestSeriesKey(e.kind) ?? "",
          }))
          .filter((x) => x.key),
      ),
    [events, window],
  );
  const entityBuckets = useMemo(
    () => bucketizeMetrics(window, entityFirstSeen(scopedMemories)),
    [scopedMemories, window],
  );

  const entityLegend: LegendItem[] = useMemo(() => {
    const sets: Record<string, Set<string>> = {
      user: new Set(),
      run: new Set(),
      agent: new Set(),
      app: new Set(),
    };
    for (const m of scopedMemories) {
      if (m.user_id) sets.user!.add(m.user_id);
      else if (m.agent_id) sets.agent!.add(m.agent_id);
      else if (m.run_id) sets.run!.add(m.run_id);
    }
    return ENTITY_SERIES.map((s) => ({ ...s, count: sets[s.key]!.size }));
  }, [scopedMemories]);

  const totalRequests = events.length;
  const retrievalEvents = events.filter((e) =>
    ["memories.search", "memories.list"].includes(e.kind),
  ).length;
  const addEvents = events.filter((e) =>
    ["memories.add", "memories.add_raw"].includes(e.kind),
  ).length;
  const retrievalRate = totalRequests
    ? `${Math.round((retrievalEvents / totalRequests) * 100)}%`
    : "0%";
  const month = new Intl.DateTimeFormat("en", { month: "short" }).format(new Date());
  const recentRemembered = useMemo(
    () =>
      [...scopedMemories]
        .sort(
          (left, right) =>
            new Date(right.created_at).getTime() -
            new Date(left.created_at).getTime(),
        )
        .slice(0, 5)
        .map((memory) => ({
          id: memory.id,
          content: memory.memory,
          context: memoryContext(memory),
          timestamp: memory.created_at,
          href: `/dashboard/memories?memory=${encodeURIComponent(memory.id)}`,
        })),
    [scopedMemories],
  );
  const recentRecalled = useMemo(
    () =>
      scopedMemories
        .filter((memory) => Boolean(memory.last_accessed_at))
        .sort(
          (left, right) =>
            new Date(right.last_accessed_at ?? 0).getTime() -
            new Date(left.last_accessed_at ?? 0).getTime(),
        )
        .slice(0, 5)
        .map((memory) => ({
          id: memory.id,
          content: memory.memory,
          context: memoryContext(memory),
          timestamp: memory.last_accessed_at ?? memory.updated_at,
          href: `/dashboard/memories?memory=${encodeURIComponent(memory.id)}`,
        })),
    [scopedMemories],
  );
  const homeLoading = memories.isLoading || requests.isLoading;
  const homeError = memories.isError || requests.isError;

  return (
    <MemoryHome
      actions={<DateRangeFilter onChange={setWindow} value={window} />}
      description="Monitor what FishMem remembers, what it recalls, and the activity behind the selected project."
      environment="Open-source · selected project"
      metrics={[
        {
          label: "Memories in range",
          value: formatNumber(scopedMemories.length),
        },
        {
          label: "Retrieval events",
          value: formatNumber(retrievalEvents),
          hint: `${retrievalRate} of loaded requests`,
        },
        {
          label: "Add events",
          value: formatNumber(addEvents),
        },
        {
          label: "Active entities",
          value: formatNumber(
            entityLegend.reduce((total, item) => total + item.count, 0),
          ),
          hint: month,
        },
      ]}
      recentRecalled={recentRecalled}
      recentRemembered={recentRemembered}
      status={
        homeError
          ? "Project data needs attention"
          : homeLoading
            ? "Loading project memory"
            : "Memory service ready"
      }
      statusTone={homeError ? "danger" : homeLoading ? "neutral" : "success"}
      viewAllHref="/dashboard/memories"
    >
      <OnboardingChecklist
        hasMemory={(memories.data?.length ?? 0) > 0}
        hasRequest={(requests.data?.data?.length ?? 0) > 0}
        ready={memories.data !== undefined && requests.data !== undefined}
      />

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <ActivityPanel
          actionHref="/dashboard/requests"
          actionLabel="View Requests"
          buckets={requestBuckets}
          label="Requests"
          legend={requestLegend}
          loading={requests.isLoading}
          series={REQUEST_SERIES}
        />
        <ActivityPanel
          actionHref="/dashboard/entities"
          actionLabel="View Entities"
          buckets={entityBuckets}
          label="Entities"
          legend={entityLegend}
          loading={memories.isLoading}
          series={ENTITY_SERIES}
        />
      </div>

      <section className="mt-9">
        <h2 className="text-lg font-medium tracking-tight text-foreground">
          Explore the Platform
        </h2>
        <div className="mt-4 grid overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 md:grid-cols-4">
          {exploreItems.map((item) => (
            <ExploreLink item={item} key={item.title} />
          ))}
        </div>
      </section>
    </MemoryHome>
  );
}

type ChecklistStep = {
  key: string;
  title: string;
  text: string;
  href: string;
  icon: LucideIcon;
  done: boolean;
};

/**
 * Lightweight first-run guide on Home: configure a provider → create an API key
 * → write a memory → try the Playground. Each step self-completes from live
 * signals (engine config, tokens, memory/request counts); the whole card
 * disappears once everything is done, so it never nags an established install.
 */
function OnboardingChecklist({
  hasMemory,
  hasRequest,
  ready,
}: {
  hasMemory: boolean;
  hasRequest: boolean;
  /** Parent's memory/request queries have resolved. */
  ready: boolean;
}) {
  const { jwt, workspaceId } = useCurrentUser();
  const config = useQuery({
    queryKey: ["engine-config", jwt],
    queryFn: () => fetchEngineConfig(jwt!),
    enabled: Boolean(jwt),
  });
  const tokens = useQuery({
    queryKey: ["api-tokens", jwt, workspaceId],
    queryFn: () => fetchApiTokens(jwt!, workspaceId),
    enabled: Boolean(jwt && workspaceId),
  });

  // Decide once, after EVERY gating signal has resolved — config, tokens, and
  // the parent's memory/request data. Rendering before all four are in lets the
  // card flash in (looking incomplete) then vanish once the data arrives.
  if (!ready || config.data === undefined || tokens.data === undefined) {
    return null;
  }

  const steps: ChecklistStep[] = [
    {
      key: "provider",
      title: "Connect a provider",
      text: "Point FishMem at an embedder (OpenAI, Ollama, any compatible endpoint).",
      href: "/dashboard/settings#configuration",
      icon: Plug,
      done: Boolean(config.data?.configured),
    },
    {
      key: "key",
      title: "Create an API key",
      text: "Mint an fm_ key to call the memory API from your app.",
      href: "/dashboard/create-api",
      icon: KeyRound,
      done: (tokens.data?.length ?? 0) > 0,
    },
    {
      key: "memory",
      title: "Add your first memory",
      text: "Install the SDK and write a memory, or add one from the Playground.",
      href: "/dashboard/playground",
      icon: Sparkles,
      done: hasMemory,
    },
    {
      key: "playground",
      title: "Try the Playground",
      text: "Add and recall memories live before wiring it into code.",
      href: "/dashboard/playground",
      icon: TestTube2,
      done: hasRequest,
    },
  ];

  const completed = steps.filter((s) => s.done).length;
  if (completed === steps.length) return null;

  return (
    <section className="mb-4 overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Get started</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            A few steps to a working memory layer.
          </p>
        </div>
        <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
          {completed}/{steps.length}
        </span>
      </div>
      <div className="divide-y divide-border">
        {steps.map((step) => (
          <a
            className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent"
            href={step.href}
            key={step.key}
          >
            <span
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                step.done
                  ? "bg-success/15 text-success"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {step.done ? (
                <Check className="h-4 w-4" />
              ) : (
                <step.icon className="h-4 w-4" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-[13px] font-medium",
                  step.done
                    ? "text-muted-foreground line-through"
                    : "text-foreground",
                )}
              >
                {step.title}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {step.text}
              </p>
            </div>
            {step.done ? null : (
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            )}
          </a>
        ))}
      </div>
    </section>
  );
}

/**
 * Fixed-height KPI panel: title, the active-series total right under it (no
 * divider), a time-series area chart with a hover tooltip, and the toggleable
 * legend pinned to the bottom.
 */
function ActivityPanel({
  actionHref,
  actionLabel,
  buckets,
  label,
  legend,
  loading,
  series,
}: {
  actionHref: string;
  actionLabel: string;
  buckets: MetricBucket[];
  label: string;
  legend: LegendItem[];
  loading: boolean;
  series: Series[];
}) {
  const [inactive, setInactive] = useState<Set<string>>(new Set());
  const activeTotal = legend
    .filter((l) => !inactive.has(l.key))
    .reduce((sum, l) => sum + l.count, 0);
  const grandTotal = legend.reduce((sum, l) => sum + l.count, 0);
  const allActive = inactive.size === 0;

  const toggle = (key: string) =>
    setInactive((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section className="flex h-[320px] flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="flex items-center justify-between gap-4 px-4 pt-4">
        <h2 className="text-[13px] font-medium text-foreground">{label}</h2>
        <a
          className="group inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          href={actionHref}
        >
          <span className="group-hover:underline">{actionLabel}</span>
          <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </a>
      </div>
      <p className="px-4 pt-0.5 text-2xl font-semibold leading-tight tracking-tight text-foreground">
        {loading ? "—" : formatNumber(activeTotal)}
      </p>

      <div className="mt-2 px-2">
        {loading ? (
          <div className="flex h-[176px] items-center justify-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : grandTotal === 0 ? (
          <div className="flex h-[176px] items-center justify-center text-xs text-muted-foreground">
            No activity in this range.
          </div>
        ) : (
          <ActivityChart
            buckets={buckets}
            inactive={inactive}
            series={series}
            totalLabel={label.toUpperCase()}
          />
        )}
      </div>

      <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1.5 px-4 pb-4 pt-2">
        {/* Total chip — always the grand total; click to show all series. */}
        <button
          className={cn(
            "flex items-center gap-1.5 transition-opacity",
            allActive ? "opacity-100" : "opacity-70",
          )}
          onClick={() => setInactive(new Set())}
          type="button"
        >
          <span className="h-2.5 w-2.5 rounded-sm bg-foreground" />
          <span className="text-xs font-semibold text-foreground">TOTAL</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatNumber(grandTotal)}
          </span>
        </button>
        {legend.map((item) => {
          const off = inactive.has(item.key);
          return (
            <button
              className={cn(
                "flex items-center gap-1.5 transition-opacity",
                off ? "opacity-35" : "opacity-100",
              )}
              key={item.key}
              onClick={() => toggle(item.key)}
              type="button"
            >
              <span className={cn("h-2.5 w-2.5 rounded-sm", item.dot)} />
              <span className="text-xs font-medium text-foreground">
                {item.label}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatNumber(item.count)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

const CHART_H = 176;

/** One line per active series across the window (Tremor/Recharts), with a
 * tooltip that also shows the total. */
function ActivityChart({
  buckets,
  inactive,
  series,
  totalLabel,
}: {
  buckets: MetricBucket[];
  inactive: Set<string>;
  series: Series[];
  totalLabel: string;
}) {
  const activeSeries = series.filter((s) => !inactive.has(s.key));
  const data = buckets.map((b) => ({
    label: b.label,
    total: activeSeries.reduce((sum, s) => sum + (b.counts[s.key] ?? 0), 0),
    ...Object.fromEntries(series.map((s) => [s.key, b.counts[s.key] ?? 0])),
  }));

  return (
    <LineChart
      categories={[
        { key: "total", label: totalLabel, color: "--foreground" },
        ...activeSeries.map((s) => ({
          key: s.key,
          label: s.label,
          color: s.color,
        })),
      ]}
      data={data}
      height={CHART_H}
      index="label"
      tooltip={(row) => (
        <>
          <p className="mb-2 font-mono text-[11px] text-muted-foreground">
            {String(row.label)}
          </p>
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-foreground" />
              <span className="font-medium text-foreground">{totalLabel}</span>
            </span>
            <span className="font-mono text-foreground">
              {compact(Number(row.total ?? 0))}
            </span>
          </div>
          {activeSeries.map((s) => (
            <div
              className="mt-1.5 flex items-center justify-between gap-3"
              key={s.key}
            >
              <span className="flex items-center gap-1.5">
                <span className={cn("h-2.5 w-2.5 rounded-sm", s.dot)} />
                <span className="text-foreground">{s.label}</span>
              </span>
              <span className="font-mono text-muted-foreground">
                {compact(Number(row[s.key] ?? 0))}
              </span>
            </div>
          ))}
        </>
      )}
    />
  );
}

const exploreItems: Array<{
  title: string;
  text: string;
  href: string;
  icon: LucideIcon;
}> = [
  {
    title: "Integration Examples",
    text: "See integration patterns for adding memory to your product.",
    href: "/dashboard/create-api",
    icon: ListChecks,
  },
  {
    title: "Try the Playground",
    text: "Test memory addition and retrieval live before wiring code.",
    href: "/dashboard/playground",
    icon: TestTube2,
  },
  {
    title: "Documentation",
    text: "Read API references and migration notes for your stack.",
    href: "https://docs.fishmem.com",
    icon: BookOpen,
  },
  {
    title: "Customize FishMem",
    text: "Set what FishMem remembers, how it is organized, and when it is used.",
    href: "/dashboard/settings",
    icon: FolderCog,
  },
];

function ExploreLink({ item }: { item: (typeof exploreItems)[number] }) {
  const Icon = item.icon;
  return (
    <a
      className="group min-h-[150px] border-b border-border p-4 transition-colors hover:bg-accent md:border-b-0 md:border-r md:last:border-r-0"
      href={item.href}
    >
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium text-foreground">{item.title}</h3>
      </div>
      <p className="mt-3 text-sm leading-normal text-muted-foreground">
        {item.text}
      </p>
    </a>
  );
}
