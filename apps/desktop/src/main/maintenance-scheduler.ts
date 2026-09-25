export type MaintenanceTimers = {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
};

export type MaintenanceSchedulerOptions<T> = {
	run(): Promise<T>;
	isReady(): boolean;
	isBusy(): boolean;
	log?: (message: string, detail?: unknown) => void;
	/** Delay before the first pass after startup. */
	initialDelayMs?: number;
	/** Delay between successful passes. */
	intervalMs?: number;
	/** Delay before retrying a pass skipped because Desktop was busy or not ready. */
	retryDelayMs?: number;
	timers?: MaintenanceTimers;
};

const DAY_MS = 24 * 60 * 60 * 1_000;

const defaultTimers: MaintenanceTimers = {
	setTimeout(callback, delayMs) {
		const handle = setTimeout(callback, delayMs);
		(handle as { unref?: () => void }).unref?.();
		return handle;
	},
	clearTimeout(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

/**
 * Runs Desktop maintenance once shortly after startup and then every 24
 * hours. A pass never starts while requests are in flight or before the local
 * embedding runtime is ready; it is retried later instead.
 */
export class MaintenanceScheduler<T> {
	private handle: unknown;
	private running = false;
	private stopped = true;
	private readonly timers: MaintenanceTimers;

	constructor(private readonly options: MaintenanceSchedulerOptions<T>) {
		this.timers = options.timers ?? defaultTimers;
	}

	start() {
		if (!this.stopped) return;
		this.stopped = false;
		this.schedule(this.options.initialDelayMs ?? 60_000);
	}

	stop() {
		this.stopped = true;
		if (this.handle !== undefined) this.timers.clearTimeout(this.handle);
		this.handle = undefined;
	}

	/** Attempt one pass now. Resolves to undefined when the pass was skipped. */
	async tick(): Promise<T | undefined> {
		const log = this.options.log ?? defaultLog;
		if (this.running) return undefined;
		if (!this.options.isReady()) {
			log("FishMem maintenance skipped: local memory is not ready");
			this.schedule(this.options.retryDelayMs ?? 10 * 60_000);
			return undefined;
		}
		if (this.options.isBusy()) {
			log("FishMem maintenance deferred: requests are in flight");
			this.schedule(this.options.retryDelayMs ?? 10 * 60_000);
			return undefined;
		}
		this.running = true;
		try {
			const result = await this.options.run();
			log("FishMem maintenance completed", result);
			this.schedule(this.options.intervalMs ?? DAY_MS);
			return result;
		} catch (error) {
			log(
				"FishMem maintenance failed",
				error instanceof Error ? error.message : String(error),
			);
			this.schedule(this.options.retryDelayMs ?? 10 * 60_000);
			return undefined;
		} finally {
			this.running = false;
		}
	}

	private schedule(delayMs: number) {
		if (this.stopped) return;
		if (this.handle !== undefined) this.timers.clearTimeout(this.handle);
		this.handle = this.timers.setTimeout(() => {
			this.handle = undefined;
			void this.tick();
		}, delayMs);
	}
}

function defaultLog(message: string, detail?: unknown) {
	if (detail === undefined) console.info(message);
	else console.info(message, detail);
}
