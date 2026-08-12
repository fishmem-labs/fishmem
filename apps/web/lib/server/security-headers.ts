const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"base-uri 'self'",
	"object-src 'none'",
	"frame-ancestors 'none'",
	"form-action 'self'",
	"script-src 'self' 'unsafe-inline'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: https://images.unsplash.com https://cms.fishmem.com",
	"font-src 'self' data:",
	"connect-src 'self'",
	"worker-src 'self' blob:",
	"manifest-src 'self'",
].join("; ");

export function withSecurityHeaders(response: Response, request: Request) {
	const secured = new Response(response.body, response);
	secured.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
	secured.headers.set("Cross-Origin-Opener-Policy", "same-origin");
	secured.headers.set("Cross-Origin-Resource-Policy", "same-origin");
	secured.headers.set(
		"Permissions-Policy",
		"camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	);
	secured.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
	secured.headers.set("X-Content-Type-Options", "nosniff");
	secured.headers.set("X-Frame-Options", "DENY");
	if (new URL(request.url).protocol === "https:") {
		secured.headers.set(
			"Strict-Transport-Security",
			"max-age=63072000; includeSubDomains",
		);
	}
	return secured;
}
