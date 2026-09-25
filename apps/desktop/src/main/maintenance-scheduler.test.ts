import { describe, expect, it, vi } from "vitest";
import { MaintenanceScheduler } from "./maintenance-scheduler";

function fakeTimers() {
	const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
	return {
		scheduled,
		timers: {
			setTimeout(callback: () => void, delayMs: number) {
				const entry = { callback, delayMs };
				scheduled.push(entry);
				return entry;
			},
			clearTimeout(handle: unknown) {
				const index = scheduled.indexOf(handle as (typeof scheduled)[number]);
				if (index >= 0) scheduled.splice(index, 1);
			},
		},
	};
}

describe("MaintenanceScheduler", () => {
	it("runs after startup, then daily, and defers while busy or not ready", async () => {
		const { scheduled, timers } = fakeTimers();
		let ready = false;
		let busy = false;
		const run = vi.fn().mockResolvedValue({ removed: 0 });
		const log = vi.fn();
		const scheduler = new MaintenanceScheduler({
			run,
			isReady: () => ready,
			isBusy: () => busy,
			log,
			initialDelayMs: 1_000,
			intervalMs: 86_400_000,
			retryDelayMs: 600_000,
			timers,
		});
		scheduler.start();
		expect(scheduled.map((entry) => entry.delayMs)).toEqual([1_000]);

		await expect(scheduler.tick()).resolves.toBeUndefined();
		expect(run).not.toHaveBeenCalled();
		expect(scheduled.map((entry) => entry.delayMs)).toEqual([600_000]);

		ready = true;
		busy = true;
		await expect(scheduler.tick()).resolves.toBeUndefined();
		expect(run).not.toHaveBeenCalled();

		busy = false;
		await expect(scheduler.tick()).resolves.toEqual({ removed: 0 });
		expect(run).toHaveBeenCalledTimes(1);
		expect(scheduled.map((entry) => entry.delayMs)).toEqual([86_400_000]);
		expect(log).toHaveBeenCalledWith("FishMem maintenance completed", {
			removed: 0,
		});

		scheduler.stop();
		expect(scheduled).toEqual([]);
	});

	it("logs failures and retries later", async () => {
		const { scheduled, timers } = fakeTimers();
		const log = vi.fn();
		const scheduler = new MaintenanceScheduler({
			run: vi.fn().mockRejectedValue(new Error("disk full")),
			isReady: () => true,
			isBusy: () => false,
			log,
			retryDelayMs: 5,
			timers,
		});
		scheduler.start();
		await scheduler.tick();
		expect(log).toHaveBeenCalledWith("FishMem maintenance failed", "disk full");
		expect(scheduled.map((entry) => entry.delayMs)).toEqual([5]);
		scheduler.stop();
	});
});
