// GET /explain-anomaly?symbol=SPYx
//
// The Worker computes the evidence from measurements. Claude only phrases it: it never sees D1,
// is never asked for a cause, and is only called when the current value is outside the observed
// range. Everything Claude writes is validated before it is shown (see validateExplanation).

export interface AnomalyEnv {
  DB: D1Database
  ANTHROPIC_API_KEY?: string
}

export const MODEL = "claude-haiku-4-5-20251001"
export const WINDOW_DAYS = 14 // history used for the "typical" range
export const MIN_OBSERVATIONS = 10 // fewer observations in the same market state: no verdict
export const ANOMALY_MARGIN_BPS = 3 // outside the range by more than this; same tolerance as the Home insight rule
export const CACHE_TTL_S = 900 // 15 minutes
export const MAX_AGE_S = 3 * 3600 // a measurement older than this is not "current"
export const CAUSE_NOTE = "StockPass does not have enough historical data to determine the cause of this change."

export type Direction = "above" | "below"

export interface Evidence {
  symbol: string
  current_entry_bps: number
  typical_low_bps: number
  typical_high_bps: number
  observations: number
  market_state: string
  availability_pct: number
  next_earnings: string | null
}

// Both queries filter on `ticker` first so they use idx_ts (ticker, ts) instead of scanning the table.
export const LATEST_SQL = `SELECT ts, entry_bps, quotable, market_state FROM measurements
  WHERE ticker = ? AND symbol = ? ORDER BY ts DESC LIMIT 1`

// The range is built from earlier measurements of the same token in the same market state
// (strictly before the latest one, so the current value cannot define its own range).
// Same conventions as the rest of the Worker: quotable only, outliers >= 200 bps left out,
// negative round trips counted as 0.
export const RANGE_SQL = `SELECT COUNT(*) AS total,
    SUM(quotable) AS quoted,
    SUM(CASE WHEN quotable = 1 AND entry_bps < 200 THEN 1 ELSE 0 END) AS obs,
    MIN(CASE WHEN quotable = 1 AND entry_bps < 200 THEN (CASE WHEN entry_bps < 0 THEN 0 ELSE entry_bps END) END) AS lo,
    MAX(CASE WHEN quotable = 1 AND entry_bps < 200 THEN (CASE WHEN entry_bps < 0 THEN 0 ELSE entry_bps END) END) AS hi
  FROM measurements
  WHERE ticker = ? AND symbol = ? AND market_state = ? AND ts >= ? AND ts < ?`

export const EARNINGS_SQL = `SELECT MIN(event_date) AS d FROM events
  WHERE ticker = ? AND kind = 'earnings' AND event_date >= date('now')`

export function classify(current: number, low: number, high: number): Direction | null {
  if (current > high + ANOMALY_MARGIN_BPS) return "above"
  if (current < low - ANOMALY_MARGIN_BPS) return "below"
  return null
}

const STATE_LABEL: Record<string, string> = {
  open: "regular market hours",
  pre: "pre-market",
  after: "after-hours",
  closed: "market closed",
  weekend: "weekend",
}

const SYSTEM = `You write a short factual note for a mobile app that measures what it costs to trade tokenized stocks.
You receive measured evidence as JSON. Describe only what the evidence shows:
- whether the current entry cost is above or below the observed range, and by how many basis points (gap_bps),
- the observed range and how many observations it comes from,
- the market state.
Rules:
- Do not state, suggest or hint at any cause or reason. Do not mention causes at all.
- Do not predict anything and do not give advice.
- If next_earnings is present you may state the date as a fact, without linking it to the cost.
- Use only numbers that appear in the JSON.
- Write 2 or 3 short plain sentences. No markdown, no lists, no headings.`

export function buildPrompt(e: Evidence, direction: Direction) {
  const gap = direction === "above" ? e.current_entry_bps - e.typical_high_bps : e.typical_low_bps - e.current_entry_bps
  const payload = {
    ...e,
    direction,
    gap_bps: gap,
    market_state_label: STATE_LABEL[e.market_state] ?? e.market_state,
    window_days: WINDOW_DAYS,
  }
  const json = JSON.stringify(payload)
  return { system: SYSTEM, user: json, json }
}

// Words that turn a description into a cause, a guess or a forecast.
const CAUSAL =
  /\b(because|due to|owing to|cause[sd]?|causing|as a result|result of|resulting|driven by|attributed|likely|unlikely|probably|presumably|perhaps|possibly|may be|might be|could be|suggest(?:s|ed|ing)?|expected|forecast|predict(?:s|ed|ing)?|will)\b/i

const NUMBER = /\d+(?:\.\d+)?/g

/** Returns the cleaned text, or null if it is not safe to show.
 *  Rejects causal or predictive wording and any number that is not in the evidence we sent. */
export function validateExplanation(text: string, payloadJson: string): string | null {
  const t = text.replace(/[*`#]/g, "").replace(/\s+/g, " ").trim()
  if (!t || t.length > 600) return null
  if (CAUSAL.test(t)) return null
  const allowed = new Set(payloadJson.match(NUMBER) ?? [])
  for (const n of t.match(NUMBER) ?? []) if (!allowed.has(n)) return null
  return t
}

/** The explanation text, or null when Claude is unavailable or its answer failed validation. */
export async function generateExplanation(
  apiKey: string | undefined,
  evidence: Evidence,
  direction: Direction,
  doFetch: typeof fetch = fetch,
): Promise<string | null> {
  if (!apiKey) return null
  const { system, user, json } = buildPrompt(evidence, direction)
  try {
    const res = await doFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 250, system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      console.warn(`explain-anomaly: anthropic status ${res.status}`)
      return null
    }
    const data: any = await res.json()
    const text = (data?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => String(b.text)).join(" ")
    const checked = validateExplanation(text, json)
    if (!checked) {
      console.warn("explain-anomaly: explanation rejected by validation")
      return null
    }
    return `${checked} ${CAUSE_NOTE}`
  } catch (e: any) {
    console.warn(`explain-anomaly: ${String(e?.message ?? e)}`)
    return null
  }
}

export async function handleExplainAnomaly(url: URL, env: AnomalyEnv, doFetch: typeof fetch = fetch): Promise<Response> {
  const respond = (body: unknown, status: number, xcache: string, cacheControl: string) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": cacheControl, "Access-Control-Allow-Origin": "*", "X-Cache": xcache },
    })

  const symbol = (url.searchParams.get("symbol") ?? "").trim()
  if (!/^[A-Za-z0-9]{1,16}$/.test(symbol)) return respond({ error: "symbol required" }, 400, "none", "no-store")

  const key = `explain:${symbol}`
  const nowTs = Math.floor(Date.now() / 1000)
  const hit: any = await env.DB.prepare("SELECT body, updated_at FROM response_cache WHERE key = ?").bind(key).first()
  if (hit && nowTs - Number(hit.updated_at) < CACHE_TTL_S) return respond(String(hit.body), 200, "hit", "max-age=120")

  // Only known tokens: keeps arbitrary input out of the cache table and bounds the number of Claude calls.
  const token: any = await env.DB.prepare("SELECT ticker FROM tokens WHERE symbol = ?").bind(symbol).first()
  if (!token) return respond({ error: "unknown symbol" }, 404, "none", "no-store")

  const store = (body: string) =>
    env.DB.prepare(
      "INSERT INTO response_cache (key, body, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at",
    ).bind(key, body, nowTs).run()
  // No anomaly: Claude is not called. The verdict is cached like any other result.
  const none = async (reason: string) => {
    const body = JSON.stringify({ anomaly: false, symbol, reason })
    await store(body)
    return respond(body, 200, "miss", "max-age=120")
  }

  const latest: any = await env.DB.prepare(LATEST_SQL).bind(token.ticker, symbol).first()
  if (!latest) return none("no_data")
  if (nowTs - Number(latest.ts) > MAX_AGE_S) return none("stale_measurement")
  if (Number(latest.quotable) !== 1 || latest.entry_bps == null) return none("no_quote")

  const r: any = await env.DB.prepare(RANGE_SQL)
    .bind(token.ticker, symbol, latest.market_state, nowTs - WINDOW_DAYS * 86400, latest.ts)
    .first()
  const observations = Number(r?.obs ?? 0)
  if (observations < MIN_OBSERVATIONS) return none("not_enough_data")

  const current = Math.max(0, Number(latest.entry_bps))
  const low = Number(r.lo)
  const high = Number(r.hi)
  const direction = classify(current, low, high)
  if (!direction) return none("within_range")

  const ev: any = await env.DB.prepare(EARNINGS_SQL).bind(token.ticker).first()
  const total = Number(r.total ?? 0)
  const evidence: Evidence = {
    symbol,
    current_entry_bps: current,
    typical_low_bps: low,
    typical_high_bps: high,
    observations,
    market_state: String(latest.market_state),
    availability_pct: total ? Math.round((100 * Number(r.quoted ?? 0)) / total) : 0,
    next_earnings: ev?.d ?? null,
  }

  const explanation = await generateExplanation(env.ANTHROPIC_API_KEY, evidence, direction, doFetch)
  const body = JSON.stringify({
    anomaly: true,
    symbol,
    direction,
    evidence,
    explanation,
    explanation_status: explanation ? "ok" : "unavailable",
  })
  // Failures are never cached: a missing key or a rejected answer can be fixed and retried at once.
  if (explanation) {
    await store(body)
    return respond(body, 200, "miss", "max-age=120")
  }
  return respond(body, 200, "miss", "no-store")
}
