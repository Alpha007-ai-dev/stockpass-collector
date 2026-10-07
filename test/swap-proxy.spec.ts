import { describe, it, expect } from "vitest";
import { handleSwapOrder, handleSwapExecute } from "../src/swap-proxy";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const STOCK = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";
const OTHER = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const TAKER = "7oUXJtg1zdvqRFSAaKHsbisaWBDjEywBzQiueqpCLgkY";

const db = (stocks: string[]) =>
	({ prepare: () => ({ bind: (m: string) => ({ first: async () => (stocks.includes(m) ? { ok: 1 } : null) }) }) }) as unknown as D1Database;

const calls: { url: string; init?: RequestInit }[] = [];
const upstream = ((url: string, init?: RequestInit) => {
	calls.push({ url, init });
	return Promise.resolve(new Response(JSON.stringify({ outAmount: "123", router: "jupiterz" }), { status: 200 }));
}) as unknown as typeof fetch;

const order = (qs: string, env: any) => handleSwapOrder(new URL("https://w/swap/order?" + qs), env, upstream);
const env = { DB: db([STOCK]), JUPITER_API_KEY: "k" };

describe("swap order", () => {
	it("is off without a key", async () => {
		expect((await order(`inputMint=${USDC}&outputMint=${STOCK}&amount=1`, { DB: db([STOCK]) })).status).toBe(503);
	});
	it("relays stock <-> base pairs with the key and no other params", async () => {
		calls.length = 0;
		const r = await order(`inputMint=${USDC}&outputMint=${STOCK}&amount=25000000&taker=${TAKER}&slippageBps=50&evil=1`, env);
		expect(r.status).toBe(200);
		expect(calls[0].url).toContain("/order?");
		expect(calls[0].url).not.toContain("evil");
		expect((calls[0].init!.headers as any)["x-api-key"]).toBe("k");
		const sell = await order(`inputMint=${STOCK}&outputMint=${USDC}&amount=5`, env);
		expect(sell.status).toBe(200);
	});
	it("refuses pairs that are not stock <-> base", async () => {
		expect((await order(`inputMint=${USDC}&outputMint=${OTHER}&amount=5`, env)).status).toBe(403);
		expect((await order(`inputMint=${STOCK}&outputMint=${OTHER}&amount=5`, env)).status).toBe(403);
	});
	it("validates input", async () => {
		expect((await order(`inputMint=x&outputMint=${STOCK}&amount=5`, env)).status).toBe(400);
		expect((await order(`inputMint=${USDC}&outputMint=${STOCK}&amount=-5`, env)).status).toBe(400);
		expect((await order(`inputMint=${USDC}&outputMint=${STOCK}&amount=5&slippageBps=9000`, env)).status).toBe(400);
	});
});

describe("swap execute", () => {
	const post = (body: unknown, e: any = env) =>
		handleSwapExecute(new Request("https://w/swap/execute", { method: "POST", body: JSON.stringify(body) }), e, upstream);
	it("relays a signed transaction", async () => {
		calls.length = 0;
		const r = await post({ signedTransaction: "AAEC+/==", requestId: "abc-12345678" });
		expect(r.status).toBe(200);
		expect(calls[0].url).toContain("/execute");
	});
	it("rejects malformed bodies", async () => {
		expect((await post({ signedTransaction: "not base64!", requestId: "abc-12345678" })).status).toBe(400);
		expect((await post({ signedTransaction: "AAEC", requestId: "" })).status).toBe(400);
		expect((await post({ signedTransaction: "A".repeat(5000), requestId: "abc-12345678" })).status).toBe(400);
		expect((await post({ signedTransaction: "AAEC", requestId: "abc-12345678" }, { DB: db([]) })).status).toBe(503);
	});
});
