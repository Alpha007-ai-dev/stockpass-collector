import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("input validation", () => {
	it("/series requires a ticker", async () => {
		expect((await SELF.fetch("https://example.com/series")).status).toBe(400);
	});

	it("/series rejects a malformed ticker", async () => {
		expect((await SELF.fetch("https://example.com/series?ticker=a%27b")).status).toBe(400);
	});

	it("/prices requires symbols", async () => {
		expect((await SELF.fetch("https://example.com/prices")).status).toBe(400);
	});

	it("/holdings requires an owner", async () => {
		expect((await SELF.fetch("https://example.com/holdings")).status).toBe(400);
	});

	it("/rebuild-cache is unauthorized without the admin key", async () => {
		expect((await SELF.fetch("https://example.com/rebuild-cache")).status).toBe(401);
	});
});
