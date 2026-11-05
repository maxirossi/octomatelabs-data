import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { saveSettings, setEnvVars } from '../src/ui.ts'

const good = { key: 'omk_x', url: 'https://x.test/api', intervalSeconds: 30, claudeDir: os.tmpdir(), copilotEnabled: false, copilotDir: '', metadataOnly: false }
const errorsOf = async (over: object) => {
  const r = await saveSettings({ ...good, ...over })
  assert.equal(r.ok, false); return (r as { errors: Record<string, string> }).errors
}

// Todos estos casos fallan antes de tocar la red o el disco del usuario.
test('valida la carpeta de Claude, el intervalo, la URL y la key', async () => {
  assert.ok((await errorsOf({ claudeDir: '/no/existe/jamas' })).claudeDir)
  assert.ok((await errorsOf({ claudeDir: '' })).claudeDir)
  assert.ok((await errorsOf({ intervalSeconds: 2 })).intervalSeconds)
  assert.ok((await errorsOf({ intervalSeconds: 30.5 })).intervalSeconds)
  assert.ok((await errorsOf({ url: 'ftp://x' })).url)
  assert.ok((await errorsOf({ key: 'abc' })).key)
})

test('la carpeta de Copilot solo se valida si Copilot está activado', async () => {
  assert.ok((await errorsOf({ copilotEnabled: true, copilotDir: '/no/existe' })).copilotDir)
  assert.ok((await errorsOf({ copilotEnabled: true, copilotDir: '' })).copilotDir)
  const e = await errorsOf({ intervalSeconds: 1, copilotEnabled: false, copilotDir: '/no/existe' })
  assert.equal(e.copilotDir, undefined)
})

test('setEnvVars reemplaza las claves existentes y conserva el resto', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'omd-')), '.env')
  fs.writeFileSync(f, 'OCTOMATELABS_KEY=omk_old\nOTRA=1\nMETADATA_ONLY=true\n')
  setEnvVars({ OCTOMATELABS_KEY: 'omk_new', METADATA_ONLY: 'false' }, f)
  const t = fs.readFileSync(f, 'utf8')
  assert.ok(t.includes('OTRA=1') && t.includes('OCTOMATELABS_KEY=omk_new') && t.includes('METADATA_ONLY=false'))
  assert.ok(!t.includes('omk_old') && !t.includes('METADATA_ONLY=true'))
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600)
})
