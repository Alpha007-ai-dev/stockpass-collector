import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import worker from "../src/index";
import schema from "../schema.sql?raw";
import tokens from "../tokens.sql?raw";
import sizeTests from "../size-tests.sql?raw";
import responseCache from "../response-cache.sql?raw";

const run = async (sql: string) => {
	for (const stmt of sql.replace(/^﻿/, "").split(";").map((s) => s.trim()).filter(Boolean)) await env.DB.prepare(stmt).run();
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// Fake upstreams: Jupiter search, Jupiter Ultra order, Solana RPC.
function mockFetch(opts: { ultra?: () => Response; rpc?: () => Response }) {
	return vi.spyOn(globalThis, "fetch").mockImplementation((async (input: any) => {
		const url = String(typeof input === "string" ? input : input.url);
		if (url.includes("/tokens/v2/search")) {
			const t = decodeURIComponent(url.split("query=")[1]);
			return json([
				{ id: `mint-${t}x`, symbol: `${t}x`, name: t, decimals: 8, isVerified: true },
				{ id: `mint-${t}on`, symbol: `${t}on`, name: t, decimals: 8, isVerified: true },
			]);
		}
		if (url.includes("/ultra/v1/order")) return opts.ultra ? opts.ultra() : json({ outAmount: "1000000" });
		if (url.includes("solana-rpc") || url.includes("publicnode")) return opts.rpc ? opts.rpc() : json({ result: { value: [] } });
		return json({});
	}) as any);
}

const count = async (table: string, where = "1=1") =>
	Number(((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first()) as any).n);

describe("collect (mocked upstreams)", () => {
	beforeAll(async () => {
		await run(schema);
		await run(tokens);
		// icon/name were added to the live table after tokens.sql was written
		await run("ALTER TABLE tokens ADD COLUMN icon TEXT; ALTER TABLE tokens ADD COLUMN name TEXT");
		await run(sizeTests);
		await run(responseCache);
	});
	beforeEach(async () => {
		await env.DB.prepare("DELETE FROM measurements").run();
		await env.DB.prepare("DELETE FROM size_tests").run();
		await env.DB.prepare("DELETE FROM tokens").run();
		const orig = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: any) => orig(fn, 0)) as any);
	});
	afterEach(() => vi.restoreAllMocks());

	const call = async () => {
		const ctx = createExecutionContext();
		const res = await worker.fetch(new Request("http://x/run"), env as any, ctx);
		await waitOnExecutionContext(ctx);
		return res.json() as Promise<{ inserted: number }>;
	};

	it("stores quotable measurements and size tests on a healthy round", async () => {
		mockFetch({});
		const { inserted } = await call();
		expect(inserted).toBeGreaterThan(0);
		expect(await count("measurements", "quotable = 1")).toBe(inserted);
		expect(await count("size_tests")).toBe(2);
	});

	it("does not record rate-limited quotes as unquotable", async () => {
		mockFetch({ ultra: () => json({ error: "rate limited" }, 429) });
		const { inserted } = await call();
		expect(inserted).toBe(0);
		expect(await count("measurements")).toBe(0);
		expect(await count("size_tests")).toBe(0);
	});

	it("still records a genuine 'no quote' as unquotable", async () => {
		mockFetch({ ultra: () => json({ error: "no route" }, 400) });
		const { inserted } = await call();
		expect(inserted).toBeGreaterThan(0);
		expect(await count("measurements", "quotable = 0")).toBe(inserted);
	});

	it("skips the round when the RPC fails", async () => {
		mockFetch({ rpc: () => json({ error: { message: "boom" } }, 500) });
		const { inserted } = await call();
		expect(inserted).toBe(0);
		expect(await count("measurements")).toBe(0);
	});
});
