// Optional per-IP rate limit. It uses a Cloudflare Rate Limiting binding named RATE_LIMITER when one is
// configured (see README-collector.md); without the binding nothing is limited and nothing breaks.

export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export async function isLimited(limiter: Limiter | undefined, req: Request, scope: string): Promise<boolean> {
  if (!limiter) return false
  try {
    const ip = req.headers.get("cf-connecting-ip") ?? "unknown"
    const r = await limiter.limit({ key: `${scope}:${ip}` })
    return !r.success
  } catch {
    return false // a limiter failure must never take the endpoint down
  }
}
