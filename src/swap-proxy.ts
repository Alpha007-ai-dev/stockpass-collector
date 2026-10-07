// Relay for Jupiter Swap V2 (https://api.jup.ag/swap/v2). The API key lives only in the Worker.
//
//   GET  /swap/order?inputMint=&outputMint=&amount=&taker=&slippageBps=   -> Jupiter GET /order
//   POST /swap/execute  { signedTransaction, requestId }                  -> Jupiter POST /execute
//
// Only swaps between a known tokenized stock (tokens table) and USDC/SOL/SKR are relayed, so the
// key cannot be used as a general-purpose Jupiter proxy. Nothing here is cached: quotes are live.

export interface SwapEnv {
  DB: D1Database
  JUPITER_API_KEY?: string
}

export const JUP_V2 = "https://api.jup.ag/swap/v2"
export const BASES = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "So11111111111111111111111111111111111111112", // SOL
  "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3", // SKR
])
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const B64 = /^[A-Za-z0-9+/=]+$/
const MAX_TX_CHARS = 4000 // a v0 transaction is at most 1232 bytes -> ~1644 base64 chars
const MAX_SLIPPAGE_BPS = 300

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  })
}

async function isStock(db: D1Database, mint: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS ok FROM tokens WHERE mint = ? LIMIT 1").bind(mint).first()
  return !!row
}

async function relay(res: Response): Promise<Response> {
  const text = await res.text()
  // Pass Jupiter's status and body through so the app can show the real reason.
  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  })
}

export async function handleSwapOrder(url: URL, env: SwapEnv, doFetch: typeof fetch = fetch): Promise<Response> {
  if (!env.JUPITER_API_KEY) return json({ error: "swap v2 not configured" }, 503)
  const p = url.searchParams
  const inputMint = p.get("inputMint") ?? ""
  const outputMint = p.get("outputMint") ?? ""
  const amount = p.get("amount") ?? ""
  const taker = p.get("taker")
  const slippage = p.get("slippageBps")
  if (!BASE58.test(inputMint) || !BASE58.test(outputMint)) return json({ error: "bad mint" }, 400)
  if (!/^[1-9][0-9]{0,18}$/.test(amount)) return json({ error: "bad amount" }, 400)
  if (taker && !BASE58.test(taker)) return json({ error: "bad taker" }, 400)
  if (slippage && !(/^\d{1,4}$/.test(slippage) && Number(slippage) <= MAX_SLIPPAGE_BPS)) return json({ error: "bad slippage" }, 400)
  if (inputMint === outputMint) return json({ error: "same mint" }, 400)

  const stockIn = !BASES.has(inputMint) && (await isStock(env.DB, inputMint))
  const stockOut = !BASES.has(outputMint) && (await isStock(env.DB, outputMint))
  const baseOther = stockIn ? BASES.has(outputMint) : stockOut ? BASES.has(inputMint) : false
  if (!baseOther) return json({ error: "pair not allowed" }, 403)

  const q = new URLSearchParams({ inputMint, outputMint, amount })
  if (taker) q.set("taker", taker)
  if (slippage) q.set("slippageBps", slippage)
  try {
    const res = await doFetch(`${JUP_V2}/order?${q}`, {
      headers: { "x-api-key": env.JUPITER_API_KEY },
      signal: AbortSignal.timeout(8000),
    })
    return relay(res)
  } catch (e: any) {
    console.warn(`swap-order: ${String(e?.message ?? e)}`)
    return json({ error: "upstream unavailable" }, 502)
  }
}

export async function handleSwapExecute(req: Request, env: SwapEnv, doFetch: typeof fetch = fetch): Promise<Response> {
  if (!env.JUPITER_API_KEY) return json({ error: "swap v2 not configured" }, 503)
  let body: any
  try {
    body = await req.json()
  } catch {
    return json({ error: "bad json" }, 400)
  }
  const signedTransaction = String(body?.signedTransaction ?? "")
  const requestId = String(body?.requestId ?? "")
  if (!signedTransaction || signedTransaction.length > MAX_TX_CHARS || !B64.test(signedTransaction)) return json({ error: "bad transaction" }, 400)
  if (!/^[A-Za-z0-9-]{8,80}$/.test(requestId)) return json({ error: "bad requestId" }, 400)
  try {
    const res = await doFetch(`${JUP_V2}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.JUPITER_API_KEY },
      body: JSON.stringify({ signedTransaction, requestId }),
      signal: AbortSignal.timeout(30000),
    })
    return relay(res)
  } catch (e: any) {
    console.warn(`swap-execute: ${String(e?.message ?? e)}`)
    return json({ error: "upstream unavailable" }, 502)
  }
}
