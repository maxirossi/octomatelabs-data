import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addProvider, loadProviders, removeProvider } from '../src/llm.ts'

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llm-')), 'llm.json')

test('add, list and remove providers', () => {
  const f = tmp()
  addProvider({ id: 'a1', kind: 'anthropic', apiKey: 'k' }, f)
  assert.deepEqual(loadProviders({}, f).map((p) => p.id), ['a1'])
  assert.throws(() => addProvider({ id: 'a1', kind: 'openai', apiKey: 'k' }, f), /already/)
  removeProvider('a1', f)
  assert.equal(loadProviders({}, f).length, 0)
})

test('validation: key required except ollama, bad kind and url', () => {
  const f = tmp()
  assert.throws(() => addProvider({ id: 'x', kind: 'openai' }, f), /key/)
  assert.throws(() => addProvider({ id: 'x', kind: 'nope', apiKey: 'k' }, f), /Unknown/)
  assert.throws(() => addProvider({ id: 'x', kind: 'openai', apiKey: 'k', baseUrl: 'ftp://x' }, f), /http/)
  addProvider({ id: 'local', kind: 'ollama' }, f)
})

test('detects providers from env without duplicating stored kinds', () => {
  const f = tmp()
  const env = { OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'x' }
  assert.equal(loadProviders(env, f).length, 2)
  addProvider({ id: 'mine', kind: 'openai', apiKey: 'k' }, f)
  assert.deepEqual(loadProviders(env, f).map((p) => p.id).sort(), ['env-anthropic', 'mine'])
  assert.ok(fs.statSync(f).mode & 0o600)
})

import { summarizeSessions } from '../src/ui.ts'
test('summarizeSessions groups by session and aggregates tokens/agents', () => {
  const ev = (id: string, at: string, over = {}) => ({ sentAt: at, event: { source: 'claude_code', external_id: id + at, occurred_at: at, session_id: id, model: 'm', project: '/p', is_subagent: false, input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_creation_tokens: 0, thinking_tokens: 0, ...over } })
  const r = summarizeSessions([ev('a', '2026-01-01T00:00:01Z'), ev('a', '2026-01-01T00:00:02Z', { is_subagent: true, agent_name: 'Explore', tools: ['Read'] }), ev('b', '2026-01-01T00:00:09Z')] as any)
  assert.deepEqual(r.map((s) => s.id), ['b', 'a'])
  assert.equal(r[1].turns, 2); assert.equal(r[1].subagentTurns, 1); assert.deepEqual(r[1].agents, ['Explore']); assert.equal(r[1].output, 4)
})
