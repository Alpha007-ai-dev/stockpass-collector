import { describe, it, expect } from "vitest";
import {
	ANOMALY_MARGIN_BPS,
	CAUSE_NOTE,
	buildPrompt,
	classify,
	generateExplanation,
	validateExplanation,
	type Evidence,
} from "../src/anomaly";

const evidence: Evidence = {
	symbol: "SPYx",
	current_entry_bps: 31,
	typical_low_bps: 10,
	typical_high_bps: 12,
	observations: 19,
	market_state: "pre",
	availability_pct: 100,
	next_earnings: "2026-11-17",
};

const claudeSays = (text: string) =>
	(async () => new Response(JSON.stringify({ content: [{ type: "text", text }] }))) as unknown as typeof fetch;

describe("classify", () => {
	it("flags values outside the range by more than the margin", () => {
		expect(classify(31, 10, 12)).toBe("above");
		expect(classify(2, 10, 12)).toBe("below");
	});
	it("does not flag values inside the range or within the margin", () => {
		expect(classify(11, 10, 12)).toBeNull();
		expect(classify(12 + ANOMALY_MARGIN_BPS, 10, 12)).toBeNull();
		expect(classify(10 - ANOMALY_MARGIN_BPS, 10, 12)).toBeNull();
	});
	it("never reports 'below' when the range already starts near zero", () => {
		expect(classify(0, 1, 5)).toBeNull();
	});
});

describe("buildPrompt", () => {
	it("hands Claude the evidence plus the gap the Worker computed", () => {
		const p = buildPrompt(evidence, "above");
		const sent = JSON.parse(p.user);
		expect(sent.gap_bps).toBe(19);
		expect(sent.direction).toBe("above");
		expect(sent.current_entry_bps).toBe(31);
		expect(sent.market_state_label).toBe("pre-market");
	});
	it("computes the gap from the low end when the value is below the range", () => {
		const sent = JSON.parse(buildPrompt({ ...evidence, current_entry_bps: 2 }, "below").user);
		expect(sent.gap_bps).toBe(8);
	});
	it("tells Claude not to mention causes", () => {
		expect(buildPrompt(evidence, "above").system).toContain("Do not mention causes at all");
	});
});

describe("validateExplanation", () => {
	const json = buildPrompt(evidence, "above").json;

	it("accepts a description that only uses the evidence", () => {
		const text = "The current entry cost of 31 bps is 19 bps above the observed range of 10 to 12 bps. The range comes from 19 observations during pre-market.";
		expect(validateExplanation(text, json)).toBe(text);
	});
	it("accepts the earnings date as a plain fact", () => {
		expect(validateExplanation("The next earnings date is 2026-11-17.", json)).not.toBeNull();
	});
	it("rejects causal or predictive wording", () => {
		expect(validateExplanation("The cost is 31 bps because of earnings.", json)).toBeNull();
		expect(validateExplanation("This is due to thin liquidity.", json)).toBeNull();
		expect(validateExplanation("It is probably temporary.", json)).toBeNull();
		expect(validateExplanation("The cost will normalize.", json)).toBeNull();
	});
	it("rejects numbers that are not in the evidence", () => {
		expect(validateExplanation("The cost is about 40 bps.", json)).toBeNull();
	});
	it("strips markdown emphasis instead of rejecting the text", () => {
		expect(validateExplanation("The cost is **31 bps**.", json)).toBe("The cost is 31 bps.");
	});
	it("rejects empty and over-long output", () => {
		expect(validateExplanation("   ", json)).toBeNull();
		expect(validateExplanation("a ".repeat(400), json)).toBeNull();
	});
});

describe("generateExplanation", () => {
	it("returns Claude's note followed by the fixed 'cause unknown' sentence", async () => {
		const out = await generateExplanation("key", evidence, "above", claudeSays("The current entry cost of 31 bps is above the observed range of 10 to 12 bps."));
		expect(out).toContain("31 bps is above the observed range");
		expect(out!.endsWith(CAUSE_NOTE)).toBe(true);
	});
	it("sends the key and the evidence, and nothing else, to the Messages API", async () => {
		let seen: { url: string; init: RequestInit } | null = null;
		const spy = (async (url: string, init: RequestInit) => {
			seen = { url, init };
			return new Response(JSON.stringify({ content: [{ type: "text", text: "The cost is 31 bps." }] }));
		}) as unknown as typeof fetch;
		await generateExplanation("secret-key", evidence, "above", spy);
		expect(seen!.url).toBe("https://api.anthropic.com/v1/messages");
		const headers = seen!.init.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe("secret-key");
		expect(headers["anthropic-version"]).toBe("2023-06-01");
		const body = JSON.parse(String(seen!.init.body));
		expect(body.messages.length).toBe(1);
		expect(Object.keys(JSON.parse(body.messages[0].content)).sort()).toEqual(
			["availability_pct", "current_entry_bps", "direction", "gap_bps", "market_state", "market_state_label", "next_earnings", "observations", "symbol", "typical_high_bps", "typical_low_bps", "window_days"],
		);
	});
	it("returns null without calling Claude when no key is configured", async () => {
		let called = false;
		const spy = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
		expect(await generateExplanation(undefined, evidence, "above", spy)).toBeNull();
		expect(called).toBe(false);
	});
	it("returns null when the API fails or the network throws", async () => {
		const http500 = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
		const broken = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
		expect(await generateExplanation("k", evidence, "above", http500)).toBeNull();
		expect(await generateExplanation("k", evidence, "above", broken)).toBeNull();
	});
	it("returns null when Claude names a cause or invents a number", async () => {
		expect(await generateExplanation("k", evidence, "above", claudeSays("The cost rose because earnings are near."))).toBeNull();
		expect(await generateExplanation("k", evidence, "above", claudeSays("The cost is 31 bps, up from 7 bps yesterday."))).toBeNull();
	});
});
