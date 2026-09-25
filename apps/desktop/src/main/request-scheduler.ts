const noop = () => undefined;

/**
 * Schedules Desktop requests so reads never wait behind slow writes.
 *
 * - Writes are serialized on one queue (the engine journal and idempotency
 *   claims assume one local writer).
 * - Reads run immediately and concurrently with the current write. The
 *   database runs in WAL mode, so readers see the last committed state.
 * - Exclusive operations (restore, import, delete-all) run on the write queue
 *   and additionally wait for in-flight reads to drain and hold new reads back
 *   until they finish, so no reader observes a half-replaced library.
 */
export class RequestScheduler {
	private writeTail: Promise<void> = Promise.resolve();
	private pendingWrites = 0;
	private readonly activeReads = new Set<Promise<void>>();
	private exclusiveGate?: Promise<void>;

	/** True while any read or write is queued or running. */
	get busy(): boolean {
		return (
			this.pendingWrites > 0 ||
			this.activeReads.size > 0 ||
			this.exclusiveGate !== undefined
		);
	}

	get queuedWrites(): number {
		return this.pendingWrites;
	}

	async read<T>(task: () => Promise<T>): Promise<T> {
		while (this.exclusiveGate) await this.exclusiveGate;
		const run = Promise.resolve().then(task);
		const tracked = run.then(noop, noop);
		this.activeReads.add(tracked);
		try {
			return await run;
		} finally {
			this.activeReads.delete(tracked);
		}
	}

	write<T>(task: () => Promise<T>): Promise<T> {
		this.pendingWrites += 1;
		const run = this.writeTail.then(task);
		this.writeTail = run.then(noop, noop);
		return run.finally(() => {
			this.pendingWrites -= 1;
		});
	}

	exclusive<T>(task: () => Promise<T>): Promise<T> {
		return this.write(async () => {
			let release: () => void = noop;
			this.exclusiveGate = new Promise<void>((resolve) => {
				release = resolve;
			});
			try {
				while (this.activeReads.size > 0) {
					await Promise.all([...this.activeReads]);
				}
				return await task();
			} finally {
				this.exclusiveGate = undefined;
				release();
			}
		});
	}

	/** Resolves once every write queued before this call has settled. */
	flushWrites(): Promise<void> {
		return this.write(async () => undefined);
	}
}
