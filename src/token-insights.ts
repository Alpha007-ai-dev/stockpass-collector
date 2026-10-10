// Two read-only endpoints for the token Passport:
//
//   GET /size-curve?symbol=TSLAon[&state=open]  -> how the measured cost changes with trade size ($100, $1,000, $10,000)
//   GET /multiplier-changes                      -> tokens whose share multiplier changed recently or is scheduled to change
//
// Both only read data we already collect or the mint's public scaled-amount configuration; nothing is estimated.

export interface InsightsEnv {
  DB: D1Database
  RPC_URL?: string
}

const SYMBOL = /^[A-Za-z0-9]{1,16}$/
const STATES = new Set(["open", "pre", "after", "closed", "weekend"])
export const CURVE_WINDOW_S = 14 * 86400
export const MIN_POINT_SAMPLES = 3
export const RECENT_WINDOW_S = 14 * 86400
const CACHE_TTL_S = 600
const DEFAULT_RPC = "https://solana-rpc.publicnode.com"

const HEADERS = { "Content-Type": "application/json", "Cache-Control": "max-age=300", "Access-Control-Allow-Origin": "*" }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS })

export type CurvePoint = { size_usd: number; entry_bps: number; exit_bps: number | null; samples: number }

/** Keep only sizes with enough observations; a curve needs at least two of them. */
export function buildCurve(rows: { size_usd: number; n: number; entry: number | null; exit: number | null }[]): CurvePoint[] {
  const points = rows
    .filter((r) => Number(r.n) >= MIN_POINT_SAMPLES && r.entry !== null && r.entry !== undefined)
    .map((r) => ({
      size_usd: Number(r.size_usd),
      entry_bps: Math.round(Math.max(0, Number(r.entry)) * 10) / 10,
      exit_bps: r.exit === null || r.exit === undefined ? null : Math.round(Math.max(0, Number(r.exit)) * 10) / 10,
      samples: Number(r.n),
    }))
    .sort((a, b) => a.size_usd - b.size_usd)
  return points.length >= 2 ? points : []
}

const CURVE_SQL = `SELECT size_usd, COUNT(entry_bps) AS n, AVG(entry_bps) AS entry, AVG(exit_bps) AS exit FROM (
    SELECT size_usd, entry_bps, exit_bps FROM measurements WHERE symbol = ?1 AND market_state = ?2 AND quotable = 1 AND entry_bps < 200 AND ts > ?3
    UNION ALL
    SELECT size_usd, entry_bps, exit_bps FROM size_tests WHERE symbol = ?1 AND market_state = ?2 AND quotable = 1 AND entry_bps < 200 AND ts > ?3
  ) GROUP BY size_usd ORDER BY size_usd`

export async function handleSizeCurve(url: URL, env: InsightsEnv): Promise<Response> {
  const symbol = url.searchParams.get("symbol") ?? ""
  const state = url.searchParams.get("state") ?? "open"
  if (!SYMBOL.test(symbol)) return json({ error: "symbol required" }, 400)
  if (!STATES.has(state)) return json({ error: "unknown state" }, 400)
  const nowS = Math.floor(Date.now() / 1000)
  const { results } = await env.DB.prepare(CURVE_SQL).bind(symbol, state, nowS - CURVE_WINDOW_S).all()
  return json({ symbol, market_state: state, window_days: CURVE_WINDOW_S / 86400, points: buildCurve(results as any[]) })
}

export type MultiplierChange = {
  symbol: string
  from: number
  to: number
  effective_ts: number
  status: "upcoming" | "recent"
}

/** state = the mint's scaledUiAmountConfig. Returns null when there is nothing to report. */
export function classifyChange(symbol: string, state: any, nowS: number): MultiplierChange | null {
  if (!state) return null
  const from = Number(state.multiplier)
  const to = Number(state.newMultiplier)
  const at = Number(state.newMultiplierEffectiveTimestamp)
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(at) || at <= 0 || from <= 0 || to <= 0) return null
  if (Math.abs(to / from - 1) < 1e-9) return null
  if (at > nowS) return { symbol, from, to, effective_ts: at, status: "upcoming" }
  if (nowS - at <= RECENT_WINDOW_S) return { symbol, from, to, effective_ts: at, status: "recent" }
  return null
}

export async function handleMultiplierChanges(env: InsightsEnv): Promise<Response> {
  const nowS = Math.floor(Date.now() / 1000)
  const key = "multiplier-changes"
  const hit: any = await env.DB.prepare("SELECT body, updated_at FROM response_cache WHERE key = ?").bind(key).first()
  if (hit && nowS - Number(hit.updated_at) < CACHE_TTL_S) {
    return new Response(String(hit.body), { headers: { ...HEADERS, "X-Cache": "hit" } })
  }

  const { results: tokens } = await env.DB.prepare("SELECT symbol, mint FROM tokens").all()
  const list = (tokens as any[]).filter((t) => t.mint)
  if (!list.length) return json({ changes: [], checked_at: nowS })

  let value: any[]
  try {
    const res = await fetch(env.RPC_URL ?? DEFAULT_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [list.map((t) => t.mint), { encoding: "jsonParsed" }] }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return json({ error: "rpc unavailable" }, 502)
    const body: any = await res.json()
    if (body?.error || !Array.isArray(body?.result?.value)) return json({ error: "rpc unavailable" }, 502)
    value = body.result.value
  } catch {
    return json({ error: "rpc unavailable" }, 502)
  }

  const changes: MultiplierChange[] = []
  list.forEach((t, i) => {
    const ext = (value[i]?.data?.parsed?.info?.extensions ?? []).find((e: any) => e.extension === "scaledUiAmountConfig")
    const c = classifyChange(String(t.symbol), ext?.state, nowS)
    if (c) changes.push(c)
  })

  const out = JSON.stringify({ changes, checked_at: nowS })
  await env.DB.prepare(
    "INSERT INTO response_cache (key, body, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at",
  ).bind(key, out, nowS).run()
  return new Response(out, { headers: { ...HEADERS, "X-Cache": "miss" } })
}
