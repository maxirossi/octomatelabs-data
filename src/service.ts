import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NAME = 'octomatelabs-data'

/** Comando que el servicio ejecuta: el binario compilado, o node + script si corre con Node. */
function runCommand(): string[] {
  const exe = process.execPath
  const script = process.argv[1]
  const isNode = /(^|[\\/])node(\.exe)?$/i.test(exe)
  return isNode ? [exe, script, 'run'] : [exe, 'run']
}

const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`

export function installService(): string {
  const cmd = runCommand()
  const home = os.homedir()
  if (process.platform === 'linux') {
    const dir = path.join(home, '.config', 'systemd', 'user')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${NAME}.service`),
      `[Unit]\nDescription=OctoMateLabs data collector\nAfter=network-online.target\n\n[Service]\nExecStart=${cmd.map(q).join(' ')}\nRestart=always\nRestartSec=15\n\n[Install]\nWantedBy=default.target\n`)
    execFileSync('systemctl', ['--user', 'daemon-reload'])
    execFileSync('systemctl', ['--user', 'enable', '--now', `${NAME}.service`])
    return 'Servicio systemd de usuario activo (systemctl --user status octomatelabs-data)'
  }
  if (process.platform === 'darwin') {
    const plist = path.join(home, 'Library', 'LaunchAgents', `site.octomatelabs.data.plist`)
    fs.mkdirSync(path.dirname(plist), { recursive: true })
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>site.octomatelabs.data</string>
<key>ProgramArguments</key><array>${cmd.map((c) => `<string>${c}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardErrorPath</key><string>${path.join(home, '.octomatelabs', 'service.log')}</string>
</dict></plist>\n`)
    try { execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' }) } catch { /* no estaba cargado */ }
    execFileSync('launchctl', ['load', plist])
    return 'LaunchAgent cargado (arranca al iniciar sesión)'
  }
  if (process.platform === 'win32') {
    execFileSync('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', NAME, '/TR', cmd.map(q).join(' ')])
    execFileSync('schtasks', ['/Run', '/TN', NAME])
    return 'Tarea programada creada (arranca al iniciar sesión)'
  }
  throw new Error(`Sistema no soportado: ${process.platform}`)
}

export function uninstallService(): string {
  const home = os.homedir()
  if (process.platform === 'linux') {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', `${NAME}.service`]) } catch { /* no estaba */ }
    fs.rmSync(path.join(home, '.config', 'systemd', 'user', `${NAME}.service`), { force: true })
  } else if (process.platform === 'darwin') {
    const plist = path.join(home, 'Library', 'LaunchAgents', 'site.octomatelabs.data.plist')
    try { execFileSync('launchctl', ['unload', plist]) } catch { /* no estaba */ }
    fs.rmSync(plist, { force: true })
  } else if (process.platform === 'win32') {
    try { execFileSync('schtasks', ['/Delete', '/F', '/TN', NAME]) } catch { /* no estaba */ }
  }
  return 'Servicio desinstalado'
}
