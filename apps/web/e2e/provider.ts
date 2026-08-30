import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const port = 3111;

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function embedding() {
  const vector = Array.from({ length: 1536 }, () => 0);
  vector[0] = 1;
  return vector;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);

  if (request.method === "GET" && url.pathname === "/health") {
    return sendJson(response, 200, { ok: true });
  }

  if (request.method !== "POST") {
    return sendJson(response, 404, { error: { message: "Not found" } });
  }

  try {
    const body = await readJson(request);
    if (url.pathname === "/v1/embeddings") {
      const input = Array.isArray(body.input) ? body.input : [body.input];
      return sendJson(response, 200, {
        object: "list",
        data: input.map((_, index) => ({
          object: "embedding",
          index,
          embedding: embedding(),
        })),
        model: body.model,
        usage: { prompt_tokens: input.length, total_tokens: input.length },
      });
    }

    if (url.pathname === "/v1/chat/completions") {
      const content = JSON.stringify({
        facts: [
          {
            text: "Ada prefers oolong tea",
            category: "User preferences",
            event_date: null,
            entities: ["Ada", "oolong tea"],
            subject: "Ada",
            attribute: "drink_preference",
            type: "preference",
            cardinality: "multi",
          },
          {
            text: "Ada avoids coffee",
            category: "User preferences",
            event_date: null,
            entities: ["Ada", "coffee"],
            subject: "Ada",
            attribute: "drink_avoidance",
            type: "preference",
            cardinality: "multi",
          },
        ],
      });
      return sendJson(response, 200, {
        id: "chatcmpl_fishmem_e2e",
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 10,
          total_tokens: 20,
        },
      });
    }

    return sendJson(response, 404, {
      error: { message: `Unsupported provider path: ${url.pathname}` },
    });
  } catch (error) {
    return sendJson(response, 400, {
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

server.listen(port, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
