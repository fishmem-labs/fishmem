import { describe, expect, it, vi } from "vitest";
import {
  handleOperationQueueBatch,
  type OperationQueueMessage,
} from "./operation-queue";

function message(taskId = "task-1") {
  return {
    id: "message-1",
    body: { task_id: taskId },
    ack: vi.fn(),
    retry: vi.fn(),
  } satisfies OperationQueueMessage;
}

describe("operation queue transport", () => {
  it("acknowledges durable outcomes and promptly wakes continuations", async () => {
    const queued = message();
    const send = vi.fn().mockResolvedValue(undefined);
    const processTask = vi.fn().mockResolvedValue({ continued: 1 });
    const markDeliveryExhausted = vi.fn();

    await handleOperationQueueBatch({
      batch: { queue: "fishmem-document-tasks", messages: [queued] },
      mainQueue: { send },
      processTask,
      markDeliveryExhausted,
    });

    expect(processTask).toHaveBeenCalledWith("task-1");
    expect(send).toHaveBeenCalledWith(
      { task_id: "task-1" },
      { delaySeconds: 1 },
    );
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(markDeliveryExhausted).not.toHaveBeenCalled();
  });

  it("uses Queue retry only for infrastructure failures", async () => {
    const queued = message();
    await handleOperationQueueBatch({
      batch: { queue: "fishmem-document-tasks", messages: [queued] },
      mainQueue: { send: vi.fn() },
      processTask: vi.fn().mockRejectedValue(new Error("D1 unavailable")),
      markDeliveryExhausted: vi.fn(),
      logger: { error: vi.fn() },
    });

    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });

  it("persists DLQ delivery without executing the task again", async () => {
    const queued = message();
    const processTask = vi.fn();
    const markDeliveryExhausted = vi.fn().mockResolvedValue(undefined);
    await handleOperationQueueBatch({
      batch: { queue: "fishmem-document-tasks-dlq", messages: [queued] },
      mainQueue: { send: vi.fn() },
      processTask,
      markDeliveryExhausted,
    });

    expect(markDeliveryExhausted).toHaveBeenCalledWith("task-1", {
      queueName: "fishmem-document-tasks-dlq",
      messageId: "message-1",
    });
    expect(processTask).not.toHaveBeenCalled();
    expect(queued.ack).toHaveBeenCalledOnce();
  });

  it("retries a DLQ message when its canonical state was not persisted", async () => {
    const queued = message();
    await handleOperationQueueBatch({
      batch: { queue: "fishmem-document-tasks-dlq", messages: [queued] },
      mainQueue: { send: vi.fn() },
      processTask: vi.fn(),
      markDeliveryExhausted: vi
        .fn()
        .mockRejectedValue(new Error("D1 unavailable")),
      logger: { error: vi.fn() },
    });

    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
  });
});
