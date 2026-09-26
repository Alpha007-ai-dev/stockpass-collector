export interface Env { DB: D1Database }

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const ULTRA = "https://lite-api.jup.ag/ultra/v1/order"
const RPC = "https://solana-rpc.publicnode.com"
const SIZE_USD = 1000

type Token = { ticker: string; symbol: string; issuer: string; mint: string; decimals: number }

const TOKENS: Token[] = [
  { ticker: "SPY",  symbol: "SPYx",   issuer: "xStocks", mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", decimals: 8 },
  { ticker: "SPY",  symbol: "SPYon",  issuer: "Ondo",    mint: "k18WJUULWheRkSpSquYGdNNmtuE2Vbw1hpuUi92ondo", decimals: 9 },
  { ticker: "QQQ",  symbol: "QQQx",   issuer: "xStocks", mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", decimals: 8 },
  { ticker: "QQQ",  symbol: "QQQon",  issuer: "Ondo",    mint: "HrYNm6jTQ71LoFphjVKBTdAE4uja7WsmLG8VxB8ondo", decimals: 9 },
  { ticker: "NVDA", symbol: "NVDAx",  issuer: "xStocks", mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", decimals: 8 },
  { ticker: "NVDA", symbol: "NVDAon", issuer: "Ondo",    mint: "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo", decimals: 9 },
  { ticker: "TSLA", symbol: "TSLAx",  issuer: "xStocks", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", decimals: 8 },
  { ticker: "TSLA", symbol: "TSLAon", issuer: "Ondo",    mint: "KeGv7bsfR4MheC1CkmnAVceoApjrkvBhHYjWb67ondo", decimals: 9 },
  { ticker: "AAPL", symbol: "AAPLx",  issuer: "xStocks", mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", decimals: 8 },
  { ticker: "AAPL", symbol: "AAPLon", issuer: "Ondo",    mint: "123mYEnRLM2LLYsJW3K6oyYh8uP1fngj732iG638ondo", decimals: 9 },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function nthSunday(y: number, m: number, n: number) {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay()
  return 1 + ((7 - first) % 7) + (n - 1) * 7
}

function marketState(now: Date): string {
  const y = now.getUTCFullYear()
  const dst = now.getTime() >= Date.UTC(y, 2, nthSunday(y, 2, 2), 7) && now.getTime() < Date.UTC(y, 10, nthSunday(y, 10, 1), 6)
  const ny = new Date(now.getTime() + (dst ? -4 : -5) * 3600000)
  const dow = ny.getUTCDay()
  const mins = ny.getUTCHours() * 60 + ny.getUTCMinutes()
  if (dow === 0 || dow === 6) return "weekend"
  if (mins >= 570 && mins < 960) return "open"
  if (mins >= 240 && mins < 570) return "pre"
  if (mins >= 960 && mins < 1200) return "after"
  return "closed"
}

async function mintInfo(): Promise<Record<string, { multiplier: number; supply: number }>> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [TOKENS.map((t) => t.mint), { encoding: "jsonParsed" }] }),
  })
  const json: any = await res.json()
  const now = Date.now() / 1000
  const out: Record<string, { multiplier: number; supply: number }> = {}
  TOKENS.forEach((t, i) => {
    const info = json?.result?.value?.[i]?.data?.parsed?.info
    const s = (info?.extensions ?? []).find((e: any) => e.extension === "scaledUiAmountConfig")?.state
    out[t.mint] = {
      multiplier: s ? Number(now >= s.newMultiplierEffectiveTimestamp ? s.newMultiplier : s.multiplier) : 1,
      supply: Number(info?.supply ?? 0) / 10 ** Number(info?.decimals ?? 0),
    }
  })
  return out
}

async function orderOut(inputMint: string, outputMint: string, amount: string): Promise<string> {
  const res = await fetch(`${ULTRA}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}`)
  const json: any = await res.json()
  if (!json?.outAmount) throw new Error(json?.error ?? "no quote")
  return String(json.outAmount)
}

async function collect(env: Env) {
  const ts = Math.floor(Date.now() / 1000)
  const state = marketState(new Date())
  const info = await mintInfo()
  const rows: any[] = []

  for (const t of TOKENS) {
    const m = info[t.mint]?.multiplier ?? 1
    try {
      const raw = await orderOut(USDC, t.mint, String(SIZE_USD * 1e6))
      await sleep(600)
      const shares = (Number(raw) / 10 ** t.decimals) * m
      const back = await orderOut(t.mint, USDC, raw)
      await sleep(600)
      const buy = SIZE_USD / shares
      const sell = Number(back) / 1e6 / shares
      const mid = (buy + sell) / 2
      rows.push([ts, t.ticker, t.symbol, t.issuer, SIZE_USD, state, 1, buy, sell,
        Math.round((buy / mid - 1) * 10000), Math.round((1 - sell / mid) * 10000), m, info[t.mint]?.supply ?? 0])
    } catch {
      rows.push([ts, t.ticker, t.symbol, t.issuer, SIZE_USD, state, 0, null, null, null, null, m, info[t.mint]?.supply ?? 0])
    }
  }

  const stmt = env.DB.prepare(
    "INSERT INTO measurements (ts,ticker,symbol,issuer,size_usd,market_state,quotable,buy_px,sell_px,entry_bps,exit_bps,multiplier,supply) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
  await env.DB.batch(rows.map((r) => stmt.bind(...r)))
  return rows.length
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(collect(env))
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === "/run") {
      const n = await collect(env)
      return Response.json({ inserted: n })
    }
    const { results } = await env.DB.prepare(
      "SELECT symbol, issuer, market_state, entry_bps, exit_bps, quotable, ts FROM measurements ORDER BY ts DESC LIMIT 20",
    ).all()
    return Response.json(results)
  },
}
