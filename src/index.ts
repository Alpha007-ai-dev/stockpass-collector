export interface Env { DB: D1Database; RPC_URL?: string }

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const ULTRA = "https://lite-api.jup.ag/ultra/v1/order"
const SEARCH = "https://lite-api.jup.ag/tokens/v2/search?query="
const RPC = "https://solana-rpc.publicnode.com"
const SIZE_USD = 1000
const SLICE = 8

const TICKERS = [
  "SPY","QQQ","GLD","NVDA","TSLA","AAPL","MSFT","META","GOOGL","AMZN","NFLX","AMD","AVGO","ORCL",
  "CRM","ADBE","INTC","QCOM","CSCO","TSM","COIN","MSTR","CRCL","HOOD","PLTR","GME","SPCX","STRC",
  "IONQ","OKLO","SMCI","RKLB","SOFI","HIMS","UBER","PYPL","MCD","JNJ","KO","PEP","WMT","XOM","CVX",
  "JPM","GS","V","DIS","PFE","ABBV","MRK","LLY","CAT","NKE","SBUX","VZ",
]

type Token = { ticker: string; symbol: string; issuer: string; mint: string; decimals: number }

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

async function resolve(env: Env, tickers: string[]): Promise<Token[]> {
  const marks = tickers.map(() => "?").join(",")
  const cached = await env.DB.prepare(`SELECT ticker,symbol,issuer,mint,decimals FROM tokens WHERE ticker IN (${marks})`).bind(...tickers).all()
  const have = new Map((cached.results as any[]).map((r) => [r.symbol, r as Token]))
  const out: Token[] = []

  for (const t of tickers) {
    const x = have.get(`${t}x`)
    const o = have.get(`${t}on`)
    if (x && o) { out.push(x, o); continue }
    try {
      const json: any = await fetch(SEARCH + t).then((r) => r.json())
      const verified = (json ?? []).filter((z: any) => z.isVerified)
      for (const suffix of ["x", "on"]) {
        const z = verified.find((q: any) => q.symbol === t + suffix)
        if (!z) continue
        const row: Token = { ticker: t, symbol: t + suffix, issuer: suffix === "x" ? "xStocks" : "Ondo", mint: z.id, decimals: z.decimals }
        await env.DB.prepare("INSERT OR REPLACE INTO tokens (symbol,ticker,issuer,mint,decimals,updated_at) VALUES (?,?,?,?,?,?)")
          .bind(row.symbol, row.ticker, row.issuer, row.mint, row.decimals, Math.floor(Date.now() / 1000)).run()
        out.push(row)
      }
    } catch {}
  }
  return out
}

async function mintInfo(tokens: Token[], rpc: string): Promise<Record<string, { multiplier: number; supply: number }>> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [tokens.map((t) => t.mint), { encoding: "jsonParsed" }] }),
  })
  const json: any = await res.json()
  const now = Date.now() / 1000
  const out: Record<string, { multiplier: number; supply: number }> = {}
  tokens.forEach((t, i) => {
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
  const json: any = await fetch(`${ULTRA}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}`).then((r) => r.json())
  if (!json?.outAmount) throw new Error(json?.error ?? "no quote")
  return String(json.outAmount)
}

async function collect(env: Env) {
  const slices = Math.ceil(TICKERS.length / SLICE)
  const index = Math.floor(Date.now() / 300000) % slices
  const tickers = TICKERS.slice(index * SLICE, index * SLICE + SLICE)

  const tokens = await resolve(env, tickers)
  if (tokens.length === 0) return 0

  const ts = Math.floor(Date.now() / 1000)
  const state = marketState(new Date())
  const info = await mintInfo(tokens, env.RPC_URL ?? RPC)
  const rows: any[] = []

  for (const t of tokens) {
    const m = info[t.mint]?.multiplier ?? 1
    const supply = info[t.mint]?.supply ?? 0
    try {
      const raw = await orderOut(USDC, t.mint, String(SIZE_USD * 1e6))
      await sleep(400)
      const shares = (Number(raw) / 10 ** t.decimals) * m
      const back = await orderOut(t.mint, USDC, raw)
      await sleep(400)
      const buy = SIZE_USD / shares
      const sell = Number(back) / 1e6 / shares
      const mid = (buy + sell) / 2
      rows.push([ts, t.ticker, t.symbol, t.issuer, SIZE_USD, state, 1, buy, sell,
        Math.round((buy / mid - 1) * 10000), Math.round((1 - sell / mid) * 10000), m, supply])
    } catch {
      rows.push([ts, t.ticker, t.symbol, t.issuer, SIZE_USD, state, 0, null, null, null, null, m, supply])
    }
  }

  const stmt = env.DB.prepare(
    "INSERT INTO measurements (ts,ticker,symbol,issuer,size_usd,market_state,quotable,buy_px,sell_px,entry_bps,exit_bps,multiplier,supply) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
  await env.DB.batch(rows.map((r) => stmt.bind(...r)))
  return rows.length
}

export default {
  async scheduled(_e: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(collect(env))
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === "/run") {
      return Response.json({ inserted: await collect(env) })
    }

    if (url.pathname === "/holdings") {
      const owner = url.searchParams.get("owner")
      if (!owner) return Response.json({ error: "owner required" }, { status: 400 })
      if (!env.RPC_URL) return Response.json({ error: "RPC not configured" }, { status: 500 })

      const { results: tokenRows } = await env.DB.prepare("SELECT ticker, symbol, issuer, mint, decimals FROM tokens").all()
      const byMint = new Map((tokenRows as any[]).map((t) => [t.mint, t]))
      const out: any[] = []

      for (const programId of ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]) {
        const res = await fetch(env.RPC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
            params: [owner, { programId }, { encoding: "jsonParsed" }],
          }),
        })
        const json: any = await res.json()
        if (json.error) return Response.json({ error: json.error.message }, { status: 502 })
        for (const acc of json.result?.value ?? []) {
          const info = acc.account?.data?.parsed?.info
          const token = byMint.get(info?.mint)
          if (!token) continue
          const raw = Number(info?.tokenAmount?.amount ?? 0)
          if (raw === 0) continue
          out.push({ ...token, walletAmount: raw / 10 ** token.decimals })
        }
      }

      return Response.json(out, { headers: { "Access-Control-Allow-Origin": "*" } })
    }

    if (url.pathname === "/series") {
      const t = url.searchParams.get("ticker")
      const hours = Math.min(Number(url.searchParams.get("hours") ?? 24), 24 * 14)
      if (!t) return Response.json({ error: "ticker required" }, { status: 400 })
      const since = Math.floor(Date.now() / 1000) - hours * 3600
      const { results } = await env.DB.prepare(
        `SELECT ts, symbol, issuer, entry_bps, quotable, market_state
         FROM measurements WHERE ticker = ? AND ts > ? ORDER BY ts`,
      ).bind(t, since).all()
      return Response.json(results, { headers: { "Cache-Control": "max-age=120", "Access-Control-Allow-Origin": "*" } })
    }

    if (url.pathname === "/tokens") {
      const { results } = await env.DB.prepare(
        "SELECT ticker, symbol, issuer, mint, decimals FROM tokens ORDER BY ticker, issuer",
      ).all()
      return Response.json(results, { headers: { "Cache-Control": "max-age=3600", "Access-Control-Allow-Origin": "*" } })
    }

    if (url.pathname === "/stats") {
      const { results: history } = await env.DB.prepare(
        `SELECT symbol, issuer, ticker, market_state, COUNT(*) AS samples,
                AVG(entry_bps) AS avg_entry, MIN(entry_bps) AS min_entry, MAX(entry_bps) AS max_entry,
                AVG(quotable) AS availability
         FROM measurements WHERE ts > ?
         GROUP BY symbol, market_state ORDER BY ticker, symbol`,
      ).bind(Math.floor(Date.now() / 1000) - 30 * 86400).all()

      const { results: latest } = await env.DB.prepare(
        `SELECT m.symbol, m.ticker, m.issuer, m.buy_px, m.sell_px, m.entry_bps, m.exit_bps, m.quotable, m.multiplier, m.supply, m.ts, m.market_state
         FROM measurements m
         JOIN (SELECT symbol, MAX(ts) AS ts FROM measurements GROUP BY symbol) last
           ON last.symbol = m.symbol AND last.ts = m.ts`,
      ).all()

      return Response.json({ latest, history }, { headers: { "Cache-Control": "max-age=60", "Access-Control-Allow-Origin": "*" } })
    }

    const { results } = await env.DB.prepare(
      "SELECT symbol, issuer, market_state, entry_bps, exit_bps, quotable, ts FROM measurements ORDER BY ts DESC LIMIT 20",
    ).all()
    return Response.json(results)
  },
}




