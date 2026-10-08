import { describe, it, expect } from "vitest";
import { buildCurve, classifyChange, handleSizeCurve, MIN_POINT_SAMPLES, RECENT_WINDOW_S } from "../src/token-insights";

const NOW = 1_800_000_000;

describe("buildCurve", () => {
	it("keeps sizes with enough samples, sorted, and clamps negative costs to 0", () => {
		const pts = buildCurve([
			{ size_usd: 10000, n: MIN_POINT_SAMPLES, entry: 30.24, exit: 28 },
			{ size_usd: 100, n: 10, entry: -2, exit: null },
			{ size_usd: 1000, n: 40, entry: 12, exit: 11 },
		]);
		expect(pts.map((p) => p.size_usd)).toEqual([100, 1000, 10000]);
		expect(pts[0].entry_bps).toBe(0);
		expect(pts[2].entry_bps).toBe(30.2);
	});
	it("drops thin points and returns nothing when fewer than two remain", () => {
		expect(buildCurve([{ size_usd: 1000, n: 40, entry: 12, exit: 11 }, { size_usd: 100, n: MIN_POINT_SAMPLES - 1, entry: 9, exit: 9 }])).toEqual([]);
	});
});

describe("classifyChange", () => {
	const st = (m: number, n: number, at: number) => ({ multiplier: m, newMultiplier: n, newMultiplierEffectiveTimestamp: at });
	it("reports an upcoming change", () => {
		expect(classifyChange("X", st(1, 2, NOW + 3600), NOW)?.status).toBe("upcoming");
	});
	it("reports a recent change and forgets old ones", () => {
		expect(classifyChange("X", st(1, 1.01, NOW - 3600), NOW)?.status).toBe("recent");
		expect(classifyChange("X", st(1, 1.01, NOW - RECENT_WINDOW_S - 1), NOW)).toBeNull();
	});
	it("ignores unchanged, missing or invalid configuration", () => {
		expect(classifyChange("X", st(1, 1, NOW + 10), NOW)).toBeNull();
		expect(classifyChange("X", undefined, NOW)).toBeNull();
		expect(classifyChange("X", st(0, 2, NOW + 10), NOW)).toBeNull();
		expect(classifyChange("X", st(1, 2, 0), NOW)).toBeNull();
	});
});

describe("handleSizeCurve", () => {
	const env: any = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) } };
	it("rejects a bad symbol or state", async () => {
		expect((await handleSizeCurve(new URL("https://x/size-curve?symbol=a;b"), env)).status).toBe(400);
		expect((await handleSizeCurve(new URL("https://x/size-curve?symbol=SPYx&state=bogus"), env)).status).toBe(400);
	});
	it("returns an empty curve when there is no data", async () => {
		const body: any = await (await handleSizeCurve(new URL("https://x/size-curve?symbol=SPYx"), env)).json();
		expect(body.points).toEqual([]);
	});
});
