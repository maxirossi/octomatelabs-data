import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HOME_DIR, loadConfig, loadProfiles, saveProfiles, statePathFor, validProfileName } from './config.ts'
import type { Profile } from './config.ts'
import { ping } from './sender.ts'

/** Dónde queda el comando `claude-<nombre>`. */
export function launcherPath(name: string): string {
  if (process.platform === 'win32') return path.join(HOME_DIR, 'bin', `claude-${name}.cmd`)
  return path.join(os.homedir(), '.local', 'bin', `claude-${name}`)
}

function writeLauncher(p: Profile): string {
  const file = launcherPath(p.name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (process.platform === 'win32') {
    fs.writeFileSync(file, `@echo off\r\nset CLAUDE_CONFIG_DIR=${p.configDir}\r\nclaude %*\r\n`)
  } else {
    fs.writeFileSync(file, `#!/usr/bin/env sh\n# OctoMateLabs: Claude Code con la cuenta "${p.name}" (carpeta propia, sin mezclar con las otras)\nCLAUDE_CONFIG_DIR="${p.configDir}" exec claude "$@"\n`, { mode: 0o755 })
    fs.chmodSync(file, 0o755)
  }
  return file
}

export interface AddResult { profile: Profile; command: string; label: string | null; onPath: boolean }

/**
 * Agrega una cuenta: valida la key contra el servidor, crea su carpeta de Claude Code y un comando
 * `claude-<nombre>` para usarla. El usuario solo hace /login una vez con esa cuenta.
 */
export async function addProfile(name: string, key: string): Promise<AddResult> {
  name = name.trim().toLowerCase(); key = key.trim()
  if (!validProfileName(name)) throw new Error('Nombre inválido: usá letras, números, - o _ (máx. 31) y que no sea "default"')
  if (!key.startsWith('omk_')) throw new Error('La key tiene que empezar con omk_')
  const cfg = loadConfig()
  const profiles = loadProfiles()
  if (profiles.some((p) => p.name === name)) throw new Error(`Ya existe la cuenta "${name}"`)
  if (cfg.key === key || profiles.some((p) => p.key === key)) throw new Error('Esa key ya está en uso por otra cuenta: generá una key nueva para cada cuenta (si no, se ven juntas en el sitio)')
  const r = await ping(cfg.url, key)
  if (!r.ok) throw new Error(`No se pudo validar la key (${r.status || 'sin conexión'}${r.error ? ': ' + r.error : ''})`)
  const profile: Profile = { name, key, configDir: path.join(os.homedir(), `.claude-${name}`) }
  fs.mkdirSync(path.join(profile.configDir, 'projects'), { recursive: true })
  saveProfiles([...profiles, profile])
  const command = writeLauncher(profile)
  const dir = path.dirname(command)
  const onPath = (process.env.PATH ?? '').split(path.delimiter).includes(dir)
  return { profile, command, label: r.label ?? null, onPath }
}

/** Quita la cuenta del recolector. No borra la carpeta de Claude Code (tiene sus sesiones y su login). */
export function removeProfile(name: string): void {
  const profiles = loadProfiles()
  if (!profiles.some((p) => p.name === name)) throw new Error(`No existe la cuenta "${name}"`)
  saveProfiles(profiles.filter((p) => p.name !== name))
  fs.rmSync(launcherPath(name), { force: true })
  fs.rmSync(statePathFor(name), { force: true })
}
