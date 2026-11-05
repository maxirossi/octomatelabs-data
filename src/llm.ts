import fs from 'node:fs'
import path from 'node:path'
import { HOME_DIR } from './config.ts'

// Local LLM wrapper: lets the panel chat with any provider the user configured.
// Nothing here is sent to OctoMateLabs; requests go straight from this machine to the provider.

export const LLM_PATH = path.join(HOME_DIR, 'llm.json')

export type ProviderKind = 'anthropic' | 'openai' | 'gemini' | 'ollama'
export const PROVIDER_KINDS: ProviderKind[] = ['anthropic', 'openai', 'gemini', 'ollama']

export interface Provider {
  id: string
  kind: ProviderKind
  label: string
  apiKey: string
  /** Empty = the provider's default URL. Use it for OpenAI-compatible servers (OpenRouter, LM Studio, vLLM...). */
  baseUrl: string
  /** True when it comes from an environment variable (read-only in the UI). */
  fromEnv?: boolean
}

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface ChatResult { text: string; inputTokens: number; outputTokens: number; ms: number }

const DEFAULT_URL: Record<ProviderKind, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  ollama: 'http://localhost:11434',
}

const FALLBACK_MODELS: Record<ProviderKind, string[]> = {
  anthropic: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  openai: ['gpt-4o', 'gpt-4o-mini'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  ollama: [],
}

export const validProviderId = (n: string) => /^[a-z0-9][a-z0-9_-]{0,30}$/i.test(n)

function loadStored(file = LLM_PATH): Provider[] {
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(arr)) return []
    return arr.filter((p) => p && validProviderId(String(p.id)) && PROVIDER_KINDS.includes(p.kind))
      .map((p) => ({ id: String(p.id), kind: p.kind as ProviderKind, label: String(p.label || p.id), apiKey: String(p.apiKey ?? ''), baseUrl: String(p.baseUrl ?? '').replace(/\/+$/, '') }))
  } catch { return [] }
}

function saveStored(list: Provider[], file = LLM_PATH): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(list.map(({ fromEnv: _f, ...p }) => p), null, 2) + '\n', { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* Windows */ }
}

/** Providers from llm.json plus the ones detected from standard environment variables. */
export function loadProviders(env: NodeJS.ProcessEnv = process.env, file = LLM_PATH): Provider[] {
  const stored = loadStored(file)
  const out = [...stored]
  const fromEnv: Array<[string, ProviderKind, string]> = [
    ['ANTHROPIC_API_KEY', 'anthropic', 'Anthropic'], ['OPENAI_API_KEY', 'openai', 'OpenAI'],
    ['GEMINI_API_KEY', 'gemini', 'Gemini'], ['GOOGLE_API_KEY', 'gemini', 'Gemini'],
  ]
  for (const [v, kind, label] of fromEnv) {
    const apiKey = env[v]?.trim()
    if (apiKey && !out.some((p) => p.kind === kind)) out.push({ id: `env-${kind}`, kind, label: `${label} (${v})`, apiKey, baseUrl: '', fromEnv: true })
  }
  return out
}

export function addProvider(p: { id: string; kind: string; label?: string; apiKey?: string; baseUrl?: string }, file = LLM_PATH): Provider {
  const id = p.id.trim()
  if (!validProviderId(id)) throw new Error('Invalid id: letters, numbers, - and _ only (max 31 chars)')
  if (!PROVIDER_KINDS.includes(p.kind as ProviderKind)) throw new Error('Unknown provider type')
  const kind = p.kind as ProviderKind
  const apiKey = (p.apiKey ?? '').trim()
  if (kind !== 'ollama' && !apiKey) throw new Error('The API key is required')
  const baseUrl = (p.baseUrl ?? '').trim().replace(/\/+$/, '')
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('The URL must start with http:// or https://')
  const list = loadStored(file)
  if (list.some((x) => x.id === id)) throw new Error(`There is already a provider called "${id}"`)
  const prov: Provider = { id, kind, label: (p.label ?? '').trim() || id, apiKey, baseUrl }
  saveStored([...list, prov], file)
  return prov
}

export function removeProvider(id: string, file = LLM_PATH): void {
  const list = loadStored(file)
  if (!list.some((x) => x.id === id)) throw new Error('Provider not found')
  saveStored(list.filter((x) => x.id !== id), file)
}

const base = (p: Provider) => p.baseUrl || DEFAULT_URL[p.kind]

async function http(url: string, init: RequestInit): Promise<any> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) })
  const text = await r.text()
  let body: any
  try { body = JSON.parse(text) } catch { body = null }
  if (!r.ok) {
    const msg = body?.error?.message ?? body?.error ?? body?.message ?? text.slice(0, 200)
    throw new Error(`${r.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`)
  }
  return body
}

export async function listModels(p: Provider): Promise<string[]> {
  try {
    if (p.kind === 'anthropic') {
      const b = await http(`${base(p)}/v1/models?limit=100`, { headers: { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' } })
      return (b.data ?? []).map((m: any) => String(m.id))
    }
    if (p.kind === 'openai') {
      const b = await http(`${base(p)}/models`, { headers: { authorization: `Bearer ${p.apiKey}` } })
      return (b.data ?? []).map((m: any) => String(m.id)).sort()
    }
    if (p.kind === 'gemini') {
      const b = await http(`${base(p)}/models?pageSize=100`, { headers: { 'x-goog-api-key': p.apiKey } })
      return (b.models ?? []).filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent')).map((m: any) => String(m.name).replace(/^models\//, ''))
    }
    const b = await http(`${base(p)}/api/tags`, {})
    return (b.models ?? []).map((m: any) => String(m.name))
  } catch (e) {
    const fb = FALLBACK_MODELS[p.kind]
    if (fb.length) return fb
    throw e
  }
}

export async function chat(p: Provider, model: string, messages: ChatMessage[]): Promise<ChatResult> {
  if (!model) throw new Error('Pick a model')
  if (!messages.length) throw new Error('Empty message')
  const t0 = Date.now()
  const done = (text: string, i: number, o: number): ChatResult => ({ text, inputTokens: i || 0, outputTokens: o || 0, ms: Date.now() - t0 })
  const json = { 'content-type': 'application/json' }

  if (p.kind === 'anthropic') {
    const b = await http(`${base(p)}/v1/messages`, { method: 'POST', headers: { ...json, 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model, max_tokens: 4096, messages }) })
    return done((b.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join(''), b.usage?.input_tokens, b.usage?.output_tokens)
  }
  if (p.kind === 'openai') {
    const b = await http(`${base(p)}/chat/completions`, { method: 'POST', headers: { ...json, authorization: `Bearer ${p.apiKey}` }, body: JSON.stringify({ model, messages }) })
    return done(b.choices?.[0]?.message?.content ?? '', b.usage?.prompt_tokens, b.usage?.completion_tokens)
  }
  if (p.kind === 'gemini') {
    const contents = messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
    const b = await http(`${base(p)}/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { ...json, 'x-goog-api-key': p.apiKey }, body: JSON.stringify({ contents }) })
    const text = (b.candidates?.[0]?.content?.parts ?? []).map((x: any) => x.text ?? '').join('')
    return done(text, b.usageMetadata?.promptTokenCount, b.usageMetadata?.candidatesTokenCount)
  }
  const b = await http(`${base(p)}/api/chat`, { method: 'POST', headers: json, body: JSON.stringify({ model, messages, stream: false }) })
  return done(b.message?.content ?? '', b.prompt_eval_count, b.eval_count)
}
