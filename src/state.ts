import fs from 'node:fs'
import path from 'node:path'
import type { State } from './types.ts'

export function loadState(file: string): State {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (s && typeof s.files === 'object') return s as State
  } catch { /* primera vez o archivo corrupto */ }
  return { files: {} }
}

export function saveState(file: string, state: State): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, file) // atómico: nunca queda un state a medio escribir
}
