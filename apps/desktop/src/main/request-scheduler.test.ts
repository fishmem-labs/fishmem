import { describe, expect, it } from "vitest";
import { RequestScheduler } from "./request-scheduler";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("RequestScheduler", () => {
	it("runs reads while a slow write is in progress and serializes writes", async () => {
		const scheduler = new RequestScheduler();
		const slow = deferred();
		const order: string[] = [];
		const ingest = scheduler.write(async () => {
			await slow.promise;
			order.push("ingest");
		});
		const add = scheduler.write(async () => {
			order.push("add");
		});
		await expect(scheduler.read(async () => "search")).resolves.toBe("search");
		expect(order).toEqual([]);
		expect(scheduler.busy).toBe(true);
		slow.resolve();
		await Promise.all([ingest, add]);
		expect(order).toEqual(["ingest", "add"]);
		expect(scheduler.busy).toBe(false);
	});

	it("keeps the write queue alive after a failed write", async () => {
		const scheduler = new RequestScheduler();
		await expect(
			scheduler.write(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await expect(scheduler.write(async () => 1)).resolves.toBe(1);
	});

	it("drains reads before an exclusive operation and holds new reads until it ends", async () => {
		const scheduler = new RequestScheduler();
		const reading = deferred();
		const restoring = deferred();
		const order: string[] = [];
		const read = scheduler.read(async () => {
			await reading.promise;
			order.push("read-1");
		});
		const restore = scheduler.exclusive(async () => {
			order.push("restore-start");
			await restoring.promise;
			order.push("restore-end");
		});
		await Promise.resolve();
		const laterRead = scheduler.read(async () => {
			order.push("read-2");
		});
		reading.resolve();
		await read;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(order).toEqual(["read-1", "restore-start"]);
		restoring.resolve();
		await Promise.all([restore, laterRead]);
		expect(order).toEqual(["read-1", "restore-start", "restore-end", "read-2"]);
	});
});
