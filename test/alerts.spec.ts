import { describe, it, expect } from "vitest";
import { evaluate, handleAlerts, MAX_AGE_S, MAX_ALERTS_PER_OWNER } from "../src/alerts";

const OWNER = "7oUXJtg1zdvqRFSAaKHsbisaWBDjEywBzQiueqpCLgkY";
const NOW = 1_800_000_000;

describe("evaluate", () => {
	it("triggers at or below the threshold with a fresh quote", () => {
		expect(evaluate(5, { ts: NOW - 60, entry_bps: 4, quotable: 1 }, NOW).triggered).toBe(true);
		expect(evaluate(5, { ts: NOW - 60, entry_bps: 5, quotable: 1 }, NOW).triggered).toBe(true);
		expect(evaluate(5, { ts: NOW - 60, entry_bps: 6, quotable: 1 }, NOW).triggered).toBe(false);
	});
	it("counts negative costs as 0", () => {
		const r = evaluate(0, { ts: NOW, entry_bps: -3, quotable: 1 }, NOW);
		expect(r.current_bps).toBe(0);
		expect(r.triggered).toBe(true);
	});
	it("never triggers on a stale or unquotable measurement", () => {
		expect(evaluate(5, { ts: NOW - MAX_AGE_S - 1, entry_bps: 1, quotable: 1 }, NOW).triggered).toBe(false);
		expect(evaluate(5, { ts: NOW, entry_bps: 1, quotable: 0 }, NOW).triggered).toBe(false);
		expect(evaluate(5, null, NOW).triggered).toBe(false);
	});
});

// A tiny in-memory stand-in for the three statements the handler uses.
function fakeDb() {
	const alerts = new Map<string, any>();
	const db: any = {
		prepare(sql: string) {
			let args: any[] = [];
			const q: any = {
				bind: (...a: any[]) => ((args = a), q),
				first: async () => {
					if (sql.includes("FROM tokens")) return args[0] === "SPYx" ? { ticker: "SPY" } : null;
					if (sql.includes("FROM measurements")) return { ts: Math.floor(Date.now() / 1000), entry_bps: 4, quotable: 1 };
					return null;
				},
				all: async () => ({ results: [...alerts.values()].filter((a) => a.owner === args[0]) }),
				run: async () => {
					if (sql.startsWith("INSERT")) {
						const [owner, symbol, ticker, threshold_bps, , max] = args;
						const mine = [...alerts.values()].filter((x) => x.owner === owner);
						if (mine.length >= max && !mine.some((x) => x.symbol === symbol)) return { meta: { changes: 0 } };
						alerts.set(owner + symbol, { owner, symbol, ticker, threshold_bps });
						return { meta: { changes: 1 } };
					}
					if (sql.startsWith("DELETE")) alerts.delete(args[0] + args[1]);
					return { meta: { changes: 1 } };
				},
			};
			return q;
		},
	};
	return { db, alerts };
}

const call = (db: any, method: string, path: string, body?: unknown) =>
	handleAlerts(new Request("https://w" + path, { method, body: body ? JSON.stringify(body) : undefined }), { DB: db });

describe("alerts handler", () => {
	it("creates, lists with status and deletes", async () => {
		const { db } = fakeDb();
		expect((await call(db, "POST", "/alerts", { owner: OWNER, symbol: "SPYx", threshold_bps: 5 })).status).toBe(200);
		const list: any = await (await call(db, "GET", `/alerts?owner=${OWNER}`)).json();
		expect(list.alerts.length).toBe(1);
		expect(list.alerts[0].triggered).toBe(true);
		expect(list.alerts[0].current_bps).toBe(4);
		expect((await call(db, "DELETE", `/alerts?owner=${OWNER}&symbol=SPYx`)).status).toBe(200);
		const after: any = await (await call(db, "GET", `/alerts?owner=${OWNER}`)).json();
		expect(after.alerts.length).toBe(0);
	});
	it("validates input", async () => {
		const { db } = fakeDb();
		expect((await call(db, "POST", "/alerts", { owner: "x", symbol: "SPYx", threshold_bps: 5 })).status).toBe(400);
		expect((await call(db, "POST", "/alerts", { owner: OWNER, symbol: "SPYx", threshold_bps: 500 })).status).toBe(400);
		expect((await call(db, "POST", "/alerts", { owner: OWNER, symbol: "SPYx", threshold_bps: -1 })).status).toBe(400);
		expect((await call(db, "POST", "/alerts", { owner: OWNER, symbol: "NOPE", threshold_bps: 5 })).status).toBe(404);
		expect((await call(db, "GET", "/alerts?owner=bad")).status).toBe(400);
	});
	it("caps alerts per wallet but still allows replacing one", async () => {
		const { db, alerts } = fakeDb();
		for (let i = 0; i < MAX_ALERTS_PER_OWNER; i++) alerts.set("k" + i, { owner: OWNER, symbol: "T" + i });
		expect((await call(db, "POST", "/alerts", { owner: OWNER, symbol: "SPYx", threshold_bps: 5 })).status).toBe(429);
		alerts.set("kx", { owner: OWNER, symbol: "SPYx" });
		alerts.delete("k0");
		expect((await call(db, "POST", "/alerts", { owner: OWNER, symbol: "SPYx", threshold_bps: 7 })).status).toBe(200);
	});
	it("answers a CORS preflight without throwing", async () => {
		const { db } = fakeDb();
		const r = await call(db, "OPTIONS", "/alerts");
		expect(r.status).toBe(204);
	});
	it("only accepts a numeric threshold", async () => {
		const { db } = fakeDb();
		for (const bad of [null, "", [], true, "5"]) {
			expect((await call(db, "POST", "/alerts", { owner: OWNER, symbol: "SPYx", threshold_bps: bad })).status).toBe(400);
		}
	});
	it("returns 500 instead of throwing when the database fails", async () => {
		const broken: any = { prepare: () => { throw new Error("no such table: alerts"); } };
		expect((await call(broken, "GET", `/alerts?owner=${OWNER}`)).status).toBe(500);
	});
});
