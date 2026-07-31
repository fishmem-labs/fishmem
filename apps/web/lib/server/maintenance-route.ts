import { workspaces } from "@/db/schema";
import { getRuntimeEnv } from "@/lib/cloudflare";
import { getMemoryEngine } from "@/lib/server/memory-api";
import { processPendingMemoryTasks } from "@/lib/server/memory-task-worker";
import {
  enqueueOperationTask,
} from "@/lib/server/operation-tasks";
import { getServerDb } from "@/lib/server/user";
import { processWebhookOutbox } from "@/lib/server/webhook-outbox";
import { createDocumentIngestion } from "@/lib/server/document-ingestion";

async function authorizeCron(request: Request) {
  const env = await getRuntimeEnv();
  const secret =
    (env as { CRON_SECRET?: string }).CRON_SECRET ?? process.env.CRON_SECRET;
  const provided = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) {
    return false;
  }
  return true;
}

export async function runPendingOperationTasks(request: Request) {
  if (!(await authorizeCron(request))) {
    return Response.json({ message: "Unauthorized" }, { status: 401 });
  }
  const db = await getServerDb();
  const memory = await getMemoryEngine();
  return Response.json({
    ok: true,
    tasks: await processPendingMemoryTasks(db, memory),
    webhooks: await processWebhookOutbox(db),
  });
}

export async function runScheduledMaintenance(request: Request) {
  if (!(await authorizeCron(request))) {
    return Response.json({ message: "Unauthorized" }, { status: 401 });
  }
  const db = await getServerDb();
  const memory = await getMemoryEngine();
  const allWorkspaces = await db
    .select({ documentId: workspaces.documentId })
    .from(workspaces);
  const bucket = new Date().toISOString().slice(0, 13);
  for (const workspace of allWorkspaces) {
    await enqueueOperationTask(db, {
      workspaceId: workspace.documentId,
      operationId: `maintenance:${bucket}`,
      kind: "maintenance",
      payload: {},
    });
  }
  const tasks = await processPendingMemoryTasks(db, memory);
  const documentIngestion = await createDocumentIngestion(db);
  const expiredUploads = await documentIngestion.deleteExpiredUploads(
    new Date(Date.now() - 24 * 60 * 60_000),
  );
  const expiredFailures = await documentIngestion.deleteExpiredFailures(
    new Date(Date.now() - 30 * 24 * 60 * 60_000),
  );
  return Response.json({
    ok: true,
    tasks,
    expired_uploads: expiredUploads,
    expired_failures: expiredFailures,
    webhooks: await processWebhookOutbox(db),
  });
}
