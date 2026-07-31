export type OperationQueueBody = { task_id: string };

export type OperationQueueMessage = {
  id: string;
  body?: Partial<OperationQueueBody> | null;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

export type OperationQueueBatch = {
  queue: string;
  messages: readonly OperationQueueMessage[];
};

export type OperationQueueSender = {
  send(
    body: OperationQueueBody,
    options?: { delaySeconds?: number },
  ): Promise<void>;
};

export type OperationQueueProcessor = (
  taskId: string,
) => Promise<{ continued: number }>;

export type OperationQueueDeliveryExhaustedHandler = (
  taskId: string,
  input: { queueName: string; messageId: string },
) => Promise<unknown>;

/**
 * Owns the complete Queue transport policy while D1 remains the application
 * state machine. OSS and Hosted workers inject their task/accounting adapter
 * rather than maintaining two subtly different queue consumers.
 */
export async function handleOperationQueueBatch(input: {
  batch: OperationQueueBatch;
  mainQueue: OperationQueueSender;
  processTask: OperationQueueProcessor;
  markDeliveryExhausted: OperationQueueDeliveryExhaustedHandler;
  logger?: Pick<Console, "error">;
}) {
  const logger = input.logger ?? console;
  const deadLetterDelivery = input.batch.queue.endsWith("-dlq");
  for (const message of input.batch.messages) {
    const taskId = message.body?.task_id;
    if (!taskId) {
      logger.error("Ignoring malformed operation task message", message.id);
      message.ack();
      continue;
    }

    if (deadLetterDelivery) {
      try {
        await input.markDeliveryExhausted(taskId, {
          queueName: input.batch.queue,
          messageId: message.id,
        });
        message.ack();
      } catch (error) {
        logger.error(
          "Operation task DLQ persistence failure",
          taskId,
          error,
        );
        message.retry({ delaySeconds: 300 });
      }
      continue;
    }

    try {
      const outcome = await input.processTask(taskId);
      // A continuation is durable in D1. Re-enqueue a prompt wakeup; cron
      // repair remains the fallback if this send itself fails.
      if (outcome.continued > 0) {
        await input.mainQueue.send(
          { task_id: taskId },
          { delaySeconds: 1 },
        );
      }
      message.ack();
    } catch (error) {
      logger.error("Operation task queue infrastructure failure", taskId, error);
      message.retry({ delaySeconds: 60 });
    }
  }
}
