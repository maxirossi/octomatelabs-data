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
  /** Email de la cuenta de Claude Code de esta key (la del .env = cuenta principal). Vacío = sin verificar. */
  accountEmail: string
  metadataOnly: boolean
  /** "Cifrar información sensible": redacción estricta de claves/tokens/contraseñas en prompts y responses (default: activado). */
  strictRedact: boolean
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
    accountEmail: (get('ACCOUNT_EMAIL') ?? '').trim().toLowerCase(),
    metadataOnly: /^(1|true|yes)$/i.test(get('METADATA_ONLY') ?? ''),
    strictRedact: !/^(0|false|no)$/i.test(get('REDACT_STRICT') ?? ''),
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

// ── Cuentas adicionales (varias cuentas de Claude Code en la misma máquina) ─────────────────────
// La cuenta "default" sigue siendo la del .env (~/.claude). Las demás viven en profiles.json: cada una
// tiene su key (así se ven separadas en el sitio) y su propia carpeta de configuración de Claude Code
// (CLAUDE_CONFIG_DIR), que es lo que permite distinguir qué turno es de qué cuenta.
export const PROFILES_PATH = path.join(HOME_DIR, 'profiles.json')

export interface Profile {
  name: string
  key: string
  email: string
  /** Carpeta de configuración de Claude Code de esta cuenta (los transcripts están en <dir>/projects). */
  configDir: string
}

export const validProfileName = (n: string) => /^[a-z0-9][a-z0-9_-]{0,30}$/i.test(n) && n.toLowerCase() !== 'default'

export function loadProfiles(file = PROFILES_PATH): Profile[] {
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(arr)) return []
    return arr.filter((p) => p && validProfileName(String(p.name)) && String(p.key).startsWith('omk_') && p.configDir)
      .map((p) => ({ name: String(p.name), key: String(p.key), email: String(p.email ?? '').trim().toLowerCase(), configDir: expand(String(p.configDir)) }))
  } catch { return [] }
}

export function saveProfiles(profiles: Profile[], file = PROFILES_PATH): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(profiles, null, 2) + '\n', { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* Windows */ }
}

export const statePathFor = (name: string) => (name === 'default' ? STATE_PATH : path.join(HOME_DIR, `state-${name}.json`))

export interface SyncTarget {
  name: string; cfg: Config; statePath: string
  /** Email esperado de la sesión de Claude Code y archivo donde Claude Code guarda la sesión activa. */
  email: string; claudeJson: string
}

/** Cuenta por defecto + cuentas extra. Copilot (VS Code) no es por cuenta de Claude: solo va con la default. */
export function syncTargets(base: Config = loadConfig(), profiles: Profile[] = loadProfiles()): SyncTarget[] {
  const targets: SyncTarget[] = []
  if (base.key) targets.push({ name: 'default', cfg: base, statePath: STATE_PATH, email: base.accountEmail, claudeJson: path.join(os.homedir(), '.claude.json') })
  for (const p of profiles) {
    targets.push({ name: p.name, statePath: statePathFor(p.name), email: p.email, claudeJson: path.join(p.configDir, '.claude.json'),
      cfg: { ...base, key: p.key, accountEmail: p.email, claudeDir: path.join(p.configDir, 'projects'), copilotDir: null } })
  }
  return targets
}
