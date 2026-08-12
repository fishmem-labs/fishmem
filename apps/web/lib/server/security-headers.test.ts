import { describe, expect, it } from "vitest";
import { withSecurityHeaders } from "./security-headers";

describe("withSecurityHeaders", () => {
	it("hardens every HTTPS response while preserving status and application headers", () => {
		const source = new Response("ok", {
			status: 202,
			headers: { "x-request-id": "req_1" },
		});
		const response = withSecurityHeaders(
			source,
			new Request("https://fishmem.test/v1/memories"),
		);

		expect(response.status).toBe(202);
		expect(response.headers.get("x-request-id")).toBe("req_1");
		expect(response.headers.get("strict-transport-security")).toContain(
			"max-age=63072000",
		);
		expect(response.headers.get("content-security-policy")).toContain(
			"frame-ancestors 'none'",
		);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("x-frame-options")).toBe("DENY");
	});

	it("does not advertise HSTS on local HTTP development responses", () => {
		const response = withSecurityHeaders(
			new Response("ok"),
			new Request("http://localhost:3000"),
		);
		expect(response.headers.has("strict-transport-security")).toBe(false);
	});
});
