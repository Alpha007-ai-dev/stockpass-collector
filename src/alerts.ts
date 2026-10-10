// Cost alerts: "tell me when SPYx entry cost is at or below N bps".
//
//   GET    /alerts?owner=<wallet>                       -> [{ symbol, threshold_bps, current_bps, triggered, ... }]
//   POST   /alerts  { owner, symbol, threshold_bps }    -> create or replace (max 10 per wallet)
//   DELETE /alerts?owner=<wallet>&symbol=SPYx           -> remove
//
// Alerts are keyed by the wallet's public address and are not authenticated: they hold only a token
// and a threshold, nothing sensitive. The state is evaluated on read against the latest measurement;
// there is no push, the app asks when it is opened.

export interface AlertsEnv {
  DB: D1Database
}

export const MAX_ALERTS_PER_OWNER = 10
const NO_MARKET_BPS = 200
export const MAX_AGE_S = 5400 // a measurement older than 90 minutes is not a current reading
export const MIN_THRESHOLD_BPS = 0
export const MAX_THRESHOLD_BPS = 200

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const SYMBOL = /^[A-Za-z0-9]{1,16}$/

export const LATEST_SQL = `SELECT ts, entry_bps, quotable FROM measurements
  WHERE ticker = ? AND symbol = ? ORDER BY ts DESC LIMIT 1`

export interface AlertStatus {
  symbol: string
  ticker: string
  threshold_bps: number
  current_bps: number | null
  measured_at: number | null
  triggered: boolean
}

/** Pure evaluation: a stale or unquotable measurement never triggers. Negative costs count as 0. */
export function evaluate(
  threshold: number,
  latest: { ts: number; entry_bps: number | null; quotable: number } | null | undefined,
  nowTs: number,
): { current_bps: number | null; measured_at: number | null; triggered: boolean } {
  if (!latest || Number(latest.quotable) !== 1 || latest.entry_bps == null) return { current_bps: null, measured_at: latest ? Number(latest.ts) : null, triggered: false }
  const raw = Number(latest.entry_bps)
  // 200+ bps means there was no real market at that moment: not a price to alert on, not a number to show.
  if (raw >= NO_MARKET_BPS) return { current_bps: null, measured_at: Number(latest.ts), triggered: false }
  const current = Math.max(0, raw)
  const fresh = nowTs - Number(latest.ts) <= MAX_AGE_S
  return { current_bps: current, measured_at: Number(latest.ts), triggered: fresh && current <= threshold }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE", "Access-Control-Allow-Headers": "Content-Type" },
  })
}

export async function handleAlerts(req: Request, env: AlertsEnv): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE", "Access-Control-Allow-Headers": "Content-Type" },
    })
  }
  try {
    return await route(req, env)
  } catch (e: any) {
    console.warn(`alerts: ${String(e?.message ?? e)}`)
    return json({ error: "internal" }, 500)
  }
}

async function route(req: Request, env: AlertsEnv): Promise<Response> {
  const url = new URL(req.url)

  if (req.method === "GET") {
    const owner = url.searchParams.get("owner") ?? ""
    if (!BASE58.test(owner)) return json({ error: "owner required" }, 400)
    const { results } = await env.DB.prepare("SELECT symbol, ticker, threshold_bps FROM alerts WHERE owner = ? ORDER BY created_at DESC LIMIT ?")
      .bind(owner, MAX_ALERTS_PER_OWNER)
      .all<{ symbol: string; ticker: string; threshold_bps: number }>()
    const nowTs = Math.floor(Date.now() / 1000)
    const out: AlertStatus[] = []
    for (const a of results ?? []) {
      const latest: any = await env.DB.prepare(LATEST_SQL).bind(a.ticker, a.symbol).first()
      out.push({ symbol: a.symbol, ticker: a.ticker, threshold_bps: Number(a.threshold_bps), ...evaluate(Number(a.threshold_bps), latest, nowTs) })
    }
    return json({ alerts: out })
  }

  if (req.method === "POST") {
    let body: any
    try { body = await req.json() } catch { return json({ error: "bad json" }, 400) }
    const owner = String(body?.owner ?? "")
    const symbol = String(body?.symbol ?? "")
    const threshold = typeof body?.threshold_bps === "number" ? body.threshold_bps : NaN
    if (!BASE58.test(owner)) return json({ error: "owner required" }, 400)
    if (!SYMBOL.test(symbol)) return json({ error: "symbol required" }, 400)
    if (!Number.isFinite(threshold) || threshold < MIN_THRESHOLD_BPS || threshold > MAX_THRESHOLD_BPS) return json({ error: "threshold_bps out of range" }, 400)
    const token: any = await env.DB.prepare("SELECT ticker FROM tokens WHERE symbol = ?").bind(symbol).first()
    if (!token) return json({ error: "unknown symbol" }, 404)
    // One atomic statement: insert or replace, but only while the wallet is under the cap (replacing an existing alert is always allowed).
    const r: any = await env.DB.prepare(
      `INSERT INTO alerts (owner, symbol, ticker, threshold_bps, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE (SELECT COUNT(*) FROM alerts WHERE owner = ?1) < ?6
          OR EXISTS (SELECT 1 FROM alerts WHERE owner = ?1 AND symbol = ?2)
       ON CONFLICT(owner, symbol) DO UPDATE SET threshold_bps=excluded.threshold_bps, created_at=excluded.created_at`,
    ).bind(owner, symbol, token.ticker, threshold, Math.floor(Date.now() / 1000), MAX_ALERTS_PER_OWNER).run()
    if (Number(r?.meta?.changes ?? 0) === 0) return json({ error: "too many alerts" }, 429)
    return json({ ok: true })
  }

  if (req.method === "DELETE") {
    const owner = url.searchParams.get("owner") ?? ""
    const symbol = url.searchParams.get("symbol") ?? ""
    if (!BASE58.test(owner) || !SYMBOL.test(symbol)) return json({ error: "owner and symbol required" }, 400)
    await env.DB.prepare("DELETE FROM alerts WHERE owner = ? AND symbol = ?").bind(owner, symbol).run()
    return json({ ok: true })
  }

  return json({ error: "method not allowed" }, 405)
}
