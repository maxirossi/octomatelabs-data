import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Config } from '../src/config.ts'
import { appendSent, tailSent } from '../src/sentlog.ts'
import { syncOnce } from '../src/sync.ts'
import type { UsageEvent } from '../src/types.ts'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'omd-'))
const line = (o: object) => JSON.stringify(o) + '\n'
const usage = { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const asst = (id: string) => line({ type: 'assistant', uuid: id, timestamp: '2026-11-05T10:00:01Z', sessionId: 's', cwd: '/p',
  message: { id, model: 'm', content: [{ type: 'text', text: 'hola' }], usage } })
const ev = (id: string): UsageEvent => ({ source: 'claude_code', external_id: id, occurred_at: 'x', is_subagent: false,
  input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, thinking_tokens: 0 })

test('dryRun devuelve los eventos y no envía ni avanza el estado', async () => {
  const dir = tmp(); const statePath = path.join(tmp(), 'state.json')
  const cfg = { url: 'http://127.0.0.1:1', key: 'omk_x', metadataOnly: false, intervalSeconds: 30, claudeDir: dir, copilotDir: null } as Config
  const f = path.join(dir, 's.jsonl')
  fs.writeFileSync(f, '')
  await syncOnce(cfg, statePath, { settleMs: 0 })        // primera ejecución: solo marca offsets
  const stateBefore = fs.readFileSync(statePath, 'utf8')
  fs.appendFileSync(f, asst('m1'))
  const seen: Array<[string, boolean]> = []
  const s = await syncOnce(cfg, statePath, { settleMs: 0, dryRun: true, onEvents: (e, sent) => e.forEach((x) => seen.push([x.external_id, sent])) })
  assert.equal(s.events, 1)
  assert.deepEqual(seen, [['m1', false]])                // url inválida: si intentara enviar, fallaría
  assert.equal(fs.readFileSync(statePath, 'utf8'), stateBefore)
})

test('dryRun en la primera ejecución no muestra histórico ni crea estado', async () => {
  const dir = tmp(); const statePath = path.join(tmp(), 'state.json')
  fs.writeFileSync(path.join(dir, 's.jsonl'), asst('m1'))
  const cfg = { url: 'http://127.0.0.1:1', key: 'omk_x', metadataOnly: false, intervalSeconds: 30, claudeDir: dir, copilotDir: null } as Config
  const s = await syncOnce(cfg, statePath, { settleMs: 0, dryRun: true })
  assert.equal(s.events, 0)
  assert.equal(fs.existsSync(statePath), false)
})

test('sent.log agrega, devuelve lo más reciente primero y rota al pasar el tope', () => {
  const f = path.join(tmp(), 'sent.log')
  appendSent([ev('a'), ev('b')], f); appendSent([ev('c')], f)
  assert.deepEqual(tailSent(2, f).map((x) => x.event.external_id), ['c', 'b'])
  assert.equal(tailSent(10, f).length, 3)
  assert.deepEqual(tailSent(5, path.join(tmp(), 'no-existe')), [])
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600)
  fs.appendFileSync(f, 'x'.repeat(5 * 1024 * 1024 + 1) + '\n')
  appendSent([ev('d')], f)
  assert.ok(fs.existsSync(f + '.1'))
  assert.deepEqual(tailSent(5, f).map((x) => x.event.external_id), ['d'])
})
