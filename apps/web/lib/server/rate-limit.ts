export const PUBLIC_API_RATE_LIMIT = 600;
export const PUBLIC_API_RATE_WINDOW_SECONDS = 60;

type RateLimiter = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

async function requestIdentity(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const identity =
    bearer ||
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    "anonymous";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function enforcePublicApiRateLimit(
  request: Request,
  limiter: RateLimiter,
) {
  const outcome = await limiter.limit({ key: await requestIdentity(request) });
  if (outcome.success) return null;
  const requestId = crypto.randomUUID();
  const response = Response.json(
    {
      code: "RATE_LIMITED",
      message: "Public API rate limit exceeded",
      request_id: requestId,
    },
    { status: 429 },
  );
  response.headers.set("Retry-After", String(PUBLIC_API_RATE_WINDOW_SECONDS));
  response.headers.set("x-request-id", requestId);
  return withPublicApiRateHeaders(response);
}

export function withPublicApiRateHeaders(response: Response) {
  const shaped = new Response(response.body, response);
  shaped.headers.set("RateLimit-Limit", String(PUBLIC_API_RATE_LIMIT));
  shaped.headers.set(
    "RateLimit-Policy",
    `${PUBLIC_API_RATE_LIMIT};w=${PUBLIC_API_RATE_WINDOW_SECONDS}`,
  );
  shaped.headers.set("X-RateLimit-Limit", String(PUBLIC_API_RATE_LIMIT));
  return shaped;
}
