import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_TEXT, redact } from './sanitize.ts'
import type { FileState, UsageEvent } from './types.ts'

export const COPILOT_SOURCE = 'copilot'
const MAX_FILE_BYTES = 600 * 1024 * 1024
const MAX_ELAPSED_MS = 3_600_000 // VS Code acumula wall-clock si estuvo cerrado: más de 1 h no es una latencia real

/** <workspaceStorage>/<hash>/chatSessions/*.jsonl */
export function discoverCopilotFiles(root: string): string[] {
  const out: string[] = []
  let dirs: fs.Dirent[]
  try { dirs = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const sessions = path.join(root, d.name, 'chatSessions')
    let files: string[]
    try { files = fs.readdirSync(sessions) } catch { continue }
    for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(sessions, f))
  }
  return out
}

/** Log append-only de deltas: kind 0 snapshot, 1 reemplazo en la ruta k, 2 extensión en la ruta k. */
export function rebuildSession(text: string): any {
  let state: any = {}
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    let op: any
    try { op = JSON.parse(raw) } catch { continue }
    try {
      if (op.kind === 0) { state = op.v; continue }
      const p: (string | number)[] = op.k ?? []
      if (!p.length) { if (op.kind === 1) state = op.v; continue }
      let cur = state
      for (const seg of p.slice(0, -1)) cur = cur[seg]
      const last = p[p.length - 1]
      if (op.kind === 1) cur[last] = op.v
      else if (op.kind === 2) { Array.isArray(op.v) ? cur[last].push(...op.v) : cur[last].push(op.v) }
    } catch { /* delta inconsistente: se ignora, como el Observatory */ }
  }
  return state
}

function workspaceFolder(file: string): string | null {
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(file)), 'workspace.json'), 'utf8'))
    if (typeof ws.folder === 'string' && ws.folder.startsWith('file://')) return fileURLToPath(ws.folder)
  } catch { /* sin workspace.json o multi-root */ }
  return null
}

function responseText(response: unknown): string {
  if (!Array.isArray(response)) return ''
  const parts: string[] = []
  for (const it of response) {
    if (!it || typeof it !== 'object') continue
    const item = it as any
    if (item.kind === 'thinking') continue
    if (typeof item.value === 'string') parts.push(item.value)
    else if (typeof item.content?.value === 'string') parts.push(item.content.value)
  }
  return parts.join('\n')
}

function toolsAndSubagents(response: unknown): { tools: string[]; subagents: object[] } {
  const tools = new Set<string>()
  const byCall = new Map<string, any>()
  if (Array.isArray(response)) {
    for (const it of response as any[]) {
      if (it?.kind !== 'toolInvocationSerialized') continue
      if (typeof it.toolId === 'string') tools.add(it.toolId)
      const tsd = it.toolSpecificData
      if (tsd?.kind === 'subagent' && typeof tsd.agentName === 'string' && tsd.agentName.trim()) {
        const id = it.toolCallId ?? `pos${byCall.size}`
        const len = typeof tsd.result === 'string' ? tsd.result.length : 0
        const prev = byCall.get(id)
        if (!prev || len >= prev.result_chars) byCall.set(id, { agent_name: tsd.agentName.trim(), model: tsd.modelName ?? null, result_chars: len })
      }
    }
  }
  return { tools: [...tools], subagents: [...byCall.values()] }
}

export interface CopilotReadOptions {
  metadataOnly: boolean
  /** Solo se envían requests con timestamp >= since (primera ejecución: el momento de inicialización). */
  since?: Date
  /** Ignora lo ya enviado (backfill). */
  ignoreDone?: boolean
}

export function readCopilotFile(file: string, prev: FileState | undefined, o: CopilotReadOptions): { events: UsageEvent[]; state: FileState } {
  const st = fs.statSync(file)
  const same = prev && prev.offset === st.size && prev.mtimeMs === st.mtimeMs
  if (same && !o.ignoreDone) return { events: [], state: prev! }
  if (st.size > MAX_FILE_BYTES) return { events: [], state: { offset: st.size, mtimeMs: st.mtimeMs, done: prev?.done } }

  const session = rebuildSession(fs.readFileSync(file, 'utf8'))
  const requests: any[] = Array.isArray(session?.requests) ? session.requests : []
  const done = new Set(o.ignoreDone ? [] : (prev?.done ?? []))
  const project = workspaceFolder(file)
  const sessionId = (typeof session?.sessionId === 'string' && session.sessionId) || path.basename(file, '.jsonl')
  const events: UsageEvent[] = []

  for (const r of requests) {
    const id = r?.requestId
    if (typeof id !== 'string' || done.has(id)) continue
    const complete = r.modelState?.completedAt != null || r.result != null
    if (!complete) continue // sigue en curso: se toma en el próximo ciclo
    const ts = typeof r.timestamp === 'number' ? r.timestamp : null
    if (ts === null) continue
    if (o.since && ts < o.since.getTime()) { done.add(id); continue }

    const md = r.result?.metadata ?? {}
    const num = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.floor(v) : 0)
    const { tools, subagents } = toolsAndSubagents(r.response)
    const elapsed = typeof r.elapsedMs === 'number' && r.elapsedMs >= 0 && r.elapsedMs <= MAX_ELAPSED_MS ? Math.floor(r.elapsedMs) : null
    const ev: UsageEvent = {
      source: COPILOT_SOURCE,
      external_id: `copilot:${id}`,
      occurred_at: new Date(ts).toISOString(),
      session_id: sessionId,
      model: typeof r.modelId === 'string' ? r.modelId.replace(/^copilot\//, '') : null,
      project,
      git_branch: null,
      client: 'vscode',
      is_subagent: false,
      agent_name: r.agent?.name ?? null,
      tools: tools.length ? tools : null,
      input_tokens: num(md.promptTokens),
      output_tokens: num(r.completionTokens) || num(md.outputTokens),
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      thinking_tokens: 0,
      duration_ms: elapsed,
      raw: {
        native_agent_id: r.agent?.id, mode: r.modeInfo?.modeId, details: r.result?.details,
        tokens_note: 'Copilot reporta tokens por request, no por llamada: input es aproximado',
        subagents: subagents.length ? subagents : undefined,
        error: r.result?.errorDetails?.code,
      },
    }
    if (!o.metadataOnly) {
      const prompt = typeof r.message?.text === 'string' ? r.message.text : ''
      const resp = responseText(r.response)
      ev.request_text = prompt ? redact(prompt.slice(0, MAX_TEXT)) : null
      ev.response_text = resp ? redact(resp) : null
    }
    events.push(ev)
  }
  return { events, state: { offset: st.size, mtimeMs: st.mtimeMs, done: [...done, ...events.map((e) => e.external_id.slice(8))] } }
}
