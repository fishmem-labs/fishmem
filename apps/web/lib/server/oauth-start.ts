import { getAuth } from "@/lib/auth";

type OAuthProvider = "google" | "github";

function relativePath(value: string | null, fallback: string) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : fallback;
}

function errorRedirect(requestUrl: URL, errorPath: string) {
  const url = new URL(errorPath, requestUrl.origin);
  url.searchParams.set("error", "oauth_start_failed");
  return Response.redirect(url, 302);
}

export async function startOAuth(
  request: Request,
  provider: OAuthProvider,
) {
  const requestUrl = new URL(request.url);
  const callbackURL = relativePath(
    requestUrl.searchParams.get("callbackUrl"),
    "/dashboard",
  );
  const errorCallbackURL = relativePath(
    requestUrl.searchParams.get("errorCallbackUrl"),
    provider === "google" && callbackURL.startsWith("/admin")
      ? "/admin/login"
      : "/login",
  );
  const allowedHost =
    provider === "google" ? "accounts.google.com" : "github.com";

  try {
    const result = await (await getAuth()).api.signInSocial({
      body: {
        provider,
        callbackURL,
        errorCallbackURL,
        disableRedirect: true,
      },
      headers: request.headers,
    });
    if (!result.url) return errorRedirect(requestUrl, errorCallbackURL);
    const destination = new URL(result.url);
    if (
      destination.protocol !== "https:" ||
      destination.hostname !== allowedHost
    ) {
      return errorRedirect(requestUrl, errorCallbackURL);
    }
    return new Response(null, {
      status: 302,
      headers: {
        "cache-control": "no-store",
        location: destination.toString(),
      },
    });
  } catch (error) {
    console.error(`${provider} auth start failed`, error);
    return errorRedirect(requestUrl, errorCallbackURL);
  }
}
