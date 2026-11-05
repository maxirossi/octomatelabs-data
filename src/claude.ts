import fs from 'node:fs'
import path from 'node:path'
import { MAX_TEXT, redact } from './sanitize.ts'
import type { FileState, UsageEvent } from './types.ts'

export const SOURCE = 'claude_code'

export interface ReadOptions {
  metadataOnly: boolean
  /** Si el archivo no cambió hace más de esto, el último turno se considera completo. */
  settleMs: number
  now: number
  /** Ignora turnos anteriores a esta fecha (backfill acotado). */
  since?: Date
}

export interface ReadResult {
  events: UsageEvent[]
  state: FileState
}

interface Line {
  start: number
  obj: any
}

/** Todos los .jsonl bajo ~/.claude/projects, incluidos los de subagentes. */
export function discoverFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
    }
  }
  walk(root)
  return out
}

function subagentType(file: string): string | null {
  if (!file.includes(`${path.sep}subagents${path.sep}`)) return null
  try {
    const meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
    return typeof meta.agentType === 'string' ? meta.agentType : 'subagent'
  } catch { return 'subagent' }
}

function promptText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null
  if (!Array.isArray(content)) return null
  if (content.some((b) => b?.type === 'tool_result')) return null // respuesta de herramienta, no un prompt
  const t = content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
  return t || null
}

function buildEvent(file: string, lines: Line[], prompt: string | undefined, o: ReadOptions): UsageEvent | null {
  const first = lines[0].obj
  const last = lines[lines.length - 1].obj
  const msg = last.message ?? first.message
  const usage = msg?.usage
  if (!usage || msg.model === '<synthetic>') return null
  const occurred = first.timestamp
  if (!occurred) return null
  if (o.since && new Date(occurred) < o.since) return null

  const blocks = lines.flatMap((l) => (Array.isArray(l.obj.message?.content) ? l.obj.message.content : []))
  const tools = [...new Set<string>(blocks.filter((b: any) => b?.type === 'tool_use').map((b: any) => String(b.name)))]
  const text = blocks.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
  const agent = subagentType(file)
  const n = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.floor(v) : 0)

  const ev: UsageEvent = {
    source: SOURCE,
    external_id: String(msg.id ?? first.uuid),
    occurred_at: occurred,
    session_id: first.sessionId ?? null,
    model: msg.model ?? null,
    project: first.cwd ?? null,
    git_branch: first.gitBranch ?? null,
    client: first.entrypoint ?? null,
    is_subagent: agent !== null || first.isSidechain === true,
    agent_name: agent,
    tools: tools.length ? tools : null,
    input_tokens: n(usage.input_tokens),
    output_tokens: n(usage.output_tokens),
    cache_read_tokens: n(usage.cache_read_input_tokens),
    cache_creation_tokens: n(usage.cache_creation_input_tokens),
    thinking_tokens: n(usage.output_tokens_details?.thinking_tokens),
    duration_ms: null,
    raw: {
      version: first.version, request_id: first.requestId, stop_reason: msg.stop_reason,
      service_tier: usage.service_tier, speed: usage.speed, effort: first.effort,
    },
  }
  if (!o.metadataOnly) {
    ev.request_text = prompt ? redact(prompt.slice(0, MAX_TEXT)) : null
    ev.response_text = text ? redact(text) : null
  }
  return ev
}

/**
 * Lee un archivo desde el offset guardado y devuelve los turnos nuevos.
 * Un turno del asistente llega partido en varias líneas (una por bloque: thinking, text, tool_use)
 * con el mismo message.id y el mismo usage: se fusionan en un solo evento.
 * El último grupo se retiene hasta que el archivo deje de crecer para no mandarlo incompleto.
 */
export function readFile(file: string, prev: FileState | undefined, o: ReadOptions): ReadResult {
  const st = fs.statSync(file)
  let offset = prev?.offset ?? 0
  if (offset > st.size) offset = 0 // el archivo fue reescrito/truncado
  let prompt = offset === 0 ? undefined : prev?.lastPrompt
  if (st.size === offset) return { events: [], state: { offset, lastPrompt: prompt } }

  const fd = fs.openSync(file, 'r')
  let buf: Buffer
  try {
    buf = Buffer.alloc(st.size - offset)
    fs.readSync(fd, buf, 0, buf.length, offset)
  } finally { fs.closeSync(fd) }

  const lastNl = buf.lastIndexOf(0x0a)
  if (lastNl === -1) return { events: [], state: { offset, lastPrompt: prompt } }
  const consumed = lastNl + 1

  const events: UsageEvent[] = []
  let group: { id: string; lines: Line[]; promptAtStart: string | undefined } | null = null
  let pos = 0
  const flush = () => {
    if (!group) return
    const ev = buildEvent(file, group.lines, group.promptAtStart, o)
    if (ev) events.push(ev)
    if (group.promptAtStart !== undefined) prompt = undefined // el prompt se atribuye solo al primer turno
    group = null
  }

  while (pos < consumed) {
    let nl = buf.indexOf(0x0a, pos)
    const start = offset + pos
    const raw = buf.toString('utf8', pos, nl)
    pos = nl + 1
    if (!raw.trim()) continue
    let obj: any
    try { obj = JSON.parse(raw) } catch { continue }

    if (obj.type === 'assistant' && obj.message?.id) {
      if (group && group.id !== obj.message.id) flush()
      if (!group) group = { id: obj.message.id, lines: [], promptAtStart: prompt }
      group.lines.push({ start, obj })
    } else if (obj.type === 'user') {
      flush()
      const p = promptText(obj.message?.content)
      if (p) prompt = p
    }
  }

  let newOffset = offset + consumed
  const g = group as { lines: Line[]; promptAtStart: string | undefined } | null
  if (g && o.settleMs > 0 && o.now - st.mtimeMs < o.settleMs) {
    // último turno posiblemente incompleto: se vuelve a leer desde su primera línea
    newOffset = g.lines[0].start
    prompt = g.promptAtStart
    group = null
  } else {
    flush()
  }
  return { events, state: { offset: newOffset, lastPrompt: prompt } }
}
