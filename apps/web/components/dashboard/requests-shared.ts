import type { RequestEvent } from "@/lib/api";

/** Compact "7d ago" style relative time. */
export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

export type RequestResultItem = {
  id?: string;
  memory: string;
  memory_type?: string;
  categories?: string[];
  created_at?: string;
  score?: number;
};

/** Display label + token-based tint for an operation badge. */
export function typeMeta(kind: string): { label: string; tone: string } {
  switch (kind) {
    case "memories.search":
      return { label: "SEARCH", tone: "bg-brand/10 text-brand" };
    case "memories.add":
    case "memories.add_raw":
      return { label: "ADD", tone: "bg-success/10 text-success" };
    case "memories.list":
      return { label: "GET ALL", tone: "bg-muted text-muted-foreground" };
    case "memories.get":
      return { label: "GET", tone: "bg-muted text-muted-foreground" };
    case "memories.update":
      return { label: "UPDATE", tone: "bg-warning/15 text-warning" };
    case "memories.delete":
      return { label: "DELETE", tone: "bg-destructive/10 text-destructive" };
    case "documents.ingest":
      return { label: "SOURCE", tone: "bg-success/10 text-success" };
    case "documents.search":
      return { label: "RAG", tone: "bg-brand/10 text-brand" };
    case "documents.list":
      return { label: "SOURCES", tone: "bg-muted text-muted-foreground" };
    case "documents.get":
    case "documents.content":
      return { label: "SOURCE GET", tone: "bg-muted text-muted-foreground" };
    case "documents.delete":
      return { label: "SOURCE DELETE", tone: "bg-destructive/10 text-destructive" };
    default:
      return {
        label: kind.replace(/^(memories|documents)\./, "").toUpperCase(),
        tone: "bg-muted text-muted-foreground",
      };
  }
}

function meta(event: RequestEvent): Record<string, unknown> {
  return (event.metadata ?? {}) as Record<string, unknown>;
}

export function requestQuery(event: RequestEvent): string | undefined {
  const q = meta(event).query;
  return typeof q === "string" && q.trim() ? q : undefined;
}

const SCOPE_KEYS = ["user_id", "agent_id", "run_id", "app_id"] as const;

/** The scope keys present in the request (rendered as the "Filters" JSON). */
export function requestScopeFilters(event: RequestEvent): Record<string, string> {
  const m = meta(event);
  const out: Record<string, string> = {};
  for (const key of SCOPE_KEYS) {
    const v = m[key];
    if (typeof v === "string" && v) out[key] = v;
  }
  return out;
}

/** A compact entity label for the table's Entities column. */
export function requestEntityLabel(event: RequestEvent): string | null {
  const filters = requestScopeFilters(event);
  const first = Object.entries(filters)[0];
  return first ? first[1] : null;
}

export function requestResultItems(event: RequestEvent): RequestResultItem[] {
  const r = meta(event).results;
  if (!Array.isArray(r)) return [];
  return r.filter(
    (x): x is RequestResultItem =>
      Boolean(x) && typeof (x as RequestResultItem).memory === "string",
  );
}

/** Result count, tolerating both the new (array) and legacy (number) shapes. */
export function requestResultCount(event: RequestEvent): number | null {
  const m = meta(event);
  if (typeof m.result_count === "number") return m.result_count;
  if (Array.isArray(m.results)) return m.results.length;
  if (typeof m.results === "number") return m.results;
  return null;
}

export function requestHasResults(event: RequestEvent): boolean {
  const count = requestResultCount(event);
  if (count !== null) return count > 0;
  return event.status === "success";
}
