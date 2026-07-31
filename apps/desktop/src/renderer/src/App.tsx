import {
  PageShell,
  Panel,
  StatusPill,
  dashButton,
  inputClass,
} from "@fishmem/dashboard/page-shell";
import { ConfirmDialog } from "@fishmem/dashboard/confirm-dialog";
import {
  DateRangeFilter,
  type TimeWindow,
  windowContains,
} from "@fishmem/dashboard/date-range-filter";
import {
  applyFilter,
  EMPTY_FILTER,
  type Filter,
  type FilterParamDef,
  FilterPopover,
} from "@fishmem/dashboard/filter";
import { MemoryHome } from "@fishmem/dashboard/memory-home";
import {
  MemoryInspectorDrawer,
  MemorySearchToolbar,
  MemoryTable,
  type DashboardMemory,
  type DashboardMemoryHistory,
  type DashboardMemoryPatch,
} from "@fishmem/dashboard/memory-workspace";
import {
  Bot,
  Database,
  FileText,
  Home,
  LockKeyhole,
  Plus,
  RefreshCw,
  Settings,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import logoUrl from "../../../../web/public/logo.svg";
import type {
  DesktopMemoryHistoryPage,
  DesktopMemoryPage,
  DesktopMemoryRecord,
  DesktopSummary,
  DesktopStatus,
  IntegrationClient,
  IntegrationStatus,
} from "../../shared/protocol";

type Tab = "summary" | "memories" | "integrations" | "settings";

const navigation: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: "summary", label: "Home", icon: Home },
  { id: "memories", label: "Memories", icon: Database },
  { id: "integrations", label: "Agent Integrations", icon: Bot },
  { id: "settings", label: "Settings", icon: Settings },
];

export function App() {
  const [tab, setTab] = useState<Tab>("summary");
  const [status, setStatus] = useState<DesktopStatus>();
  const [memoryToOpen, setMemoryToOpen] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    setStatus(await window.fishmem.invoke<DesktopStatus>("status"));
  }, []);
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);
  useEffect(() => {
    if (
      status?.embeddingState !== "downloading" &&
      status?.embeddingState !== "indexing"
    ) {
      return;
    }
    const timer = window.setInterval(() => void refreshStatus(), 1000);
    return () => window.clearInterval(timer);
  }, [refreshStatus, status?.embeddingState]);

  return (
    <div className="desktop-shell bg-background text-foreground">
      <aside className="border-r border-border bg-sidebar p-4">
        <div className="px-2 py-3">
          <div className="flex items-center gap-2.5 text-base font-semibold">
            <img alt="FishMem logo" className="size-8 rounded-lg" src={logoUrl} />
            FishMem
          </div>
          <p className="mt-2 max-w-36 text-xs leading-relaxed text-muted-foreground">
            One private memory.
            <br />
            Every agent.
          </p>
        </div>
        <nav className="mt-5 space-y-1">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-sm ${
                tab === item.id
                  ? "bg-sidebar-accent font-medium"
                  : "text-muted-foreground hover:bg-sidebar-accent"
              }`}
              onClick={() => setTab(item.id)}
            >
              <item.icon className="size-4" />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="absolute bottom-5 left-5 right-5 space-y-2 border-t border-border pt-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LockKeyhole className="size-3.5" />
            Local · Private
          </div>
          <StatusPill tone={status?.configured ? "info" : "warning"}>
            {embeddingStatusLabel(status)}
          </StatusPill>
        </div>
      </aside>
      <main className="min-w-0 overflow-y-auto p-8">
        {tab === "summary" && (
          <Summary
            configured={status?.configured}
            status={status}
            onOpenMemory={(id) => {
              setMemoryToOpen(id);
              setTab("memories");
            }}
            onViewMemories={() => {
              setMemoryToOpen(null);
              setTab("memories");
            }}
          />
        )}
        {tab === "memories" && (
          <Memories
            configured={status?.configured}
            focusMemoryId={memoryToOpen}
          />
        )}
        {tab === "integrations" && <Integrations />}
        {tab === "settings" && (
          <SettingsPanel status={status} onSaved={refreshStatus} />
        )}
      </main>
    </div>
  );
}

function Summary({
  configured,
  status,
  onOpenMemory,
  onViewMemories,
}: {
  configured?: boolean;
  status?: DesktopStatus;
  onOpenMemory(id: string): void;
  onViewMemories(): void;
}) {
  const [summary, setSummary] = useState<DesktopSummary>();
  const [integrations, setIntegrations] = useState<IntegrationStatus>();
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!configured) return;
    try {
      const [nextSummary, nextIntegrations] = await Promise.all([
        window.fishmem.invoke<DesktopSummary>("summary"),
        window.fishmem.invoke<IntegrationStatus>("integrationStatus"),
      ]);
      setSummary(nextSummary);
      setIntegrations(nextIntegrations);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [configured]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!configured) return <EmptySetup />;
  if (error) {
    return (
      <Panel>
        <p className="text-sm text-destructive">{error}</p>
      </Panel>
    );
  }
  if (!summary) {
    return (
      <div className="animate-pulse space-y-6" aria-label="Loading summary">
        <div className="h-72 rounded-xl bg-muted" />
        <div className="h-32 rounded-xl bg-muted" />
      </div>
    );
  }

  const installedIntegrations =
    Number(integrations?.codex.connected ?? false) +
    Number(integrations?.claudeCode.connected ?? false);

  return (
    <MemoryHome
      actions={
        <StatusPill
          tone={status?.embeddingState === "ready" ? "success" : "warning"}
        >
          {embeddingStatusLabel(status)}
        </StatusPill>
      }
      description="Monitor what FishMem remembers, what it recalls, and the local agents connected to this Mac."
      environment="Local · private · this Mac"
      metrics={[
        {
          label: "Total memories",
          value: summary.totalMemories.toLocaleString(),
        },
        {
          label: "Remembered today",
          value: summary.rememberedToday.toLocaleString(),
        },
        {
          label: "Recalled today",
          value: summary.recalledToday.toLocaleString(),
        },
        {
          label: "Agent integrations",
          value: installedIntegrations.toLocaleString(),
          hint: "Codex and Claude Code",
        },
      ]}
      onOpenMemory={onOpenMemory}
      onViewAll={onViewMemories}
      recentRecalled={summary.recentRecalled.map((memory) => ({
        id: memory.id,
        content: memory.content,
        context: memory.source ? sourceLabel(memory.source) : "local memory",
        timestamp: memory.lastAccessedAt,
      }))}
      recentRemembered={summary.recentRemembered.map((memory) => ({
        id: memory.id,
        content: memory.content,
        context: memory.source ? sourceLabel(memory.source) : "local memory",
        timestamp: memory.createdAt,
      }))}
      status={
        status?.embeddingState === "ready"
          ? "Local memory service ready"
          : embeddingStatusLabel(status)
      }
      statusTone={status?.embeddingState === "ready" ? "success" : "warning"}
    />
  );
}

const MEMORY_FILTERS: FilterParamDef[] = [
  { value: "client", label: "Agent", icon: Bot },
  { value: "source", label: "Source", icon: FileText },
  { value: "type", label: "Type", icon: Tag },
  { value: "content", label: "Memory content", icon: Database },
];

function memoryField(
  row: DesktopMemoryRecord,
  field: string,
): string | string[] {
  if (field === "client") return memoryClient(row);
  if (field === "source") {
    return [
      row.source ?? "",
      typeof row.metadata?.source === "string" ? row.metadata.source : "",
      typeof row.metadata?.sourceKind === "string"
        ? row.metadata.sourceKind
        : "",
    ];
  }
  if (field === "type") return row.memoryType;
  if (field === "content") return row.content;
  return "";
}

function Memories({
  configured,
  focusMemoryId,
}: {
  configured?: boolean;
  focusMemoryId?: string | null;
}) {
  const [rows, setRows] = useState<DesktopMemoryRecord[]>([]);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>({ kind: "all" });
  const [filter, setFilter] = useState<Filter>(EMPTY_FILTER);
  const [selectedId, setSelectedId] = useState<string | null>(
    focusMemoryId ?? null,
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<DashboardMemoryHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!configured) return;
    setLoading(true);
    setError("");
    try {
      const page = submittedQuery
          ? await window.fishmem.invoke<DesktopMemoryPage>("search", {
              query: submittedQuery,
              limit: 50,
            })
        : await window.fishmem.invoke<DesktopMemoryPage>("list", { limit: 100 });
      setRows(page.results);
      setSelectedIds(new Set());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [configured, submittedQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!configured || !focusMemoryId) return;
    let active = true;
    setSelectedId(focusMemoryId);
    void window.fishmem
      .invoke<DesktopMemoryRecord>("get", { id: focusMemoryId })
      .then((memory) => {
        if (!active) return;
        setRows((current) =>
          current.some((row) => row.id === memory.id)
            ? current
            : [memory, ...current],
        );
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [configured, focusMemoryId]);

  const visibleRows = applyFilter(
    rows.filter((row) => windowContains(row.createdAt, timeWindow)),
    filter,
    memoryField,
  );
  const selectedIndex = visibleRows.findIndex((row) => row.id === selectedId);
  const selectedMemory =
    selectedIndex >= 0 ? visibleRows[selectedIndex] : undefined;

  useEffect(() => {
    if (!selectedMemory) {
      setHistory([]);
      return;
    }
    let active = true;
    setHistoryLoading(true);
    void window.fishmem
      .invoke<DesktopMemoryHistoryPage>("history", {
        id: selectedMemory.id,
      })
      .then((page) => {
        if (active) {
          setHistory(page.results.map(toDashboardMemoryHistory));
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedMemory?.id]);

  function toggle(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function deletePending() {
    setLoading(true);
    try {
      for (const id of pendingDelete) {
        await window.fishmem.invoke("delete", { id });
      }
      if (selectedId && pendingDelete.includes(selectedId)) {
        setSelectedId(null);
      }
      setPendingDelete([]);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  async function updateSelected(patch: DashboardMemoryPatch) {
    if (!selectedMemory) return;
    await window.fishmem.invoke("update", {
      id: selectedMemory.id,
      content: patch.content,
      metadata: patch.metadata,
    });
    await load();
  }

  if (!configured) return <EmptySetup />;

  return (
    <PageShell
      actions={
        <div className="flex items-center gap-2">
          <DateRangeFilter onChange={setTimeWindow} value={timeWindow} />
          <button
            className={dashButton.outline}
            disabled={loading}
            onClick={() => void load()}
            type="button"
          >
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button
            className={dashButton.primary}
            onClick={() => setCreateOpen(true)}
            type="button"
          >
            <Plus className="size-4" />
            New memory
          </button>
        </div>
      }
      contentClassName="space-y-5"
      description="Search, inspect, edit, and remove the durable records stored on this Mac."
      title="Memories"
    >
      <MemorySearchToolbar
        activeQuery={submittedQuery}
        filters={
          <FilterPopover
            onChange={setFilter}
            params={MEMORY_FILTERS}
            triggerClassName="h-9"
            value={filter}
          />
        }
        onChange={setQuery}
        onClear={() => {
          setQuery("");
          setSubmittedQuery("");
          setSelectedId(null);
        }}
        onSearch={(value) => {
          setSubmittedQuery(value);
          setSelectedId(null);
        }}
        resultCount={visibleRows.length}
        value={query}
      />

      {selectedIds.size ? (
        <div className="flex items-center gap-3 rounded-xl bg-foreground/5 px-4 py-2.5 ring-1 ring-foreground/10">
          <span className="text-[13px] font-medium text-foreground">
            {selectedIds.size} selected
          </span>
          <button
            className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setSelectedIds(new Set())}
            type="button"
          >
            Clear
          </button>
          <button
            className={`${dashButton.danger} ml-auto`}
            onClick={() => setPendingDelete([...selectedIds])}
            type="button"
          >
            <Trash2 className="size-4" />
            Delete
          </button>
        </div>
      ) : null}

      <MemoryTable
        emptyDescription={
          submittedQuery
            ? "Try another semantic query or clear the active filters."
            : "Codex or Claude Code can add the first local memory."
        }
        loading={loading}
        onDelete={(id) => setPendingDelete([id])}
        onOpen={setSelectedId}
        onToggle={toggle}
        onToggleAll={(checked) =>
          setSelectedIds(
            checked ? new Set(visibleRows.map((row) => row.id)) : new Set(),
          )
        }
        rows={visibleRows.map(toDashboardMemory)}
        searching={Boolean(submittedQuery)}
        selectedId={selectedId}
        selectedIds={selectedIds}
      />

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <MemoryInspectorDrawer
        hasNext={
          selectedIndex >= 0 && selectedIndex < visibleRows.length - 1
        }
        hasPrevious={selectedIndex > 0}
        history={history}
        historyLoading={historyLoading}
        memory={selectedMemory ? toDashboardMemory(selectedMemory) : undefined}
        onClose={() => setSelectedId(null)}
        onNext={() =>
          setSelectedId(visibleRows[selectedIndex + 1]?.id ?? null)
        }
        onPrevious={() =>
          setSelectedId(visibleRows[selectedIndex - 1]?.id ?? null)
        }
        onSave={updateSelected}
        open={Boolean(selectedMemory)}
      />

      <NewMemoryDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={load}
      />
      <ConfirmDialog
        confirmLabel={
          pendingDelete.length > 1
            ? `Delete ${pendingDelete.length} memories`
            : "Delete memory"
        }
        description="This permanently removes the selected local memory and its search projection."
        destructive
        loading={loading}
        onClose={() => setPendingDelete([])}
        onConfirm={() => void deletePending()}
        open={pendingDelete.length > 0}
        title="Delete local memory?"
      />
    </PageShell>
  );
}

function NewMemoryDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose(): void;
  onCreated(): Promise<void>;
}) {
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (!open) return null;

  async function create() {
    setSaving(true);
    setError("");
    try {
      await window.fishmem.invoke("add", { content });
      setContent("");
      onClose();
      await onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        aria-label="Close"
        className="absolute inset-0 bg-foreground/40"
        onClick={onClose}
        type="button"
      />
      <section className="relative z-10 w-full max-w-lg rounded-xl bg-popover p-5 shadow-2xl ring-1 ring-foreground/10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">New memory</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Store one durable fact, preference, constraint, or decision.
            </p>
          </div>
          <button
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground"
            onClick={onClose}
            type="button"
          >
            <X className="size-4" />
          </button>
        </div>
        <textarea
          autoFocus
          className="mt-5 min-h-32 w-full resize-none rounded-lg border border-input bg-background p-3 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
          onChange={(event) => setContent(event.target.value)}
          placeholder="What should FishMem remember?"
          value={content}
        />
        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button className={dashButton.outline} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className={dashButton.primary}
            disabled={!content.trim() || saving}
            onClick={() => void create()}
            type="button"
          >
            {saving ? "Saving…" : "Add memory"}
          </button>
        </div>
      </section>
    </div>
  );
}

function AgentConnections() {
  const [status, setStatus] = useState<IntegrationStatus>();
  const [busy, setBusy] = useState<IntegrationClient>();
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    setStatus(
      await window.fishmem.invoke<IntegrationStatus>("integrationStatus"),
    );
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function change(client: IntegrationClient, connect: boolean) {
    setBusy(client);
    setMessage("");
    try {
      const next = await window.fishmem.invoke<IntegrationStatus>(
        connect ? "connectIntegration" : "disconnectIntegration",
        { client },
      );
      setStatus(next);
      setMessage(
        connect
          ? `${client === "codex" ? "Codex" : "Claude Code"} connected. Open a new agent session to use FishMem.`
          : `${client === "codex" ? "Codex" : "Claude Code"} disconnected.`,
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Agent connections</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Install the FishMem command and memory skill with one click. Keep
          FishMem running while your agent works.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <IntegrationPanel
          busy={busy === "codex"}
          client="codex"
          connected={status?.codex.connected ?? false}
          name="Codex"
          skillPath={status?.codex.skillPath}
          onChange={change}
        />
        <IntegrationPanel
          busy={busy === "claude-code"}
          client="claude-code"
          connected={status?.claudeCode.connected ?? false}
          name="Claude Code"
          skillPath={status?.claudeCode.skillPath}
          onChange={change}
        />
      </div>
      {status && (
        <Panel title="FishMem command">
          <code className="block overflow-x-auto rounded-lg bg-muted px-3 py-2 text-xs">
            {status.commandPath}
          </code>
          <p className="mt-2 text-xs text-muted-foreground">
            Both skills use this local command to communicate with FishMem Desktop.
          </p>
        </Panel>
      )}
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </section>
  );
}

function Integrations() {
  return (
    <PageShell
      title="Agent Integrations"
      description="Connect FishMem to Codex and Claude Code with one click."
    >
      <AgentConnections />
    </PageShell>
  );
}

function IntegrationPanel({
  busy,
  client,
  connected,
  name,
  skillPath,
  onChange,
}: {
  busy: boolean;
  client: IntegrationClient;
  connected: boolean;
  name: string;
  skillPath?: string;
  onChange(client: IntegrationClient, connect: boolean): Promise<void>;
}) {
  return (
    <Panel title={name}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <StatusPill tone={connected ? "success" : "neutral"}>
            {connected ? "Connected" : "Not connected"}
          </StatusPill>
          {skillPath && (
            <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground">
              {skillPath}
            </p>
          )}
        </div>
        <button
          className={connected ? dashButton.outline : dashButton.primary}
          disabled={busy}
          onClick={() => void onChange(client, !connected)}
        >
          {busy ? "Working…" : connected ? "Disconnect" : `Connect to ${name}`}
        </button>
      </div>
    </Panel>
  );
}

function SettingsPanel({
  status,
  onSaved,
}: {
  status?: DesktopStatus;
  onSaved(): Promise<void>;
}) {
  const [message, setMessage] = useState("");
  async function retry() {
    try {
      setMessage("Preparing local embedding…");
      await window.fishmem.invoke("retryEmbedding");
      setMessage("Local semantic search is ready.");
      await onSaved();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <PageShell
      title="Settings"
      description="Inspect the local semantic model and private storage."
    >
      <div>
        <h2 className="text-base font-semibold">Semantic search</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          FishMem Desktop uses one local multilingual E5 model. Memory content
          and embeddings stay on this device.
        </p>
      </div>
      <Panel title="Local multilingual E5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <StatusPill
              tone={
                status?.embeddingState === "ready"
                  ? "success"
                  : status?.embeddingState === "error"
                    ? "warning"
                    : "info"
              }
            >
              {embeddingStatusLabel(status)}
            </StatusPill>
            <p className="mt-2 text-sm text-muted-foreground">
              {status?.model ?? "Xenova/multilingual-e5-small"} ·{" "}
              {status?.dimensions ?? 384} dimensions
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Quantized ONNX weights are downloaded once, cached locally, and
              then remain available offline.
            </p>
            {status?.embeddingError && (
              <p className="mt-2 text-sm text-destructive">
                {status.embeddingError}
              </p>
            )}
            {message && (
              <p className="mt-2 text-sm text-muted-foreground">{message}</p>
            )}
          </div>
          {status?.embeddingState === "error" && (
            <button className={dashButton.outline} onClick={() => void retry()}>
              Retry local model
            </button>
          )}
        </div>
      </Panel>
      {status && (
        <Panel title="Local storage">
          <p className="break-all font-mono text-xs text-muted-foreground">
            {status.databasePath}
          </p>
        </Panel>
      )}
    </PageShell>
  );
}

function EmptySetup() {
  return (
    <Panel>
      <p className="text-sm text-muted-foreground">
        FishMem is starting its local database. Try again in a moment.
      </p>
    </Panel>
  );
}

function embeddingStatusLabel(status?: DesktopStatus) {
  if (!status?.configured) return "Starting…";
  if (status.embeddingState === "downloading") {
    return status.embeddingProgress === undefined
      ? "Downloading model…"
      : `Downloading ${Math.round(status.embeddingProgress)}%`;
  }
  if (status.embeddingState === "error") return "Model unavailable";
  if (status.embeddingState === "indexing") return "Rebuilding local index…";
  return status.embeddingState === "ready"
    ? "Local semantic search ready"
    : "Local memory ready";
}

function sourceLabel(source: string) {
  if (source === "codex") return "Codex";
  if (source === "claude-code") return "Claude Code";
  return source;
}

function memoryClient(row: DesktopMemoryRecord) {
  const client = row.metadata?.fishmemClient;
  if (typeof client === "string" && client) return sourceLabel(client);
  const sourceKind = row.metadata?.sourceKind;
  if (typeof sourceKind === "string" && sourceKind) {
    return sourceLabel(sourceKind);
  }
  if (row.source) return sourceLabel(row.source);
  if (row.userId) return row.userId;
  if (row.runId) return row.runId;
  if (row.agentId && row.agentId !== "fishmem-desktop") return row.agentId;
  return "Desktop";
}

function toDashboardMemory(row: DesktopMemoryRecord): DashboardMemory {
  return {
    id: row.id,
    content: row.content,
    memoryType: row.memoryType,
    importance: row.importance,
    userId: row.userId,
    agentId: row.agentId,
    runId: row.runId,
    source: row.source,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    eventDate: row.eventDate,
    validFrom: row.validFrom,
    validTo: row.validTo,
    subject: row.subject,
    attribute: row.attribute,
    supersededBy: row.supersededBy,
    lastAccessedAt: row.lastAccessedAt,
    accessCount: row.accessCount,
    score: row.score,
  };
}

function toDashboardMemoryHistory(
  entry: DesktopMemoryHistoryPage["results"][number],
): DashboardMemoryHistory {
  return {
    id: entry.id,
    memoryId: entry.memory_id,
    event: entry.event,
    previousValue: entry.previous_value,
    newValue: entry.new_value,
    createdAt: entry.created_at,
  };
}
