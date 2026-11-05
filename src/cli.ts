import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { execFile } from 'node:child_process'
import { addProfile, checkKeyEmail, mismatchReason, removeProfile, validEmail } from './accounts.ts'
import { ENV_PATH, HOME_DIR, PAUSE_PATH, STATE_PATH, loadConfig, loadProfiles, requireKey, syncTargets } from './config.ts'
import { appendSent } from './sentlog.ts'
import { startUi } from './ui.ts'
import { AuthError, ping } from './sender.ts'
import { installService, uninstallService } from './service.ts'
import { loadState } from './state.ts'
import { syncOnce } from './sync.ts'

const HELP = `octomate-data — envía tu uso de Claude Code a OctoMateLabs

Uso:
  octomate-data init                 Pide la URL y la key, prueba la conexión y las guarda
  octomate-data run                  Corre en primer plano y sincroniza cada N segundos
  octomate-data once                 Un solo ciclo de sincronización
  octomate-data backfill [--days N]  Importa el histórico (default 30 días)
  octomate-data preview [--days N]   Muestra el JSON exacto que se enviaría (ya sanitizado), sin enviar nada
  octomate-data setup                Asistente visual: abre el navegador, pide la key e instala el servicio
  octomate-data ui [--port N]        Panel local (127.0.0.1:4567): estado, pausa, modo y lo enviado
  octomate-data account add <nombre> <email> <key>   Agrega otra cuenta de Claude Code (crea el comando claude-<nombre>)
  octomate-data account list | remove <nombre>
  octomate-data status               Muestra configuración y estado
  octomate-data ping                 Prueba la conexión con la key
  octomate-data install-service      Lo deja corriendo en segundo plano al iniciar sesión
  octomate-data uninstall-service

Config: ${ENV_PATH}  (OCTOMATELABS_URL, OCTOMATELABS_KEY, METADATA_ONLY, SYNC_INTERVAL_SECONDS)`

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`)

async function init() {
  const cfg = loadConfig()
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const url = (await rl.question(`URL de la API [${cfg.url}]: `)).trim() || cfg.url
    const email = ((await rl.question(`Email de tu cuenta de Claude Code [${cfg.accountEmail}]: `)).trim() || cfg.accountEmail).toLowerCase()
    if (!validEmail(email)) throw new Error('Email inválido')
    const key = (await rl.question('Key (omk_..., generada para ese email en "Mi consumo"): ')).trim() || cfg.key
    const r = await checkKeyEmail(url.replace(/\/+$/, ''), key, email)
    fs.mkdirSync(HOME_DIR, { recursive: true })
    fs.writeFileSync(ENV_PATH, `OCTOMATELABS_URL=${url}\nOCTOMATELABS_KEY=${key}\nACCOUNT_EMAIL=${email}\n`, { mode: 0o600 })
    console.log(`✔ Conectado${r.label ? ` (key "${r.label}")` : ''} como ${email}. Guardado en ${ENV_PATH}`)
    console.log('Siguiente paso: "octomate-data install-service" para que corra solo, o "octomate-data run".')
  } finally { rl.close() }
}

async function run() {
  let cfg = loadConfig()
  requireKey(cfg)
  log(`Sincronizando ${cfg.claudeDir}${cfg.copilotDir ? ' + ' + cfg.copilotDir : ''} → ${cfg.url} cada ${cfg.intervalSeconds}s${cfg.metadataOnly ? ' (solo métricas)' : ''}`)
  // Panel local siempre disponible mientras el servicio corre (http://localhost:4567)
  startUi(4567, { fixedPort: true }).then((r) => log(`Panel en http://localhost:${r.port}`)).catch((e) => log(`panel no disponible: ${(e as Error).message}`))
  const warned = new Map<string, string>()
  let stop = false
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stop = true; process.exit(0) })
  while (!stop) {
    try {
      cfg = loadConfig() // permite cambiar la config sin reiniciar
      if (fs.existsSync(PAUSE_PATH)) { await new Promise((r) => setTimeout(r, cfg.intervalSeconds * 1000)); continue }
      for (const t of syncTargets(cfg)) { // un error en una cuenta no frena a las demás
        try {
          const why = mismatchReason(t)
          if (why) { if (warned.get(t.name) !== why) { log(`[${t.name}] ${why}`); warned.set(t.name, why) } continue }
          warned.delete(t.name)
          const s = await syncOnce(t.cfg, t.statePath, { onEvents: (e, sent) => { if (sent) appendSent(e) } })
          if (s.events) log(`[${t.name}] ${s.inserted} nuevos, ${s.duplicates} duplicados${s.dropped ? `, ${s.dropped} descartados` : ''}`)
        } catch (e) {
          log(`[${t.name}] error: ${(e as Error).message}${e instanceof AuthError ? ' (se reintenta igual)' : ''}`)
        }
      }
    } catch (e) {
      log(`error: ${(e as Error).message}${e instanceof AuthError ? ' (se reintenta igual)' : ''}`)
    }
    await new Promise((r) => setTimeout(r, cfg.intervalSeconds * 1000))
  }
}

function openBrowser(url: string) {
  const [cmd, args]: [string, string[]] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  execFile(cmd, args, () => { /* sin navegador: ya se imprimió el link */ }).unref()
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  switch (cmd) {
    case 'init': return init()
    case 'run': return run()
    case 'once': {
      const cfg = loadConfig(); requireKey(cfg)
      for (const t of syncTargets(cfg)) {
        const why = mismatchReason(t); if (why) { console.log(`[${t.name}] omitida: ${why}`); continue }
        console.log(t.name, await syncOnce(t.cfg, t.statePath, { settleMs: 0, onEvents: (e, sent) => { if (sent) appendSent(e) } }))
      }
      return
    }
    case 'backfill': {
      const cfg = loadConfig(); requireKey(cfg)
      const i = args.indexOf('--days')
      const days = i >= 0 ? Number(args[i + 1]) : 30
      if (!Number.isFinite(days) || days <= 0) throw new Error('--days debe ser un número positivo')
      const since = new Date(Date.now() - days * 86_400_000)
      console.log(`Importando los últimos ${days} días…`)
      const only = args.indexOf('--account') >= 0 ? args[args.indexOf('--account') + 1] : null
      const targets = syncTargets(cfg).filter((t) => !only || t.name === only)
      if (!targets.length) throw new Error(only ? `No existe la cuenta "${only}"` : 'No hay cuentas configuradas')
      for (const t of targets) {
        const why = mismatchReason(t); if (why) { console.log(`[${t.name}] omitida: ${why}`); continue }
        console.log(t.name, await syncOnce(t.cfg, t.statePath, { backfill: true, since, settleMs: 0, onEvents: (e, sent) => { if (sent) appendSent(e) } }))
      }
      return
    }
    case 'preview': {
      const cfg = loadConfig()
      const i = args.indexOf('--days')
      const days = i >= 0 ? Number(args[i + 1]) : undefined
      if (days !== undefined && (!Number.isFinite(days) || days <= 0)) throw new Error('--days debe ser un número positivo')
      const events: unknown[] = []
      let total = 0
      for (const t of syncTargets(cfg)) {
        const stats = await syncOnce(t.cfg, t.statePath, {
          dryRun: true, settleMs: 0, onEvents: (e) => events.push(...e),
          ...(days ? { backfill: true, since: new Date(Date.now() - days * 86_400_000) } : {}),
        })
        total += stats.events
      }
      for (const e of events) console.log(JSON.stringify(e, null, 2))
      console.error(`${total} evento(s) se enviarían${cfg.metadataOnly ? ' (solo métricas)' : ''}. No se envió nada.`); return
    }
    case 'ui': {
      const i = args.indexOf('--port')
      const port = i >= 0 ? Number(args[i + 1]) : 4567
      const r = await startUi(port)
      console.log(`Panel en http://localhost:${r.port} (Ctrl+C para cerrar)`)
      if (!args.includes('--no-open')) openBrowser(`http://localhost:${r.port}`); return
    }
    case 'setup': {
      // Asistente visual: abre el navegador, pide la key, la valida, instala el servicio y termina.
      const r = await startUi(4590, { setup: { onDone: () => { console.log('Listo. octomate-data quedó corriendo en segundo plano.'); process.exit(0) } } })
      const u = `http://localhost:${r.port}`
      console.log(`Abriendo ${u} para configurar la key… (si no se abre solo, copiá ese link en el navegador)`)
      openBrowser(u); return
    }
    case 'account': {
      const [sub, name, email, key] = args
      if (sub === 'add') {
        if (!name || !email || !key) throw new Error('Uso: octomate-data account add <nombre> <email de la cuenta de Claude> <key omk_...>')
        const r = await addProfile(name, email, key)
        console.log(`✔ Cuenta "${r.profile.name}" (${r.profile.email}) agregada${r.label ? ` (key "${r.label}")` : ''}.`)
        console.log(`  Para usarla, abrí Claude Code con:  ${path.basename(r.command)}   (la primera vez hacé /login con esa cuenta)`)
        if (!r.onPath) console.log(`  Agregá ${path.dirname(r.command)} a tu PATH para que el comando funcione.`)
        console.log('  El servicio la toma en el próximo ciclo (≤ 30 s).'); return
      }
      if (sub === 'remove') { if (!name) throw new Error('Uso: octomate-data account remove <nombre>'); removeProfile(name); console.log(`✔ Cuenta "${name}" quitada (la carpeta de Claude Code no se borra).`); return }
      if (sub === 'list' || !sub) {
        console.log(`default  →  ~/.claude  ${loadConfig().accountEmail || '(sin email configurado)'}`)
        for (const p of loadProfiles()) console.log(`${p.name}  →  ${p.configDir}  ${p.email}  (comando: claude-${p.name})`)
        return
      }
      throw new Error('Uso: octomate-data account add|list|remove')
    }
    case 'status': {
      const cfg = loadConfig(); const st = loadState(STATE_PATH)
      console.log({ url: cfg.url, key: cfg.key ? cfg.key.slice(0, 12) + '…' : '(falta)', metadataOnly: cfg.metadataOnly,
        claudeDir: cfg.claudeDir, cuentasExtra: loadProfiles().map((p) => p.name), copilotDir: cfg.copilotDir, archivosSeguidos: Object.keys(st.files).length, inicializado: st.initializedAt ?? null }); return
    }
    case 'ping': {
      const cfg = loadConfig(); requireKey(cfg)
      const r = await ping(cfg.url, cfg.key); console.log(r); process.exit(r.ok ? 0 : 1)
    }
    // eslint-disable-next-line no-fallthrough
    case 'install-service': console.log(installService()); return
    case 'uninstall-service': console.log(uninstallService()); return
    default: console.log(HELP)
  }
}

main().catch((e) => { console.error(`Error: ${(e as Error).message}`); process.exit(1) })
