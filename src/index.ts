import { handleExplainAnomaly } from "./anomaly"
import { handleSwapOrder, handleSwapExecute } from "./swap-proxy"
import { handleAlerts } from "./alerts"
import { isLimited, type Limiter } from "./limit"

export interface Env { DB: D1Database; RPC_URL?: string; ALPACA_KEY?: string; ALPACA_SECRET?: string; FINNHUB_KEY?: string; ADMIN_KEY?: string; ANTHROPIC_API_KEY?: string; JUPITER_API_KEY?: string; RATE_LIMITER?: Limiter }

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const SKR = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3"
const ULTRA = "https://lite-api.jup.ag/ultra/v1/order"
const SEARCH = "https://lite-api.jup.ag/tokens/v2/search?query="
const RPC = "https://solana-rpc.publicnode.com"
const SIZE_USD = 1000
const SLICE = 6


const TICKERS = [
  "SPY","QQQ","GLD","NVDA","TSLA","AAPL","MSFT","META","GOOGL","AMZN","NFLX","AMD","AVGO","ORCL",
  "CRM","ADBE","INTC","QCOM","CSCO","TSM","COIN","MSTR","CRCL","HOOD","PLTR","GME","SPCX","STRC",
  "IONQ","OKLO","SMCI","RKLB","SOFI","HIMS","UBER","PYPL","MCD","JNJ","KO","PEP","WMT","XOM","CVX",
  "JPM","GS","V","DIS","PFE","ABBV","MRK","LLY","CAT","NKE","SBUX","VZ",
]

type Token = { ticker: string; symbol: string; issuer: string; mint: string; decimals: number; icon?: string; name?: string }

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
  const cached = await env.DB.prepare(`SELECT ticker,symbol,issuer,mint,decimals,icon,name,updated_at FROM tokens WHERE ticker IN (${marks})`).bind(...tickers).all()
  const have = new Map((cached.results as any[]).map((r) => [r.symbol, r as Token]))
  const lastSeen = new Map((cached.results as any[]).map((r) => [r.ticker as string, Number(r.updated_at)]))
  const out: Token[] = []

  for (const t of tickers) {
    const cached = [have.get(`${t}x`), have.get(`${t}on`), have.get(`${t}bp`)].filter(Boolean) as Token[]
    if (cached.length >= 2 && Date.now() / 1000 - (lastSeen.get(t) ?? 0) < 7 * 86400) { out.push(...cached); continue }
    try {
      const json: any = await fetch(SEARCH + t).then((r) => r.json())
      const verified = (json ?? []).filter((z: any) => z.isVerified)

      const candidates: { symbol: string; issuer: string; z: any }[] = []
      const xs = verified.find((q: any) => q.symbol === t + "x")
      if (xs) candidates.push({ symbol: t + "x", issuer: "xStocks", z: xs })
      const od = verified.find((q: any) => q.symbol === t + "on")
      if (od) candidates.push({ symbol: t + "on", issuer: "Ondo", z: od })
      const bp = verified.find((q: any) => q.symbol.toUpperCase() === t && /Backpack Securities/i.test(q.name ?? ""))
      if (bp) candidates.push({ symbol: t + "bp", issuer: "Backpack", z: bp })

      for (const cand of candidates) {
        const row: Token = { ticker: t, symbol: cand.symbol, issuer: cand.issuer, mint: cand.z.id, decimals: cand.z.decimals, icon: cand.z.icon ?? cand.z.logoURI ?? undefined, name: cand.z.name ?? undefined }
        await env.DB.prepare("INSERT OR REPLACE INTO tokens (symbol,ticker,issuer,mint,decimals,icon,name,updated_at) VALUES (?,?,?,?,?,?,?,?)")
          .bind(row.symbol, row.ticker, row.issuer, row.mint, row.decimals, row.icon ?? null, row.name ?? null, Math.floor(Date.now() / 1000)).run()
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

async function collectReference(env: Env) {
  if (!env.ALPACA_KEY || !env.ALPACA_SECRET) return 0
  const REFERENCE_TICKERS = TICKERS
  const ts = Math.floor(Date.now() / 1000)
  const state = marketState(new Date())
  try {
    const url = `https://data.alpaca.markets/v2/stocks/quotes/latest?symbols=${REFERENCE_TICKERS.join(",")}&feed=iex`
    const res = await fetch(url, {
      headers: { "APCA-API-KEY-ID": env.ALPACA_KEY, "APCA-API-SECRET-KEY": env.ALPACA_SECRET },
    })
    const json: any = await res.json()
    const rows: any[] = []
    for (const ticker of REFERENCE_TICKERS) {
      const q = json?.quotes?.[ticker]
      if (!q) continue
      const bid = Number(q.bp ?? 0)
      const ask = Number(q.ap ?? 0)
      if (!bid || !ask) continue
      const quoteTs = q.t ? Math.floor(new Date(q.t).getTime() / 1000) : ts
      const mid = (bid + ask) / 2
      const spreadBps = ((ask - bid) / mid) * 10000
      const stale = ts - quoteTs > 900 || spreadBps > 50 ? 1 : 0
      rows.push([ts, ticker, bid, ask, mid, null, state, stale])
    }
    if (rows.length === 0) return 0
    const stmt = env.DB.prepare(
      "INSERT INTO reference_prices (ts,ticker,bid,ask,mid,last_px,market_state,stale) VALUES (?,?,?,?,?,?,?,?)",
    )
    await env.DB.batch(rows.map((r) => stmt.bind(...r)))
    return rows.length
  } catch (e) {
    return 0
  }
}

async function collect(env: Env) {
  await collectReference(env)
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
  // One token per run also gets measured at other sizes, so we can show how
  // execution cost scales. Kept in a separate table so the main series stays clean.
  const SIZES = [100, 10000]
  const pick = tokens[Math.floor(Math.random() * tokens.length)]
  const sizeRows: any[] = []
  if (pick) {
    const pm = info[pick.mint]?.multiplier ?? 1
    for (const size of SIZES) {
      try {
        const raw = await orderOut(USDC, pick.mint, String(size * 1e6))
        await sleep(400)
        const shares = (Number(raw) / 10 ** pick.decimals) * pm
        const back = await orderOut(pick.mint, USDC, raw)
        await sleep(400)
        const buy = size / shares
        const sell = Number(back) / 1e6 / shares
        const mid = (buy + sell) / 2
        sizeRows.push([ts, pick.ticker, pick.symbol, pick.issuer, size, state, 1,
          Math.round((buy / mid - 1) * 10000), Math.round((1 - sell / mid) * 10000)])
      } catch {
        sizeRows.push([ts, pick.ticker, pick.symbol, pick.issuer, size, state, 0, null, null])
      }
    }
  }


  const stmt = env.DB.prepare(
    "INSERT INTO measurements (ts,ticker,symbol,issuer,size_usd,market_state,quotable,buy_px,sell_px,entry_bps,exit_bps,multiplier,supply) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
  await env.DB.batch(rows.map((r) => stmt.bind(...r)))

  if (sizeRows.length) {
    const sizeStmt = env.DB.prepare(
      "INSERT INTO size_tests (ts,ticker,symbol,issuer,size_usd,market_state,quotable,entry_bps,exit_bps) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    await env.DB.batch(sizeRows.map((r) => sizeStmt.bind(...r)))
  }
  return rows.length
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (event.cron === "0 3 * * *") {
      ctx.waitUntil(syncEarnings(env))
      ctx.waitUntil(buildReliabilityCache(env))
      return
    }
    ctx.waitUntil(collect(env))
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === "/resolve") {
      const from = Number(url.searchParams.get("from") ?? 0)
      const slice = TICKERS.slice(from, from + 12)
      const found = await resolve(env, slice)
      return Response.json({ from, checked: slice.length, tokens: found.length, next: from + 12 })
    }

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
      let usdc = 0
      let skr = 0

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
          const raw = Number(info?.tokenAmount?.amount ?? 0)
          if (raw === 0) continue
          if (info?.mint === USDC) { usdc = raw / 1e6; continue }
          if (info?.mint === SKR) { skr = raw / 1e6; continue }
          const token = byMint.get(info?.mint)
          if (!token) continue
          out.push({ ...token, walletAmount: raw / 10 ** token.decimals })
        }
      }

      return Response.json({ holdings: out, usdc, skr }, { headers: { "Access-Control-Allow-Origin": "*" } })
    }

    if (url.pathname === "/underlying") {
      const ticker = url.searchParams.get("ticker")
      const headers = { "Cache-Control": "max-age=600", "Access-Control-Allow-Origin": "*" }
      if (ticker) {
        const profile = await env.DB.prepare("SELECT * FROM underlying WHERE ticker = ?").bind(ticker).first()
        const { results: evs } = await env.DB.prepare(
          "SELECT kind, event_date, detail, amount FROM events WHERE ticker = ? ORDER BY event_date DESC LIMIT 12"
        ).bind(ticker).all()
        return Response.json({ profile: profile ?? null, events: evs ?? [] }, { headers })
      }
      const { results: all } = await env.DB.prepare("SELECT * FROM underlying").all()
      const { results: upcoming } = await env.DB.prepare(
        "SELECT ticker, kind, event_date, detail, amount FROM events WHERE event_date >= date('now') ORDER BY event_date"
      ).all()
      return Response.json({ profiles: all ?? [], upcoming: upcoming ?? [] }, { headers })
    }

    if (url.pathname === "/underlying-sync") {
      if (!env.FINNHUB_KEY) return Response.json({ error: "FINNHUB_KEY not configured" }, { status: 500 })
      const from = Number(url.searchParams.get("from") ?? "0")
      const take = Number(url.searchParams.get("take") ?? "6")

      const { results: tickers } = await env.DB.prepare("SELECT DISTINCT ticker FROM tokens ORDER BY ticker").all()
      const slice = (tickers as any[]).slice(from, from + take).map((r) => r.ticker as string)
      const now = Math.floor(Date.now() / 1000)
      const key = env.FINNHUB_KEY
      const today = new Date().toISOString().slice(0, 10)
      const plus90 = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10)
      const minus400 = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10)
      const out: any[] = []

      const get = async (path: string) => {
        const r = await fetch(`https://finnhub.io/api/v1${path}&token=${key}`)
        if (!r.ok) return null
        return r.json().catch(() => null)
      }

      for (const t of slice) {
        const note: any = { ticker: t }
        try {
          const p: any = await get(`/stock/profile2?symbol=${t}`)
          if (p && p.name) {
            await env.DB.prepare(
              `INSERT INTO underlying (ticker, name, industry, exchange, country, market_cap, employees, ipo, weburl, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(ticker) DO UPDATE SET name=excluded.name, industry=excluded.industry,
                 exchange=excluded.exchange, country=excluded.country, market_cap=excluded.market_cap,
                 employees=excluded.employees, ipo=excluded.ipo, weburl=excluded.weburl, updated_at=excluded.updated_at`
            ).bind(t, p.name ?? null, p.finnhubIndustry ?? null, p.exchange ?? null, p.country ?? null,
                   p.marketCapitalization ?? null, p.employeeTotal ?? null, p.ipo ?? null, p.weburl ?? null, now).run()
            note.profile = true
          }

          const d: any = await get(`/stock/dividend?symbol=${t}&from=${minus400}&to=${plus90}`)
          for (const row of (Array.isArray(d) ? d : []).slice(-4)) {
            if (!row.date) continue
            await env.DB.prepare(
              `INSERT INTO events (id, ticker, kind, event_date, detail, amount, updated_at)
               VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                 event_date=excluded.event_date, detail=excluded.detail, amount=excluded.amount, updated_at=excluded.updated_at`
            ).bind(`${t}-div-${row.date}`, t, "dividend", row.date,
                   row.payDate ? `pay ${row.payDate}` : null, row.amount ?? null, now).run()
            note.dividends = (note.dividends ?? 0) + 1
          }

          const e: any = await get(`/calendar/earnings?symbol=${t}&from=${today}&to=${plus90}`)
          for (const row of (e?.earningsCalendar ?? []).slice(0, 2)) {
            if (!row.date) continue
            await env.DB.prepare(
              `INSERT INTO events (id, ticker, kind, event_date, detail, amount, updated_at)
               VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                 event_date=excluded.event_date, detail=excluded.detail, updated_at=excluded.updated_at`
            ).bind(`${t}-earn-${row.date}`, t, "earnings", row.date,
                   row.hour === "bmo" ? "before market open" : row.hour === "amc" ? "after market close" : null,
                   null, now).run()
            note.earnings = (note.earnings ?? 0) + 1
          }

          const s: any = await get(`/stock/split?symbol=${t}&from=2015-01-01&to=${today}`)
          for (const row of (Array.isArray(s) ? s : []).slice(-2)) {
            if (!row.date) continue
            await env.DB.prepare(
              `INSERT INTO events (id, ticker, kind, event_date, detail, amount, updated_at)
               VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET detail=excluded.detail, updated_at=excluded.updated_at`
            ).bind(`${t}-split-${row.date}`, t, "split", row.date,
                   row.fromFactor && row.toFactor ? `${row.toFactor}:${row.fromFactor} split` : null, null, now).run()
            note.splits = (note.splits ?? 0) + 1
          }
        } catch (err: any) {
          note.error = String(err?.message ?? err)
        }
        out.push(note)
      }

      const next = from + take
      return Response.json(
        { done: slice.length, next: next < (tickers as any[]).length ? next : null, detail: out },
        { headers: { "Access-Control-Allow-Origin": "*" } }
      )
    }

    if (url.pathname === "/prices") {
      const symbols = (url.searchParams.get("symbols") ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 25)
      if (!symbols.length) return Response.json({ error: "symbols required" }, { status: 400 })

      const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours") ?? "24")))
      const cutoff = Math.floor(Date.now() / 1000) - hours * 3600
      const marks = symbols.map(() => "?").join(",")

      // one row per symbol: the measurement closest to the cutoff, looking back
      const { results } = await env.DB.prepare(
        `SELECT m.symbol, m.buy_px, m.ts
         FROM measurements m
         JOIN (
           SELECT symbol, MAX(ts) AS ts
           FROM measurements
           WHERE symbol IN (${marks}) AND ts <= ? AND quotable = 1 AND buy_px IS NOT NULL
           GROUP BY symbol
         ) AS pick ON pick.symbol = m.symbol AND pick.ts = m.ts`
      ).bind(...symbols, cutoff).all()

      const then: Record<string, { px: number; ts: number }> = {}
      for (const r of (results as any[]) ?? []) {
        then[r.symbol] = { px: Number(r.buy_px), ts: Number(r.ts) }
      }
      return Response.json(
        { hours, then },
        { headers: { "Cache-Control": "max-age=300", "Access-Control-Allow-Origin": "*" } }
      )
    }

    if (url.pathname === "/rebuild-cache") {
      if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) {
        return Response.json({ error: "unauthorized" }, { status: 401 })
      }
      await buildReliabilityCache(env)
      const { results } = await env.DB.prepare("SELECT * FROM reliability_cache").all()
      return Response.json({ ok: true, issuers: results ?? [] }, { headers: { "Access-Control-Allow-Origin": "*" } })
    }

    if (url.pathname === "/reliability") {
      const symbol = url.searchParams.get("symbol")
      const headers = { "Cache-Control": "max-age=900", "Access-Control-Allow-Origin": "*" }

      if (symbol) {
        const row = await env.DB.prepare(
          `SELECT COUNT(*) AS samples,
                  ROUND(AVG(CASE WHEN quotable=1 THEN 1.0 ELSE 0.0 END)*100, 0) AS availability,
                  MIN(CASE WHEN quotable=1 AND entry_bps < 200 THEN entry_bps END) AS min_entry,
                  MAX(CASE WHEN quotable=1 AND entry_bps < 200 THEN entry_bps END) AS max_entry,
                  ROUND(AVG(CASE WHEN quotable=1 AND entry_bps < 200 THEN entry_bps END), 1) AS avg_entry,
                  MIN(CASE WHEN quotable=1 AND exit_bps < 200 THEN exit_bps END) AS min_exit,
                  MAX(CASE WHEN quotable=1 AND exit_bps < 200 THEN exit_bps END) AS max_exit,
                  ROUND(AVG(CASE WHEN quotable=1 AND exit_bps < 200 THEN exit_bps END), 1) AS avg_exit,
                  MIN(ts) AS since
           FROM measurements WHERE symbol = ? AND market_state = 'open'`
        ).bind(symbol).first()

        const all = await env.DB.prepare(
          `SELECT COUNT(*) AS samples,
                  ROUND(AVG(CASE WHEN quotable=1 THEN 1.0 ELSE 0.0 END)*100, 0) AS availability,
                  MIN(CASE WHEN quotable=1 AND entry_bps < 200 THEN entry_bps END) AS min_entry,
                  MAX(CASE WHEN quotable=1 AND entry_bps < 200 THEN entry_bps END) AS max_entry,
                  MIN(CASE WHEN quotable=1 AND exit_bps < 200 THEN exit_bps END) AS min_exit,
                  MAX(CASE WHEN quotable=1 AND exit_bps < 200 THEN exit_bps END) AS max_exit
           FROM measurements WHERE symbol = ?`
        ).bind(symbol).first()

        return Response.json({ symbol, open: row ?? null, overall: all ?? null }, { headers })
      }

      if (url.searchParams.get("all")) {
        const { results: all } = await env.DB.prepare(
          "SELECT symbol, ticker, issuer, samples, quotable_count, availability, avg_entry FROM token_reliability ORDER BY ticker, issuer"
        ).all()
        return Response.json({ tokens: all ?? [] }, { headers })
      }

      const { results: cached } = await env.DB.prepare(
        "SELECT * FROM reliability_cache ORDER BY availability DESC"
      ).all()

      const { results: weak } = await env.DB.prepare(
        "SELECT * FROM weakest_cache ORDER BY availability LIMIT 8"
      ).all()

      const list = (cached as any[]) ?? []
      const meta = list.length
        ? {
            total: list.reduce((n, r) => n + Number(r.samples ?? 0), 0),
            tokens: list.reduce((n, r) => n + Number(r.tokens ?? 0), 0),
            updated_at: list[0]?.updated_at ?? null,
          }
        : null

      return Response.json(
        { issuers: list, weakest: (weak as any[]) ?? [], meta },
        { headers }
      )
    }

    if (url.pathname === "/collateral") {
      // Same pattern as /stats: one row in response_cache, so most calls cost a single D1 read
      // and never touch the Kamino API.
      const TTL = 600
      const nowTs = Math.floor(Date.now() / 1000)
      const hit: any = await env.DB.prepare("SELECT body, updated_at FROM response_cache WHERE key = ?").bind("collateral").first()
      const respond = (body: string, state: string, maxAge: number) =>
        new Response(body, {
          headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${maxAge}`, "Access-Control-Allow-Origin": "*", "X-Cache": state },
        })
      if (hit && nowTs - Number(hit.updated_at) < TTL) return respond(String(hit.body), "hit", 300)

      const MARKETS = [
        { name: "Kamino xStocks Market", pubkey: "5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua" },
        { name: "Kamino Sentora xStocks", pubkey: "8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr" },
      ]
      const out: any[] = []
      let complete = true
      for (const m of MARKETS) {
        try {
          const res = await fetch(`https://api.kamino.finance/kamino-market/${m.pubkey}/reserves/metrics`)
          if (!res.ok) throw new Error(`kamino ${res.status}`)
          const rows: any = await res.json()
          for (const r of rows ?? []) {
            const ltv = Number(r.maxLtv)
            if (!ltv) continue
            out.push({
              symbol: r.liquidityToken,
              mint: r.liquidityTokenMint,
              market: m.name,
              maxLtv: ltv,
              borrowApy: Number(r.borrowApy),
              supplyApy: Number(r.supplyApy),
              marketUsd: Math.round(Number(r.totalSupplyUsd ?? 0)),
            })
          }
        } catch {
          complete = false
        }
      }

      const body = JSON.stringify(out)
      // Only a complete answer (both markets) is cached. A half list would hide one market for the
      // whole TTL, and the two-market comparison is the point of this endpoint.
      if (complete && out.length) {
        await env.DB.prepare(
          "INSERT INTO response_cache (key, body, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at"
        ).bind("collateral", body, nowTs).run()
        return respond(body, "miss", 300)
      }
      // Kamino failed (or answered for one market only): prefer the last complete copy, however old.
      if (hit) return respond(String(hit.body), "stale", 60)
      return respond(body, "miss-uncached", 0)
    }

    if (url.pathname === "/alerts" || url.pathname.startsWith("/swap/")) {
      if (req.method !== "OPTIONS" && (await isLimited(env.RATE_LIMITER, req, url.pathname.startsWith("/swap/") ? "swap" : "alerts"))) {
        return new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } })
      }
    }
    if (url.pathname === "/alerts") return handleAlerts(req, env)
    if (url.pathname === "/swap/order" && req.method === "GET") return handleSwapOrder(url, env)
    if (url.pathname === "/swap/execute" && req.method === "POST") return handleSwapExecute(req, env)
    if (url.pathname.startsWith("/swap/")) {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type" } })
      }
      return new Response(JSON.stringify({ error: "not found or method not allowed" }), { status: 405, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } })
    }
    if (url.pathname === "/explain-anomaly") {
      return handleExplainAnomaly(url, env)
    }

    if (url.pathname === "/series") {
      const t = url.searchParams.get("ticker")
      const hours = Math.min(Number(url.searchParams.get("hours") ?? 24), 24 * 14)
      if (!t) return Response.json({ error: "ticker required" }, { status: 400 })

      const key = `series:${t}:${hours}`
      const nowS = Math.floor(Date.now() / 1000)
      const cached = await env.DB.prepare("SELECT body, updated_at FROM response_cache WHERE key = ?").bind(key).first()
      if (cached && nowS - Number((cached as any).updated_at) < 300) {
        return new Response(String((cached as any).body), {
          headers: { "Content-Type": "application/json", "Cache-Control": "max-age=120", "Access-Control-Allow-Origin": "*", "X-Cache": "hit" },
        })
      }

      const since = nowS - hours * 3600
      const { results } = await env.DB.prepare(
        `SELECT ts, symbol, issuer, entry_bps, exit_bps, buy_px, quotable, market_state
         FROM measurements WHERE ticker = ? AND ts > ? ORDER BY ts`,
      ).bind(t, since).all()

      const body = JSON.stringify(results)
      await env.DB.prepare(
        "INSERT INTO response_cache (key, body, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at"
      ).bind(key, body, nowS).run()

      return new Response(body, {
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=120", "Access-Control-Allow-Origin": "*", "X-Cache": "miss" },
      })
    }

    if (url.pathname === "/logo") {
      const symbol = url.searchParams.get("symbol")
      if (!symbol) return new Response("symbol required", { status: 400 })
      const row: any = await env.DB.prepare("SELECT icon FROM tokens WHERE symbol = ?").bind(symbol).first()
      if (!row?.icon) return new Response("not found", { status: 404 })
      const upstream = await fetch(row.icon, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "image/*,*/*" },
        redirect: "follow",
      })
      if (!upstream.ok) return new Response("upstream error", { status: 502 })
      return new Response(upstream.body, {
        headers: {
          "Content-Type": upstream.headers.get("Content-Type") ?? "image/png",
          "Cache-Control": "public, max-age=86400",
          "Access-Control-Allow-Origin": "*",
        },
      })
    }

    if (url.pathname === "/tokens") {
      const { results } = await env.DB.prepare(
        "SELECT ticker, symbol, issuer, mint, decimals, icon, name FROM tokens ORDER BY ticker, issuer",
      ).all()
      return Response.json(results, { headers: { "Cache-Control": "max-age=3600", "Access-Control-Allow-Origin": "*" } })
    }

    if (url.pathname === "/stats") {
      const TTL = 300
      const nowTs = Math.floor(Date.now() / 1000)
      const hit = await env.DB.prepare("SELECT body, updated_at FROM response_cache WHERE key = ?").bind("stats").first()
      if (hit && nowTs - Number((hit as any).updated_at) < TTL) {
        return new Response(String((hit as any).body), {
          headers: { "Content-Type": "application/json", "Cache-Control": "max-age=120", "Access-Control-Allow-Origin": "*", "X-Cache": "hit" },
        })
      }

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

      const { results: reference } = await env.DB.prepare(
        `SELECT r.ticker, r.bid, r.ask, r.mid, r.market_state, r.stale, r.ts
         FROM reference_prices r
         JOIN (SELECT ticker AS t, MAX(ts) AS mts FROM reference_prices GROUP BY ticker) last
           ON last.t = r.ticker AND last.mts = r.ts`,
      ).all()

      const body = JSON.stringify({ latest, history, reference })
      await env.DB.prepare(
        "INSERT INTO response_cache (key, body, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at"
      ).bind("stats", body, nowTs).run()

      return new Response(body, {
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=120", "Access-Control-Allow-Origin": "*", "X-Cache": "miss" },
      })
    }

    const { results } = await env.DB.prepare(
      "SELECT symbol, issuer, market_state, entry_bps, exit_bps, quotable, ts FROM measurements ORDER BY ts DESC LIMIT 20",
    ).all()
    return Response.json(results)
  },
}






















/** Daily: refresh upcoming earnings dates from Finnhub.
 *  One request per ticker, well inside the subrequest budget.
 *  Dividends and splits are not available on the free tier. */
async function syncEarnings(env: Env): Promise<void> {
  if (!env.FINNHUB_KEY) return
  const { results } = await env.DB.prepare("SELECT DISTINCT ticker FROM tokens ORDER BY ticker").all()
  const tickers = (results as any[]).map((r) => r.ticker as string)
  const now = Math.floor(Date.now() / 1000)
  const today = new Date().toISOString().slice(0, 10)
  const plus120 = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10)

  await env.DB.prepare("DELETE FROM events WHERE kind = 'earnings' AND event_date < date('now')").run()

  for (const t of tickers) {
    try {
      const r = await fetch(
        `https://finnhub.io/api/v1/calendar/earnings?symbol=${t}&from=${today}&to=${plus120}&token=${env.FINNHUB_KEY}`
      )
      if (!r.ok) continue
      const j: any = await r.json()
      for (const row of (j?.earningsCalendar ?? []).slice(0, 2)) {
        if (!row.date) continue
        await env.DB.prepare(
          `INSERT INTO events (id, ticker, kind, event_date, detail, amount, updated_at)
           VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
             event_date=excluded.event_date, detail=excluded.detail, updated_at=excluded.updated_at`
        ).bind(`${t}-earn-${row.date}`, t, "earnings", row.date,
               row.hour === "bmo" ? "before market open" : row.hour === "amc" ? "after market close" : null,
               null, now).run()
      }
    } catch {}
  }
}

/** Daily: recompute issuer-level reliability into a small cache table.
 *  The live query scans every measurement row, which is far too expensive
 *  to run on each request. */
async function buildReliabilityCache(env: Env): Promise<void> {
  const { results: issuers } = await env.DB.prepare(
    `SELECT issuer,
            COUNT(*) AS samples,
            COUNT(DISTINCT symbol) AS tokens,
            ROUND(AVG(CASE WHEN quotable=1 THEN 1.0 ELSE 0.0 END)*100, 1) AS availability,
            ROUND(AVG(CASE WHEN quotable=1 AND entry_bps BETWEEN 0 AND 200 THEN entry_bps END), 1) AS avg_entry
     FROM measurements GROUP BY issuer`
  ).all()

  const { results: perToken } = await env.DB.prepare(
    `SELECT issuer, ticker, symbol, COUNT(*) AS samples, SUM(quotable) AS q,
            ROUND(AVG(CASE WHEN quotable=1 THEN 1.0 ELSE 0.0 END)*100, 0) AS availability,
            ROUND(AVG(CASE WHEN quotable=1 AND entry_bps BETWEEN 0 AND 200 THEN entry_bps END), 1) AS avg_entry
     FROM measurements GROUP BY issuer, symbol`
  ).all()

  const now = Math.floor(Date.now() / 1000)
  const rows = (perToken as any[]) ?? []

  const reliable = new Map<string, number>()
  const never = new Map<string, number>()
  for (const r of rows) {
    if (r.availability >= 80) reliable.set(r.issuer, (reliable.get(r.issuer) ?? 0) + 1)
    if (Number(r.q) === 0) never.set(r.issuer, (never.get(r.issuer) ?? 0) + 1)
  }

  const stmt = env.DB.prepare(
    `INSERT INTO reliability_cache (issuer, samples, tokens, availability, avg_entry, reliable_tokens, never_quotable, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(issuer) DO UPDATE SET samples=excluded.samples, tokens=excluded.tokens,
       availability=excluded.availability, avg_entry=excluded.avg_entry,
       reliable_tokens=excluded.reliable_tokens, never_quotable=excluded.never_quotable,
       updated_at=excluded.updated_at`
  )
  await env.DB.batch(
    (issuers as any[]).map((r) =>
      stmt.bind(r.issuer, r.samples, r.tokens, r.availability, r.avg_entry,
                reliable.get(r.issuer) ?? 0, never.get(r.issuer) ?? 0, now)
    )
  )

  const weakest = rows
    .filter((r) => r.samples >= 20)
    .sort((a, b) => a.availability - b.availability)
    .slice(0, 8)

  await env.DB.prepare("DELETE FROM weakest_cache").run()
  if (weakest.length) {
    const w = env.DB.prepare(
      "INSERT INTO weakest_cache (symbol, issuer, samples, quotable_count, availability, updated_at) VALUES (?,?,?,?,?,?)"
    )
    await env.DB.batch(weakest.map((r) => w.bind(r.symbol, r.issuer, r.samples, r.q, r.availability, now)))
  }

  const tStmt = env.DB.prepare(
    `INSERT INTO token_reliability (symbol, ticker, issuer, samples, quotable_count, availability, avg_entry, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(symbol) DO UPDATE SET ticker=excluded.ticker, issuer=excluded.issuer,
       samples=excluded.samples, quotable_count=excluded.quotable_count,
       availability=excluded.availability, avg_entry=excluded.avg_entry, updated_at=excluded.updated_at`
  )
  for (let i = 0; i < rows.length; i += 40) {
    const chunk = rows.slice(i, i + 40)
    await env.DB.batch(
      chunk.map((r) => tStmt.bind(r.symbol, r.ticker ?? null, r.issuer, r.samples, r.q, r.availability, r.avg_entry ?? null, now))
    )
  }
}
