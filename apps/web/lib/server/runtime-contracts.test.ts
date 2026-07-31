import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  apiTokenAuthFailure,
  memoryDerivationConfig,
} from "./runtime-contracts";

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
    expect(memoryDerivationConfig(false)).toEqual({});
    expect(memoryDerivationConfig(true, sidecar)).toEqual({
      derivation: { enabled: true, schedule: "inline", sidecar },
    });
    expect(memoryDerivationConfig(true, sidecar)).not.toHaveProperty("mode");
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
