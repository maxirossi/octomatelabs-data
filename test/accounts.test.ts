import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loggedInEmail, mismatchReason, validEmail } from '../src/accounts.ts'
import type { SyncTarget } from '../src/config.ts'

const target = (email: string, claudeJson: string): SyncTarget =>
  ({ name: 't', email, claudeJson, statePath: '', cfg: {} as never })

test('no mezcla cuentas: solo sincroniza si la sesión de Claude Code coincide con el email de la key', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-acc-'))
  const f = path.join(d, '.claude.json')
  assert.match(mismatchReason(target('work@x.com', f))!, /todavía no hay sesión/)   // sin login
  fs.writeFileSync(f, JSON.stringify({ oauthAccount: { emailAddress: 'Personal@Gmail.com' } }))
  assert.equal(loggedInEmail(f), 'personal@gmail.com')
  assert.match(mismatchReason(target('work@x.com', f))!, /personal@gmail.com.*work@x.com/)  // cuenta equivocada
  assert.equal(mismatchReason(target('personal@gmail.com', f)), null)
  assert.equal(mismatchReason(target('', f)), null)  // instalación vieja sin email: no se verifica
})

test('validEmail', () => {
  assert.ok(validEmail('a@b.com')); assert.ok(!validEmail('a@b')); assert.ok(!validEmail('a b@c.com'))
})
