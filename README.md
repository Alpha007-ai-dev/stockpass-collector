# StockPass Collector

The measurement backend behind [StockPass](https://github.com/Alpha007-ai-dev/stockpass).

A Cloudflare Worker that continuously measures what it actually costs to buy and sell tokenized equities on Solana, and stores the results in D1 so the app can show historical context instead of a single snapshot.

---

## Why it exists

Price feeds tell you what a token is worth. They do not tell you what it costs to trade it, whether it can be traded at all right now, or how many real shares a token represents.

None of that is available from an API. It has to be measured.

---

## What it measures

Every five minutes the Worker picks a rotating slice of stocks and, for each issuer of each stock:

1. Requests an executable quote for **$1,000 USDC → token** (Jupiter Ultra).
2. Immediately requests the reverse quote for the exact amount received.
3. Reads the **Token-2022 scaled-UI-amount multiplier** and total supply from the chain.
4. Normalizes both prices to a per-share basis using that multiplier.
5. Derives the round-trip execution cost and splits it into entry and exit.

It also records a **traditional reference quote** (bid/ask/mid) for the same tickers, flagging it as stale when the quote is old or the spread is implausibly wide — so the app never shows a premium against a dead reference.

### Stored per measurement

| Field | Meaning |
|---|---|
| `ts` | measurement timestamp |
| `ticker`, `symbol`, `issuer` | which stock, which token, which issuer |
| `size_usd` | test size (currently 1000) |
| `market_state` | open / pre / after / closed / weekend |
| `quotable` | whether an executable quote existed at all |
| `buy_px`, `sell_px` | normalized per-share prices |
| `entry_bps`, `exit_bps` | execution cost, in basis points |
| `multiplier` | on-chain token multiplier |
| `supply` | total token supply |

Around 3,500–5,000 rows per day across 110+ tokens.

---

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /stats` | latest measurement per token, 30-day history grouped by market state, and the latest traditional reference per ticker |
| `GET /series?ticker=SPY&hours=24` | time series of measurements for one stock |
| `GET /size-curve?symbol=TSLAon&state=open` | average measured cost at $100, $1,000 and $10,000 over the last 14 days, per market state; sizes with fewer than 3 observations are left out |
| `GET /multiplier-changes` | tokens whose share multiplier changed in the last 14 days or is scheduled to change (read from the mint's scaled-amount configuration, cached 10 min) |
| `GET /tokens` | the token registry: ticker, symbol, issuer, mint, decimals, icon, name |
| `GET /collateral` | Kamino lending terms (max LTV, borrow APY, supply APY, market size), cached for 10 minutes; if Kamino is down the last complete copy is served |
| `GET/POST/DELETE /alerts` | Cost alerts keyed by wallet address ("SPYx entry cost <= N bps", max 10 per wallet). `GET ?owner=` returns each alert with the current cost and whether it is triggered (fresh quote, at most 90 minutes old). Not authenticated, nothing sensitive stored; evaluated on read, no push |
| `GET /swap/order`, `POST /swap/execute` | Relay for Jupiter Swap V2 (`api.jup.ag/swap/v2`); the API key stays in the Worker. Only stock <-> USDC/SOL/SKR pairs are relayed, params are whitelisted, nothing is cached. Returns 503 until `JUPITER_API_KEY` is set |
| `GET /explain-anomaly?symbol=SPYx` | `{ anomaly: false, reason }` while the latest entry cost is inside the token's observed range (same market state, last 14 days, 3 bps tolerance). Otherwise the evidence (current cost, typical range, observations, market state, availability, next earnings) plus a short factual note written by Claude. Cached for 15 minutes; Claude is only called when there is an anomaly |
| `GET /holdings?owner=<address>` | tokenized-stock holdings and USDC balance for a wallet |
| `GET /logo?symbol=SPYx` | proxies the issuer's token logo (some issuers serve SVG that mobile cannot fetch directly) |
| `GET /prices?symbols=SPYx,SPYon&hours=24` | price history for the given symbols, used for portfolio sparklines |
| `GET /reliability?symbol=SPYx` | how often a token had an executable quote, by market state |
| `GET /underlying?ticker=SPY` | company profile and upcoming events for a stock |

Admin endpoints need `?key=<ADMIN_KEY>` and return 401 without it:

| Endpoint | Does |
|---|---|
| `GET /run` | triggers one measurement round manually |
| `GET /resolve?from=0` | re-resolves the token registry from Jupiter for a slice of tickers |
| `GET /underlying-sync?from=0` | refreshes company profiles and events from Finnhub |
| `GET /rebuild-cache` | rebuilds the reliability cache |

The public endpoints are CORS-open and require no client key.

---

## Issuer detection

Tokens are discovered from Jupiter's verified token list, not hardcoded:

- **xStocks** — symbol ends in `x` (e.g. `SPYx`)
- **Ondo** — symbol ends in `on` (e.g. `SPYon`)
- **Backpack Securities** — symbol is the ticker plus `bp` (e.g. `HOODbp`), identified by issuer metadata in the token name

Adding a fourth issuer means adding one detection rule. The app needs no changes.

---

## Setup

```bash
npm install
npx wrangler d1 create stockpass          # then put the id in wrangler.jsonc
npx wrangler d1 execute stockpass --remote --file=schema.sql
npx wrangler d1 execute stockpass --remote --file=reference.sql
npx wrangler d1 execute stockpass --remote --file=alerts.sql
```

### Secrets

```bash
npx wrangler secret put RPC_URL           # a Solana RPC endpoint (multiplier + holdings)
npx wrangler secret put ALPACA_KEY        # traditional reference feed, key id
npx wrangler secret put ALPACA_SECRET     # traditional reference feed, secret
npx wrangler secret put FINNHUB_KEY       # /underlying-sync (company profiles and events)
npx wrangler secret put ADMIN_KEY         # required for /run, /resolve, /underlying-sync, /rebuild-cache
npx wrangler secret put ANTHROPIC_API_KEY # /explain-anomaly (optional)
npx wrangler secret put JUPITER_API_KEY # /swap/* (Swap V2 routes, optional)
```

The Worker runs without the Alpaca keys — it simply skips the traditional reference and the app hides that section.

`/swap/*` and `/alerts` can be rate limited per IP. Add a Cloudflare Rate Limiting binding named `RATE_LIMITER` to `wrangler.jsonc` and the Worker uses it; without the binding nothing is limited:

```jsonc
"ratelimits": [{ "name": "RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 60, "period": 60 } }]
```

Without `ANTHROPIC_API_KEY`, `/explain-anomaly` still returns the evidence with `explanation_status: "unavailable"`, so the cost data is never blocked by the explanation.

```bash
npx wrangler deploy
```

The cron trigger (`*/5 * * * *`) starts collecting immediately.

---

## Design decisions worth knowing

**Round trip, not spread.** We buy and immediately sell, then split the loss evenly. This is what a user actually experiences, and it includes routing, price impact and fees — not a theoretical mid-price spread.

**Rotation over frequency.** Measuring 120+ tokens every 5 minutes would exceed the Worker's subrequest budget. Instead a slice is measured each run, so each token is sampled roughly every 50 minutes. Execution costs move slowly (1–4 bps per hour in our data), so this is enough for historical context; the app fetches a live quote at the moment of trading.

**Negative costs are real but not exploitable.** Some tokens occasionally quote a round trip below zero, because Jupiter finds different routes in each direction. The app displays these as `~0 bps` rather than implying a profit.

**Stale references are excluded, not shown.** Outside market hours the traditional reference is a leftover quote. The Worker marks it stale when it is older than 15 minutes or the bid-ask spread exceeds 50 bps, and the app then shows "market closed" rather than a fake premium.

**The model describes, it does not diagnose.** `/explain-anomaly` computes the evidence from the measurements first. Claude never sees the database and only phrases what the evidence shows. Its answer is rejected if it names a cause, makes a prediction or uses a number that is not in the evidence; the app then shows that the explanation is unavailable instead of a guess. A fixed sentence stating that the cause cannot be determined is added by the Worker, not by the model.

---

## Licence

MIT
