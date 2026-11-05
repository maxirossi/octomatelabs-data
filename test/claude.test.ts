import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readFile } from '../src/claude.ts'
import { redact } from '../src/sanitize.ts'
import { sendAll } from '../src/sender.ts'
import { syncOnce } from '../src/sync.ts'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'omd-'))
const line = (o: object) => JSON.stringify(o) + '\n'
const usage = { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens_details: { thinking_tokens: 7 } }
const asst = (id: string, ts: string, content: object[], extra: object = {}) =>
  line({ type: 'assistant', uuid: `u-${Math.random()}`, timestamp: ts, sessionId: 's1', cwd: '/p', gitBranch: 'main', entrypoint: 'cli',
    message: { id, model: 'claude-sonnet-5-5', content, usage }, ...extra })
const user = (content: unknown) => line({ type: 'user', uuid: 'x', timestamp: '2026-11-05T10:00:00Z', message: { role: 'user', content } })
const opts = { metadataOnly: false, settleMs: 60_000, now: Date.now() + 120_000 } // now lejano: todo "asentado"

test('fusiona los bloques de un mismo mensaje en un evento y atribuye el prompt', () => {
  const f = path.join(tmp(), 's.jsonl')
  fs.writeFileSync(f,
    user('hacé X con sk-ant-abcdefghijklmnopqrstuvwxyz123456') +
    asst('m1', '2026-11-05T10:00:01Z', [{ type: 'thinking' }], {}) +
    asst('m1', '2026-11-05T10:00:02Z', [{ type: 'text', text: 'listo' }, { type: 'tool_use', name: 'Bash' }]) +
    user([{ type: 'tool_result' }]) +
    asst('m2', '2026-11-05T10:00:05Z', [{ type: 'text', text: 'fin' }]))
  const r = readFile(f, undefined, opts)
  assert.equal(r.events.length, 2)
  const [a, b] = r.events
  assert.equal(a.external_id, 'm1')
  assert.equal(a.output_tokens, 50)           // no se suma por bloque
  assert.equal(a.thinking_tokens, 7)
  assert.deepEqual(a.tools, ['Bash'])
  assert.equal(a.response_text, 'listo')
  assert.ok(a.request_text?.includes('[REDACTED]') && !a.request_text.includes('sk-ant'))
  assert.equal(b.request_text, null)          // el prompt va solo en el primer turno
  assert.equal(a.client, 'cli'); assert.equal(a.project, '/p')
})

test('metadataOnly no incluye textos', () => {
  const f = path.join(tmp(), 's.jsonl')
  fs.writeFileSync(f, user('secreto') + asst('m1', '2026-11-05T10:00:01Z', [{ type: 'text', text: 'hola' }]))
  const e = readFile(f, undefined, { ...opts, metadataOnly: true }).events[0]
  assert.equal(e.request_text, undefined); assert.equal(e.response_text, undefined)
  assert.equal(e.input_tokens, 2)
})

test('retiene el último turno mientras el archivo sigue creciendo y no duplica al completarse', () => {
  const f = path.join(tmp(), 's.jsonl')
  fs.writeFileSync(f, user('p') + asst('m1', '2026-11-05T10:00:01Z', [{ type: 'thinking' }]))
  const live = { ...opts, now: Date.now() } // archivo recién modificado
  const r1 = readFile(f, undefined, live)
  assert.equal(r1.events.length, 0)
  fs.appendFileSync(f, asst('m1', '2026-11-05T10:00:02Z', [{ type: 'text', text: 'ok' }]))
  const r2 = readFile(f, r1.state, opts)
  assert.equal(r2.events.length, 1)
  assert.equal(r2.events[0].response_text, 'ok')
  assert.equal(r2.events[0].request_text, 'p') // el prompt sobrevivió a la relectura
  assert.equal(readFile(f, r2.state, opts).events.length, 0)
})

test('línea parcial al final no se consume', () => {
  const f = path.join(tmp(), 's.jsonl')
  const full = asst('m1', '2026-11-05T10:00:01Z', [{ type: 'text', text: 'a' }])
  fs.writeFileSync(f, full + '{"type":"assis')
  const r = readFile(f, undefined, opts)
  assert.equal(r.events.length, 1)
  assert.equal(r.state.offset, Buffer.byteLength(full))
})

test('respeta since y omite mensajes sintéticos', () => {
  const f = path.join(tmp(), 's.jsonl')
  fs.writeFileSync(f, asst('old', '2026-01-01T00:00:00Z', [{ type: 'text', text: 'a' }]) +
    asst('new', '2026-11-05T00:00:00Z', [{ type: 'text', text: 'b' }]) +
    line({ type: 'assistant', timestamp: '2026-11-05T00:00:01Z', message: { id: 'syn', model: '<synthetic>', content: [], usage } }))
  const ids = readFile(f, undefined, { ...opts, since: new Date('2026-06-01') }).events.map((e) => e.external_id)
  assert.deepEqual(ids, ['new'])
})

test('subagente toma el nombre de .meta.json', () => {
  const d = path.join(tmp(), 'sess', 'subagents'); fs.mkdirSync(d, { recursive: true })
  const f = path.join(d, 'agent-1.jsonl')
  fs.writeFileSync(f, asst('m1', '2026-11-05T10:00:01Z', [{ type: 'text', text: 'a' }], { isSidechain: true }))
  fs.writeFileSync(path.join(d, 'agent-1.meta.json'), JSON.stringify({ agentType: 'Explore' }))
  const e = readFile(f, undefined, opts).events[0]
  assert.equal(e.is_subagent, true); assert.equal(e.agent_name, 'Explore')
})

test('redact cubre secretos comunes', () => {
  const t = redact('DB_PASSWORD=hunter2\npostgres://u:pw@h/db\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz')!
  assert.ok(!/hunter2|:pw@|abcdefghijklmnop/.test(t))
})

async function fakeServer(handler: (body: any, n: number) => { status: number; json: object }) {
  let n = 0
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const r = handler(b ? JSON.parse(b) : {}, ++n)
      res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r.json))
    })
  })
  await new Promise<void>((r) => srv.listen(0, r))
  return { url: `http://127.0.0.1:${(srv.address() as any).port}`, close: () => { srv.closeAllConnections(); srv.close() }, calls: () => n }
}
const ev = (i: string) => ({ source: 'claude_code', external_id: i, occurred_at: '2026-11-05T10:00:00Z', is_subagent: false,
  input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 0 })

test('sender reintenta ante 500 y luego tiene éxito', async () => {
  const s = await fakeServer((_b, n) => (n < 3 ? { status: 500, json: {} } : { status: 200, json: { inserted: 1, duplicates: 0 } }))
  const r = await sendAll(s.url, 'omk_x', [ev('a')], 200, 4)
  assert.equal(r.inserted, 1); assert.equal(s.calls(), 3); s.close()
})

test('sender: 401 lanza y 422 aísla el evento malo', async () => {
  const s401 = await fakeServer(() => ({ status: 401, json: {} }))
  await assert.rejects(sendAll(s401.url, 'omk_x', [ev('a')]), /Key rechazada/); s401.close()
  const s422 = await fakeServer((b) =>
    b.events.some((e: any) => e.external_id === 'bad') ? { status: 422, json: {} } : { status: 200, json: { inserted: b.events.length, duplicates: 0 } })
  const r = await sendAll(s422.url, 'omk_x', [ev('a'), ev('bad'), ev('c')])
  assert.deepEqual(r, { inserted: 2, duplicates: 0, dropped: 1 }); s422.close()
})

test('syncOnce: la primera ejecución no envía histórico, solo lo nuevo; si falla el envío no avanza', async () => {
  const dir = tmp(); const f = path.join(dir, 'proj', 's.jsonl'); fs.mkdirSync(path.dirname(f))
  fs.writeFileSync(f, asst('hist', '2026-11-01T00:00:00Z', [{ type: 'text', text: 'viejo' }]))
  let fail = true; const got: string[] = []
  const s = await fakeServer((b) => {
    if (fail) return { status: 500, json: {} }
    got.push(...b.events.map((e: any) => e.external_id)); return { status: 200, json: { inserted: b.events.length, duplicates: 0 } }
  })
  const cfg = { url: s.url, key: 'omk_x', metadataOnly: false, strictRedact: true, intervalSeconds: 30, claudeDir: dir, copilotDir: null }
  const sp = path.join(tmp(), 'state.json')
  await syncOnce(cfg, sp, { settleMs: 0 })
  fs.appendFileSync(f, asst('nuevo', '2026-11-05T00:00:00Z', [{ type: 'text', text: 'n' }]))
  await assert.rejects(syncOnce(cfg, sp, { settleMs: 0 }))   // 500 hasta agotar reintentos
  fail = false
  await syncOnce(cfg, sp, { settleMs: 0 })
  assert.deepEqual(got, ['nuevo']); s.close()
})

// ───── Copilot ─────
import { readCopilotFile, rebuildSession } from '../src/copilot.ts'

function copilotWorkspace(requests: object[], opts: { sizeExtra?: string } = {}) {
  const ws = path.join(tmp(), 'abc123'); fs.mkdirSync(path.join(ws, 'chatSessions'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'workspace.json'), JSON.stringify({ folder: 'file:///home/u/mi%20proyecto' }))
  const f = path.join(ws, 'chatSessions', 'sess-1.jsonl')
  fs.writeFileSync(f, line({ kind: 0, v: { version: 3, sessionId: 'sess-1', requests: [] } }) + line({ kind: 2, k: ['requests'], v: requests }) + (opts.sizeExtra ?? ''))
  return f
}
const req = (id: string, extra: object = {}) => ({
  requestId: id, timestamp: Date.parse('2026-11-05T10:00:00Z'), modelId: 'copilot/claude-sonnet-4.6', elapsedMs: 8000,
  agent: { id: 'github.copilot.editsAgent', name: 'agent' }, message: { text: 'arreglá esto con sk-ant-abcdefghijklmnopqrstuvwxyz123456' },
  response: [{ value: 'hecho' }, { kind: 'thinking', value: 'pensando' },
    { kind: 'toolInvocationSerialized', toolId: 'readFile', toolCallId: 'c1' },
    { kind: 'toolInvocationSerialized', toolId: 'runSubagent', toolCallId: 'c2', toolSpecificData: { kind: 'subagent', agentName: 'backend-developer', result: '' } },
    { kind: 'toolInvocationSerialized', toolId: 'runSubagent', toolCallId: 'c2', toolSpecificData: { kind: 'subagent', agentName: 'backend-developer', result: 'ok!' } }],
  result: { metadata: { promptTokens: 1000, outputTokens: 50 }, details: 'Claude Sonnet 4.6 • 1x' }, completionTokens: 300,
  modelState: { value: 1, completedAt: 1 }, ...extra,
})

test('copilot: reconstruye el delta log y mapea un request a un evento', () => {
  const f = copilotWorkspace([req('r1')])
  const { events } = readCopilotFile(f, undefined, { metadataOnly: false })
  assert.equal(events.length, 1)
  const e = events[0]
  assert.equal(e.source, 'copilot'); assert.equal(e.external_id, 'copilot:r1'); assert.equal(e.model, 'claude-sonnet-4.6')
  assert.equal(e.project, '/home/u/mi proyecto'); assert.equal(e.client, 'vscode'); assert.equal(e.session_id, 'sess-1')
  assert.equal(e.input_tokens, 1000); assert.equal(e.output_tokens, 300); assert.equal(e.duration_ms, 8000)
  assert.deepEqual(e.tools, ['readFile', 'runSubagent'])
  assert.equal(e.response_text, 'hecho')                      // sin el thinking
  assert.ok(!e.request_text!.includes('sk-ant'))
  assert.deepEqual((e.raw as any).subagents, [{ agent_name: 'backend-developer', model: null, result_chars: 3 }])
})

test('copilot: ignora requests en curso, aplica deltas de reemplazo y no reenvía lo ya enviado', () => {
  const f = copilotWorkspace([req('r1', { result: undefined, modelState: { value: 0 } })])
  assert.equal(readCopilotFile(f, undefined, { metadataOnly: false }).events.length, 0)
  fs.appendFileSync(f, line({ kind: 1, k: ['requests', 0, 'modelState'], v: { value: 1, completedAt: 5 } }))
  const r = readCopilotFile(f, undefined, { metadataOnly: false })
  assert.equal(r.events.length, 1)
  assert.equal(readCopilotFile(f, r.state, { metadataOnly: false }).events.length, 0)
  fs.appendFileSync(f, line({ kind: 2, k: ['requests'], v: [req('r2')] }))
  assert.deepEqual(readCopilotFile(f, r.state, { metadataOnly: false }).events.map((e) => e.external_id), ['copilot:r2'])
})

test('copilot: since descarta lo anterior; elapsedMs absurdo queda en null; metadataOnly sin textos', () => {
  const f = copilotWorkspace([req('old', { timestamp: 1000 }), req('new', { elapsedMs: 99_999_999 })])
  const { events } = readCopilotFile(f, undefined, { metadataOnly: true, since: new Date('2026-01-01') })
  assert.deepEqual(events.map((e) => e.external_id), ['copilot:new'])
  assert.equal(events[0].duration_ms, null); assert.equal(events[0].request_text, undefined)
})

test('rebuildSession tolera líneas rotas', () => {
  const s = rebuildSession(line({ kind: 0, v: { requests: [] } }) + '{roto\n' + line({ kind: 2, k: ['requests'], v: [{ requestId: 'a' }] }))
  assert.equal(s.requests.length, 1)
})

test('redactStrict corta claves sin formato conocido pero respeta texto normal', async () => {
  const { redactStrict } = await import('../src/sanitize.ts')
  const t = redactStrict([
    'mi password: Sup3rS3cr3to!', 'export stripeKey="abc123XYZ789"', 'curl --token abcDEF123456 https://x.io/a?api_key=zzTop1234&b=1',
    'cadena Zq81vK0mPfa93LxT7nRb2YdE5hWc4uGs aleatoria', 'commit 3f2a9c1d4e5b6a7f8091a2b3c4d5e6f708192a3b ok', 'sk_live_51HabcdefGhijk', 'const total = items.length + 1',
  ].join('\n'))!
  for (const secreto of ['Sup3rS3cr3to', 'abc123XYZ789', 'abcDEF123456', 'zzTop1234', 'Zq81vK0mPfa93LxT7nRb2YdE5hWc4uGs', 'sk_live_51Habcdef']) assert.ok(!t.includes(secreto), `se filtró ${secreto}\n${t}`)
  assert.ok(t.includes('3f2a9c1d4e5b6a7f8091a2b3c4d5e6f708192a3b'), 'un SHA de git no es secreto')
  assert.ok(t.includes('const total = items.length + 1'))
  assert.ok(t.includes('b=1'))
})
