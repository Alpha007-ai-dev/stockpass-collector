// US equity market calendar: NYSE full-day holidays and early closes.
// Pure date arithmetic, no external data. The app has an identical copy in lib/market-hours.ts.

export type MarketState = "open" | "pre" | "after" | "closed" | "weekend"

function nthWeekday(y: number, m: number, dow: number, n: number): number {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay()
  return 1 + ((dow - first + 7) % 7) + (n - 1) * 7
}

function lastWeekday(y: number, m: number, dow: number): number {
  const last = new Date(Date.UTC(y, m + 1, 0))
  return last.getUTCDate() - ((last.getUTCDay() - dow + 7) % 7)
}

// Anonymous Gregorian algorithm for Easter Sunday.
function easter(y: number): { m: number; d: number } {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const mm = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * mm + 114) / 31)
  const day = ((h + l - 7 * mm + 114) % 31) + 1
  return { m: month - 1, d: day }
}

const key = (y: number, m: number, d: number) => Date.UTC(y, m, d)

/** A fixed-date holiday: on Saturday it is observed the Friday before, on Sunday the Monday after.
 *  (A New Year's Day on Saturday is not observed on the Friday, per NYSE rules.) */
function observed(y: number, m: number, d: number, saturdayRollsBack = true): number | null {
  const dow = new Date(Date.UTC(y, m, d)).getUTCDay()
  if (dow === 6) return saturdayRollsBack ? key(y, m, d - 1) : null
  if (dow === 0) return key(y, m, d + 1)
  return key(y, m, d)
}

export function holidaysOf(y: number): Set<number> {
  const out = new Set<number>()
  const add = (k: number | null) => { if (k !== null) out.add(k) }
  add(observed(y, 0, 1, false)) // New Year's Day
  add(key(y, 0, nthWeekday(y, 0, 1, 3))) // Martin Luther King Jr. Day
  add(key(y, 1, nthWeekday(y, 1, 1, 3))) // Presidents' Day
  const e = easter(y)
  add(key(y, e.m, e.d - 2)) // Good Friday
  add(key(y, 4, lastWeekday(y, 4, 1))) // Memorial Day
  add(observed(y, 5, 19)) // Juneteenth
  add(observed(y, 6, 4)) // Independence Day
  add(key(y, 8, nthWeekday(y, 8, 1, 1))) // Labor Day
  add(key(y, 10, nthWeekday(y, 10, 4, 4))) // Thanksgiving
  add(observed(y, 11, 25)) // Christmas
  return out
}

/** Days the regular session ends at 13:00 ET. */
export function earlyClosesOf(y: number): Set<number> {
  const out = new Set<number>()
  const hol = holidaysOf(y)
  const weekday = (k: number) => { const w = new Date(k).getUTCDay(); return w !== 0 && w !== 6 }
  const add = (k: number) => { if (weekday(k) && !hol.has(k)) out.add(k) }
  add(key(y, 10, nthWeekday(y, 10, 4, 4) + 1)) // day after Thanksgiving
  add(key(y, 11, 24)) // Christmas Eve
  const jul4 = new Date(Date.UTC(y, 6, 4)).getUTCDay()
  if (jul4 >= 2 && jul4 <= 5) add(key(y, 6, 3)) // July 3rd when July 4th is Tue-Fri
  return out
}

function nthSunday(y: number, m: number, n: number): number {
  return nthWeekday(y, m, 0, n)
}

export function marketStateAt(now: Date): MarketState {
  const y = now.getUTCFullYear()
  const dst = now.getTime() >= Date.UTC(y, 2, nthSunday(y, 2, 2), 7) && now.getTime() < Date.UTC(y, 10, nthSunday(y, 10, 1), 6)
  const ny = new Date(now.getTime() + (dst ? -4 : -5) * 3600000)
  const dow = ny.getUTCDay()
  const mins = ny.getUTCHours() * 60 + ny.getUTCMinutes()
  if (dow === 0 || dow === 6) return "weekend"
  const day = key(ny.getUTCFullYear(), ny.getUTCMonth(), ny.getUTCDate())
  // On a holiday there is no regular session and no pre-market: the whole day counts as closed.
  if (holidaysOf(ny.getUTCFullYear()).has(day)) return "closed"
  const close = earlyClosesOf(ny.getUTCFullYear()).has(day) ? 780 : 960
  if (mins >= 570 && mins < close) return "open"
  if (mins >= 240 && mins < 570) return "pre"
  if (mins >= close && mins < 1200) return "after"
  return "closed"
}
