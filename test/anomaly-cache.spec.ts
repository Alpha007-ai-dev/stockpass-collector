import { describe, it, expect } from "vitest";
import { handleExplainAnomaly } from "../src/anomaly";

const NOW = Math.floor(Date.now() / 1000);

// In-memory stand-in for the statements the handler issues.
function fakeDb() {
	const cache = new Map<string, { body: string; updated_at: number }>();
	const db: any = {
		prepare(sql: string) {
			let args: any[] = [];
			const q: any = {
				bind: (...a: any[]) => ((args = a), q),
				first: async () => {
					if (sql.includes("FROM response_cache")) return cache.get(args[0]) ?? null;
					if (sql.includes("FROM tokens")) return args[0] === "SPYx" ? { ticker: "SPY" } : null;
					if (sql.includes("ORDER BY ts DESC LIMIT 1")) return { ts: NOW - 60, entry_bps: 31, quotable: 1, market_state: "open" };
					if (sql.includes("COUNT(*) AS total")) return { total: 40, quoted: 40, obs: 40, lo: 10, hi: 12 };
					if (sql.includes("FROM events")) return { d: null };
					return null;
				},
				run: async () => {
					if (sql.startsWith("INSERT INTO response_cache")) cache.set(args[0], { body: args[1], updated_at: args[2] });
					return {};
				},
			};
			return q;
		},
	};
	return { db, cache };
}

let calls = 0;
const claude = (text: string) =>
	(async () => {
		calls++;
		return new Response(JSON.stringify({ content: [{ type: "text", text }] }));
	}) as unknown as typeof fetch;

const ask = (db: any, key: string | undefined, f: typeof fetch) =>
	handleExplainAnomaly(new URL("https://w/explain-anomaly?symbol=SPYx"), { DB: db, ANTHROPIC_API_KEY: key }, f);

describe("explain-anomaly failure cache", () => {
	it("does not call Claude again within two minutes after a rejected answer", async () => {
		const { db } = fakeDb();
		calls = 0;
		const bad = claude("This happened because of earnings."); // fails validation (causal wording)
		for (let i = 0; i < 5; i++) {
			const body: any = await (await ask(db, "k", bad)).json();
			expect(body.anomaly).toBe(true);
			expect(body.explanation_status).toBe("unavailable");
		}
		expect(calls).toBe(1);
	});
	it("never caches a missing key, so setting it works at once", async () => {
		const { db, cache } = fakeDb();
		calls = 0;
		await ask(db, undefined, claude("x"));
		expect(calls).toBe(0);
		expect(cache.size).toBe(0);
		const good = claude("The entry cost is 19 bps above the observed range of 10 to 12 bps.");
		const body: any = await (await ask(db, "k", good)).json();
		expect(calls).toBe(1);
		expect(body.explanation_status).toBe("ok");
	});
	it("serves a good answer from the normal cache", async () => {
		const { db } = fakeDb();
		calls = 0;
		const good = claude("The entry cost is 19 bps above the observed range of 10 to 12 bps.");
		await ask(db, "k", good);
		await ask(db, "k", good);
		expect(calls).toBe(1);
	});
});
