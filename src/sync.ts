import fs from 'node:fs'
import { discoverFiles, readFile } from './claude.ts'
import type { Config } from './config.ts'
import { discoverCopilotFiles, readCopilotFile } from './copilot.ts'
import type { UsageEvent } from './types.ts'
import { redactStrict } from './sanitize.ts'
import { sendAll } from './sender.ts'
import { loadState, saveState } from './state.ts'

export interface SyncStats { files: number; events: number; inserted: number; duplicates: number; dropped: number }

/** Un ciclo: lee lo nuevo de cada archivo, lo envía y recién entonces avanza los offsets. */
export async function syncOnce(cfg: Config, statePath: string, opts: { since?: Date; settleMs?: number; backfill?: boolean; dryRun?: boolean; onEvents?: (events: UsageEvent[], sent: boolean) => void } = {}): Promise<SyncStats> {
  const state = loadState(statePath)
  // Los eventos de varios archivos se juntan en lotes de BATCH para no gastar el límite de requests/min
  // del server; el offset de cada archivo se guarda recién cuando su lote fue aceptado.
  const BATCH = 200
  let pending: { events: UsageEvent[]; commits: Array<() => void> } = { events: [], commits: [] }
  const flush = async () => {
    if (opts.dryRun) { // vista previa: no se envía ni se avanza ningún offset
      if (pending.events.length) { opts.onEvents?.(pending.events, false); stats.events += pending.events.length }
      pending = { events: [], commits: [] }
      return
    }
    if (!pending.events.length) { pending.commits.forEach((c) => c()); pending = { events: [], commits: [] }; return }
    const r = await sendAll(cfg.url, cfg.key, pending.events, BATCH)
    opts.onEvents?.(pending.events, true)
    stats.events += pending.events.length
    stats.inserted += r.inserted; stats.duplicates += r.duplicates; stats.dropped += r.dropped
    pending.commits.forEach((c) => c())
    pending = { events: [], commits: [] }
    saveState(statePath, state)
  }
  const enqueue = async (events: UsageEvent[], commit: () => void) => {
    if (cfg.strictRedact) events = events.map((e) => ({ ...e, request_text: redactStrict(e.request_text), response_text: redactStrict(e.response_text) }))
    pending.events.push(...events); pending.commits.push(commit)
    if (pending.events.length >= BATCH) await flush()
  }
  const stats: SyncStats = { files: 0, events: 0, inserted: 0, duplicates: 0, dropped: 0 }
  const now = Date.now()
  // Primera ejecución: lo que ya existe es histórico y NO se envía (eso es "backfill", explícito).
  const firstRun = !state.initializedAt && !opts.backfill
  if (firstRun && opts.dryRun) return stats // nada que mostrar: la primera ejecución no envía histórico

  for (const file of discoverFiles(cfg.claudeDir)) {
    if (firstRun) {
      try { state.files[file] = { offset: fs.statSync(file).size } } catch { /* desapareció */ }
      continue
    }
    let res
    try {
      res = readFile(file, opts.backfill ? undefined : state.files[file], {
        metadataOnly: cfg.metadataOnly, settleMs: opts.settleMs ?? 60_000, now, since: opts.since,
      })
    } catch (e) {
      console.error(`[octomate-data] no se pudo leer ${file}: ${(e as Error).message}`)
      continue
    }
    stats.files++
    const st = res.state
    // si el envío falla lanza y el offset de este archivo no avanza → se reintenta en el próximo ciclo
    await enqueue(res.events, () => { state.files[file] = st })
  }
  // Copilot (VS Code): delta log que se relee entero cuando cambia; solo se envía lo posterior a la inicialización.
  if (cfg.copilotDir && !firstRun) {
    const initAt = state.initializedAt ? new Date(state.initializedAt) : new Date()
    for (const file of discoverCopilotFiles(cfg.copilotDir)) {
      const key = `copilot:${file}`
      let res
      try {
        if (!opts.backfill && fs.statSync(file).mtimeMs < initAt.getTime()) continue // historia vieja, no se toca
        res = readCopilotFile(file, state.files[key], {
          metadataOnly: cfg.metadataOnly, since: opts.since ?? initAt, ignoreDone: opts.backfill,
        })
      } catch (e) {
        console.error(`[octomate-data] no se pudo leer ${file}: ${(e as Error).message}`)
        continue
      }
      stats.files++
      const st = res.state
      await enqueue(res.events, () => { state.files[key] = st })
    }
  }
  await flush()
  if (opts.dryRun) return stats
  state.initializedAt ??= new Date().toISOString()
  saveState(statePath, state)
  return stats
}
