import fs from 'node:fs'
import path from 'node:path'
import { SENT_LOG_PATH } from './config.ts'
import type { UsageEvent } from './types.ts'

const MAX_BYTES = 5 * 1024 * 1024

export interface SentEntry { sentAt: string; event: UsageEvent }

/** Registro local (JSONL) de lo que se envió, para poder auditarlo. Contiene prompts: modo 0600. */
export function appendSent(events: UsageEvent[], file = SENT_LOG_PATH): void {
  if (!events.length) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1') } catch { /* no existe */ }
    const at = new Date().toISOString()
    fs.appendFileSync(file, events.map((event) => JSON.stringify({ sentAt: at, event })).join('\n') + '\n', { mode: 0o600 })
  } catch { /* el log nunca debe romper la sincronización */ }
}

/** Últimos n eventos enviados, el más reciente primero. */
export function tailSent(n = 50, file = SENT_LOG_PATH): SentEntry[] {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out: SentEntry[] = []
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    if (!lines[i]) continue
    try { out.push(JSON.parse(lines[i])) } catch { /* línea corrupta */ }
  }
  return out
}
