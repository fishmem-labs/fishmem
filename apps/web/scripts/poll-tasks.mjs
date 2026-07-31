const baseUrl = (
  process.env.FISHMEM_TASK_WORKER_BASE_URL ?? "http://127.0.0.1:3000"
).replace(/\/+$/, "");
const secret = process.env.CRON_SECRET ?? "";
const intervalMs = Number(process.env.FISHMEM_TASK_POLL_MS ?? 2_000);
const maintenanceIntervalMs = Number(
  process.env.FISHMEM_MAINTENANCE_MS ?? 86_400_000,
);

if (!secret) {
  throw new Error("CRON_SECRET is required by the FishMem task worker");
}
if (!Number.isFinite(intervalMs) || intervalMs < 250) {
  throw new Error("FISHMEM_TASK_POLL_MS must be at least 250 milliseconds");
}
if (
  !Number.isFinite(maintenanceIntervalMs) ||
  maintenanceIntervalMs < 60_000
) {
  throw new Error("FISHMEM_MAINTENANCE_MS must be at least 60000 milliseconds");
}

let stopped = false;
process.on("SIGINT", () => {
  stopped = true;
});
process.on("SIGTERM", () => {
  stopped = true;
});

async function invoke(path, label) {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    if (!response.ok) {
      console.error(
        `FishMem ${label} failed:`,
        response.status,
        await response.text(),
      );
    }
  } catch (error) {
    console.error(`FishMem ${label} could not reach the web service:`, error);
  }
}

let nextMaintenanceAt = 0;
while (!stopped) {
  await invoke("/api/cron/tasks", "task poll");
  if (Date.now() >= nextMaintenanceAt) {
    await invoke("/api/cron/maintenance", "scheduled maintenance");
    nextMaintenanceAt = Date.now() + maintenanceIntervalMs;
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
