import { createClient } from "@libsql/client";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.FISHMEM_DB !== "libsql") {
	throw new Error("The local migration runner requires FISHMEM_DB=libsql");
}

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(appRoot, "migrations");
const databaseUrl = process.env.DATABASE_URL ?? "file:.data/fishmem.db";
const client = createClient({
	url: databaseUrl,
	...(process.env.DATABASE_AUTH_TOKEN
		? { authToken: process.env.DATABASE_AUTH_TOKEN }
		: {}),
});

try {
	await client.execute(`
		CREATE TABLE IF NOT EXISTS "_fishmem_schema_migrations" (
			"name" text PRIMARY KEY NOT NULL,
			"applied_at" integer NOT NULL
		)
	`);

	const migrations = (await readdir(migrationDirectory))
		.filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
		.sort();
	if (!migrations.length) throw new Error("No FishMem migrations were found");

	for (const name of migrations) {
		const transaction = await client.transaction("write");
		try {
			const applied = await transaction.execute({
				sql: 'SELECT 1 FROM "_fishmem_schema_migrations" WHERE "name" = ?',
				args: [name],
			});
			if (!applied.rows.length) {
				await transaction.executeMultiple(
					await readFile(path.join(migrationDirectory, name), "utf8"),
				);
				await transaction.execute({
					sql: `
						INSERT INTO "_fishmem_schema_migrations" ("name", "applied_at")
						VALUES (?, ?)
					`,
					args: [name, Date.now()],
				});
				console.log(`Applied ${name}`);
			}
			await transaction.commit();
		} catch (error) {
			if (!transaction.closed) await transaction.rollback();
			throw new Error(`Failed to apply ${name}`, { cause: error });
		} finally {
			if (!transaction.closed) transaction.close();
		}
	}

	const result = await client.execute(
		'SELECT COUNT(*) AS "count" FROM "_fishmem_schema_migrations"',
	);
	const count = Number(result.rows[0]?.count ?? 0);
	if (count !== migrations.length) {
		throw new Error(
			`Migration ledger contains ${count} rows; expected exactly ${migrations.length}`,
		);
	}
	console.log(`FishMem libSQL schema verified (${count} migrations)`);
} finally {
	client.close();
}
