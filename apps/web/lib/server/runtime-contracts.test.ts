import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  apiTokenAuthFailure,
  apiPermissionForRequest,
  memoryDerivationConfig,
} from "./runtime-contracts";

describe("API operation permissions", () => {
  it("allows memory and document search with read scope despite POST transport", () => {
    for (const path of ["/v1/memories/search", "/v1/documents/search/"]) {
      expect(apiPermissionForRequest(new Request(`https://fishmem.test${path}`, { method: "POST" }))).toBe("memory:read");
    }
  });
  it("requires write scope for mutations and operations scope for event reads", () => {
    for (const path of ["/v1/memories", "/v1/memories/search/other", "/v1/operations/task/retry"]) {
      expect(apiPermissionForRequest(new Request(`https://fishmem.test${path}`, { method: "POST" }))).toBe("memory:write");
    }
    expect(apiPermissionForRequest(new Request("https://fishmem.test/v1/events/event"))).toBe("operations:read");
  });
});

describe("apiTokenAuthFailure", () => {
  const now = new Date("2026-07-13T00:00:00.000Z");

  it("accepts an active, unexpired token", () => {
    expect(
      apiTokenAuthFailure(
        { status: "active", expiresAt: new Date(now.getTime() + 1) },
        now,
      ),
    ).toBeNull();
  });

  it("rejects revoked and expired tokens", () => {
    expect(apiTokenAuthFailure({ status: "revoked", expiresAt: null }, now)).toBe(
      "inactive",
    );
    expect(apiTokenAuthFailure({ status: "active", expiresAt: now }, now)).toBe(
      "expired",
    );
  });
});

describe("memoryDerivationConfig", () => {
  it("keeps raw storage fixed and only enables the derivation overlay", () => {
    const sidecar = {} as never;
    const previous = process.env.FISHMEM_BELIEF_RECONCILIATION_ENABLED;
    delete process.env.FISHMEM_BELIEF_RECONCILIATION_ENABLED;
    try {
      expect(memoryDerivationConfig(false)).toEqual({});
      const config = memoryDerivationConfig(true, sidecar);
      expect(config).toEqual({
        derivation: { enabled: true, schedule: "inline", sidecar },
      });
      expect(config).not.toHaveProperty("mode");
    } finally {
      if (previous === undefined) {
        delete process.env.FISHMEM_BELIEF_RECONCILIATION_ENABLED;
      } else {
        process.env.FISHMEM_BELIEF_RECONCILIATION_ENABLED = previous;
      }
    }
  });

  it("requires explicit rollout enablement and exposes allowlist plus kill switch", () => {
    const previousEnabled =
      process.env.FISHMEM_BELIEF_RECONCILIATION_ENABLED;
    const previousAllowlist =
      process.env.FISHMEM_BELIEF_RECONCILIATION_ALLOWLIST;
    const previousDisabled =
      process.env.FISHMEM_BELIEF_RECONCILIATION_DISABLED;
    process.env.FISHMEM_BELIEF_RECONCILIATION_ENABLED = "1";
    process.env.FISHMEM_BELIEF_RECONCILIATION_ALLOWLIST = " ws_a, ws_b ";
    delete process.env.FISHMEM_BELIEF_RECONCILIATION_DISABLED;
    try {
      const config = memoryDerivationConfig(true);
      expect(config.derivation?.beliefs).toMatchObject({
        enabled: true,
        namespaceAllowlist: ["ws_a", "ws_b"],
      });
      expect(config.derivation?.beliefs?.killSwitch?.()).toBe(false);
      process.env.FISHMEM_BELIEF_RECONCILIATION_DISABLED = "1";
      expect(config.derivation?.beliefs?.killSwitch?.()).toBe(true);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.FISHMEM_BELIEF_RECONCILIATION_ENABLED;
      } else {
        process.env.FISHMEM_BELIEF_RECONCILIATION_ENABLED = previousEnabled;
      }
      if (previousAllowlist === undefined) {
        delete process.env.FISHMEM_BELIEF_RECONCILIATION_ALLOWLIST;
      } else {
        process.env.FISHMEM_BELIEF_RECONCILIATION_ALLOWLIST = previousAllowlist;
      }
      if (previousDisabled === undefined) {
        delete process.env.FISHMEM_BELIEF_RECONCILIATION_DISABLED;
      } else {
        process.env.FISHMEM_BELIEF_RECONCILIATION_DISABLED = previousDisabled;
      }
    }
  });

  it("fails closed when rollout is enabled without a namespace allowlist", () => {
    const previousEnabled =
      process.env.FISHMEM_BELIEF_RECONCILIATION_ENABLED;
    const previousAllowlist =
      process.env.FISHMEM_BELIEF_RECONCILIATION_ALLOWLIST;
    process.env.FISHMEM_BELIEF_RECONCILIATION_ENABLED = "1";
    delete process.env.FISHMEM_BELIEF_RECONCILIATION_ALLOWLIST;
    try {
      expect(
        memoryDerivationConfig(true).derivation?.beliefs?.namespaceAllowlist,
      ).toEqual([]);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.FISHMEM_BELIEF_RECONCILIATION_ENABLED;
      } else {
        process.env.FISHMEM_BELIEF_RECONCILIATION_ENABLED = previousEnabled;
      }
      if (previousAllowlist === undefined) {
        delete process.env.FISHMEM_BELIEF_RECONCILIATION_ALLOWLIST;
      } else {
        process.env.FISHMEM_BELIEF_RECONCILIATION_ALLOWLIST = previousAllowlist;
      }
    }
  });
});

describe("engine config migration", () => {
  const migration = readFileSync(
    fileURLToPath(new URL("../../migrations/0012_engine_derivation.sql", import.meta.url)),
    "utf8",
  );

  async function legacyDatabase(mode: "raw" | "hybrid" | "extract") {
    const client = createClient({ url: "file::memory:" });
    await client.executeMultiple(`
      create table engine_config (
        id text primary key, embedder_model text, embedder_base_url text,
        embedder_api_key text, llm_provider text, llm_model text,
        llm_base_url text, llm_api_key text, default_mode text, updated_at integer
      );
      create table request_logs (id text primary key, credits integer not null default 0);
      insert into engine_config (id, default_mode) values ('default', '${mode}');
    `);
    return client;
  }

  it("maps legacy hybrid mode to the derivation overlay", async () => {
    const client = await legacyDatabase("hybrid");
    await client.executeMultiple(migration);
    const result = await client.execute(
      "select derivation_enabled from engine_config where id = 'default'",
    );
    expect(result.rows[0]?.derivation_enabled).toBe(1);
    client.close();
  });

  it("rejects legacy extract mode instead of silently degrading it", async () => {
    const client = await legacyDatabase("extract");
    await expect(client.executeMultiple(migration)).rejects.toThrow(
      /CHECK constraint failed/,
    );
    client.close();
  });
});

describe("structural namespace migration", () => {
  const migration = readFileSync(
    fileURLToPath(
      new URL("../../migrations/0013_structural_namespace.sql", import.meta.url),
    ),
    "utf8",
  );

  it("promotes legacy workspace metadata without retaining unsafe projections", async () => {
    const client = createClient({ url: "file::memory:" });
    const alterMarker = 'ALTER TABLE "fishmem_memories"';
    const alterOffset = migration.indexOf(alterMarker);
    expect(alterOffset).toBeGreaterThan(0);

    await client.executeMultiple(migration.slice(0, alterOffset));
    await client.executeMultiple(`
      insert into fishmem_memories (
        id, content, memory_type, metadata, created_at, updated_at,
        last_accessed_at, episode_id
      ) values
        ('source', 'source', 'semantic', '{"__ws":"ws_a","kind":"fact"}', 1, 1, 1, 'episode_a'),
        ('target', 'target', 'semantic', '{"__ws":"ws_b"}', 1, 1, 1, null);
      insert into fishmem_associations (
        id, source_id, target_id, relation_type, created_at
      ) values ('cross', 'source', 'target', 'related', 1);
      insert into fishmem_episodes (id, messages, created_at)
        values ('episode_a', '[]', 1);
      insert into fishmem_entities (
        id, name, normalized, mention_count, created_at
      ) values ('entity_a', 'Alice', 'alice', 1, 1);
      insert into fishmem_memory_entities (memory_id, entity_id)
        values ('source', 'entity_a');
      insert into fishmem_state_slots (
        id, subject, attribute, subject_key, attribute_key, value,
        valid_from, sources
      ) values ('slot_a', 'user', 'city', 'user', 'city', 'Taipei', 1, '[]');
    `);

    await client.executeMultiple(migration.slice(alterOffset));

    const memories = await client.execute(
      "select id, namespace_id, metadata from fishmem_memories order by id",
    );
    expect(memories.rows).toEqual([
      { id: "source", namespace_id: "ws_a", metadata: '{"kind":"fact"}' },
      { id: "target", namespace_id: "ws_b", metadata: "{}" },
    ]);
    const episode = await client.execute(
      "select namespace_id from fishmem_episodes where id = 'episode_a'",
    );
    expect(episode.rows[0]?.namespace_id).toBe("ws_a");

    for (const table of [
      "fishmem_associations",
      "fishmem_memory_entities",
      "fishmem_entities",
      "fishmem_state_slots",
    ]) {
      const result = await client.execute(`select count(*) as count from ${table}`);
      expect(Number(result.rows[0]?.count)).toBe(0);
    }
    client.close();
  });
});

describe("memory journal migration", () => {
  const migration = readFileSync(
    fileURLToPath(
      new URL("../../migrations/0014_memory_journal.sql", import.meta.url),
    ),
    "utf8",
  );

  it("enforces idempotency keys per namespace", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.executeMultiple(migration);
    const columns = await client.execute("pragma table_info(fishmem_operations)");
    expect(columns.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining(["lease_expires_at", "attempts"]),
    );
    const values = [
      "op_1",
      "alpha",
      "add-1",
      "add",
      "hash",
      "{}",
      "[]",
      "pending",
      "pending",
      "pending",
      "not_requested",
      1,
      1,
    ];
    await client.execute({
      sql: `insert into fishmem_operations (
        id, namespace_id, idempotency_key, kind, request_hash, command, memory_ids, status,
        raw_status, vector_status, derived_status, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: values,
    });
    await expect(
      client.execute({
        sql: `insert into fishmem_operations (
          id, namespace_id, idempotency_key, kind, request_hash, command, memory_ids, status,
          raw_status, vector_status, derived_status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ["op_2", ...values.slice(1)],
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(
      client.execute({
        sql: `insert into fishmem_operations (
          id, namespace_id, idempotency_key, kind, request_hash, command, memory_ids, status,
          raw_status, vector_status, derived_status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ["op_3", "beta", ...values.slice(2)],
      }),
    ).resolves.toBeDefined();
    client.close();
  });
});

describe("governed belief projection migration", () => {
  const migration = readFileSync(
    fileURLToPath(
      new URL(
        "../../migrations/0023_belief_reconciliation.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("adds only rebuild inputs to canonical rows and creates relational evidence indexes", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute(
      'create table "fishmem_memories" ("id" text primary key not null)',
    );
    await client.executeMultiple(migration);

    const memoryColumns = await client.execute(
      "pragma table_info(fishmem_memories)",
    );
    expect(memoryColumns.rows.map((row) => row.name)).toContain(
      "projection_hints",
    );
    const evidenceColumns = await client.execute(
      "pragma table_info(fishmem_belief_evidence)",
    );
    expect(evidenceColumns.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "source_id",
        "evidence_key",
        "context_id",
        "applicability_kind",
        "cluster_key",
        "candidate_key",
      ]),
    );
    const indexes = await client.execute(
      "pragma index_list(fishmem_belief_evidence)",
    );
    expect(indexes.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "fishmem_belief_slot_idx",
        "fishmem_belief_source_idx",
        "fishmem_belief_cluster_idx",
      ]),
    );
    client.close();
  });
});
