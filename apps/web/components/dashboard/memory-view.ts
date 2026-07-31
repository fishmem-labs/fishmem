import type {
  DashboardMemory,
  DashboardMemoryHistory,
} from "@fishmem/dashboard/memory-workspace";
import type {
  MemoryHistoryRow,
  MemoryRow,
} from "@/lib/memories-api";

export function toDashboardMemory(memory: MemoryRow): DashboardMemory {
  return {
    id: memory.id,
    content: memory.memory,
    memoryType: memory.memory_type,
    importance: memory.importance,
    userId: memory.user_id,
    agentId: memory.agent_id,
    runId: memory.run_id,
    metadata: memory.metadata,
    createdAt: memory.created_at,
    updatedAt: memory.updated_at,
    eventDate: memory.event_date,
    validFrom: memory.valid_from,
    validTo: memory.valid_to,
    subject: memory.subject,
    attribute: memory.attribute,
    supersededBy: memory.superseded_by,
    lastAccessedAt: memory.last_accessed_at,
    accessCount: memory.access_count,
    score: memory.score,
  };
}

export function toDashboardMemoryHistory(
  entry: MemoryHistoryRow,
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
