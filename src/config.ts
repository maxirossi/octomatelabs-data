import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HOME_DIR = path.join(os.homedir(), '.octomatelabs')
export const ENV_PATH = path.join(HOME_DIR, '.env')
export const STATE_PATH = path.join(HOME_DIR, 'state.json')
export const SENT_LOG_PATH = path.join(HOME_DIR, 'sent.log')
export const PAUSE_PATH = path.join(HOME_DIR, 'paused')

export interface Config {
  url: string
  key: string
  metadataOnly: boolean
  intervalSeconds: number
  claudeDir: string
  /** null = Copilot desactivado (COPILOT_ENABLED=false). */
  copilotDir: string | null
}

export function defaultCopilotDir(): string {
  const h = os.homedir()
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage')
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(h, 'AppData', 'Roaming'), 'Code', 'User', 'workspaceStorage')
  return path.join(h, '.config', 'Code', 'User', 'workspaceStorage')
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i < 1) continue
    let v = line.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[line.slice(0, i).trim()] = v
  }
  return out
}

const expand = (p: string) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)

/** Prioridad: variables de entorno > ./.env > ~/.octomatelabs/.env */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const files = [ENV_PATH, path.join(cwd, '.env')]
  let merged: Record<string, string> = {}
  for (const f of files) {
    try { merged = { ...merged, ...parseEnv(fs.readFileSync(f, 'utf8')) } } catch { /* no existe */ }
  }
  const get = (k: string) => env[k] ?? merged[k]
  const url = (get('OCTOMATELABS_URL') ?? 'https://app.octomatelabs.site/api').replace(/\/+$/, '')
  const key = get('OCTOMATELABS_KEY') ?? ''
  return {
    url,
    key,
    metadataOnly: /^(1|true|yes)$/i.test(get('METADATA_ONLY') ?? ''),
    intervalSeconds: Math.max(5, Number(get('SYNC_INTERVAL_SECONDS')) || 30),
    claudeDir: expand(get('CLAUDE_PROJECTS_DIR') ?? '~/.claude/projects'),
    copilotDir: /^(0|false|no)$/i.test(get('COPILOT_ENABLED') ?? '') ? null : expand(get('COPILOT_STORAGE_DIR') ?? defaultCopilotDir()),
  }
}

export function requireKey(c: Config): void {
  if (!c.key.startsWith('omk_')) {
    throw new Error(`Falta OCTOMATELABS_KEY (formato omk_...). Corré "octomate-data init" o editá ${ENV_PATH}`)
  }
}
