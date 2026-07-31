import { Bot, Clock, User } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MemoryRow } from "@/lib/memories-api";

export type ScopeType = "user" | "agent" | "run";

export const SCOPE_META: Record<ScopeType, { label: string; icon: LucideIcon }> =
  {
    user: { label: "USER", icon: User },
    run: { label: "RUN", icon: Clock },
    agent: { label: "AGENT", icon: Bot },
  };

export const SCOPE_TYPES: ScopeType[] = ["user", "run", "agent"];

export function isScopeType(value: string): value is ScopeType {
  return (SCOPE_TYPES as string[]).includes(value);
}

/** The owning scope (user/agent/run) of a memory row. */
export function scopeOfMemory(row: MemoryRow): { type: ScopeType; id: string } {
  if (row.user_id) return { type: "user", id: row.user_id };
  if (row.agent_id) return { type: "agent", id: row.agent_id };
  if (row.run_id) return { type: "run", id: row.run_id };
  return { type: "user", id: "unscoped" };
}

/** Category labels for a memory — from metadata.categories, falling back to type. */
export function memoryCategories(row: MemoryRow): string[] {
  const cats = (row.metadata as Record<string, unknown> | null)?.categories;
  if (Array.isArray(cats)) return cats.filter((c): c is string => typeof c === "string");
  if (row.memory_type && row.memory_type !== "raw") return [row.memory_type];
  return [];
}

/** A stable token-based dot colour for a category chip. */
export function categoryDot(category: string): string {
  const key = category.toLowerCase();
  if (key.includes("personal")) return "bg-warning";
  if (key.includes("professional") || key.includes("work")) return "bg-success";
  if (key.includes("health")) return "bg-destructive";
  if (key.includes("milestone")) return "bg-info";
  return "bg-brand";
}
