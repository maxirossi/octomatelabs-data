import type { UsageEvent } from './types.ts'

export class AuthError extends Error {}

export interface SendResult { inserted: number; duplicates: number; dropped: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function post(url: string, key: string, events: UsageEvent[]): Promise<Response> {
  return fetch(`${url}/v1/ingest/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'octomatelabs-data' },
    body: JSON.stringify({ events }),
    signal: AbortSignal.timeout(30_000),
  })
}

export async function ping(url: string, key: string): Promise<{ ok: boolean; status: number; label?: string; accountEmail?: string; error?: string }> {
  try {
    const r = await fetch(`${url}/v1/ingest/ping`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
    if (!r.ok) return { ok: false, status: r.status, error: (await r.json().catch(() => ({}))).detail }
    const j = await r.json()
    return { ok: true, status: r.status, label: j.label, accountEmail: (j.account_email ?? '') || undefined }
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message }
  }
}

/**
 * Envía en lotes. Reintenta con backoff ante red caída, 429 y 5xx (lanza si se agotan: el llamador
 * no avanza el offset y reintenta en el próximo ciclo). 401/403 lanzan AuthError. Un lote rechazado
 * con 4xx (422) se manda de a un evento para descartar solo el malo.
 */
export async function sendAll(url: string, key: string, events: UsageEvent[], batch = 200, retries = 6): Promise<SendResult> {
  const total: SendResult = { inserted: 0, duplicates: 0, dropped: 0 }
  for (let i = 0; i < events.length; i += batch) {
    const chunk = events.slice(i, i + batch)
    const r = await sendChunk(url, key, chunk, retries)
    total.inserted += r.inserted; total.duplicates += r.duplicates; total.dropped += r.dropped
  }
  return total
}

async function sendChunk(url: string, key: string, chunk: UsageEvent[], retries: number): Promise<SendResult> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await post(url, key, chunk)
      if (r.ok) {
        const j = await r.json()
        return { inserted: j.inserted ?? 0, duplicates: j.duplicates ?? 0, dropped: 0 }
      }
      if (r.status === 401 || r.status === 403) throw new AuthError(`Key rechazada (${r.status}): revisá OCTOMATELABS_KEY`)
      if (r.status === 429) {
        // límite por minuto del server: esperar a que se vacíe la ventana (respeta Retry-After)
        const wait = Number(r.headers.get('retry-after'))
        lastErr = new Error('HTTP 429')
        await sleep(Math.max(Number.isFinite(wait) ? wait * 1000 : 0, Math.min(65_000, 15_000 * (attempt + 1))))
        continue
      }
      if (r.status >= 500) { lastErr = new Error(`HTTP ${r.status}`) }
      else if (chunk.length > 1) {
        const sum: SendResult = { inserted: 0, duplicates: 0, dropped: 0 }
        for (const e of chunk) {
          const one = await sendChunk(url, key, [e], retries)
          sum.inserted += one.inserted; sum.duplicates += one.duplicates; sum.dropped += one.dropped
        }
        return sum
      } else {
        console.error(`[octomate-data] evento descartado (HTTP ${r.status}): ${chunk[0].external_id}`)
        return { inserted: 0, duplicates: 0, dropped: 1 }
      }
    } catch (e) {
      if (e instanceof AuthError) throw e
      lastErr = e
    }
    await sleep(Math.min(30_000, 500 * 2 ** attempt))
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
