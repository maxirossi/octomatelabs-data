import fs from 'node:fs'
import readline from 'node:readline/promises'
import { execFile } from 'node:child_process'
import { ENV_PATH, HOME_DIR, PAUSE_PATH, STATE_PATH, loadConfig, requireKey } from './config.ts'
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
    const key = (await rl.question('Key (omk_...): ')).trim() || cfg.key
    const r = await ping(url.replace(/\/+$/, ''), key)
    if (!r.ok) throw new Error(`No se pudo validar la key (${r.status || 'sin conexión'}${r.error ? ': ' + r.error : ''})`)
    fs.mkdirSync(HOME_DIR, { recursive: true })
    fs.writeFileSync(ENV_PATH, `OCTOMATELABS_URL=${url}\nOCTOMATELABS_KEY=${key}\n`, { mode: 0o600 })
    console.log(`✔ Conectado${r.label ? ` (key "${r.label}")` : ''}. Guardado en ${ENV_PATH}`)
    console.log('Siguiente paso: "octomate-data install-service" para que corra solo, o "octomate-data run".')
  } finally { rl.close() }
}

async function run() {
  let cfg = loadConfig()
  requireKey(cfg)
  log(`Sincronizando ${cfg.claudeDir}${cfg.copilotDir ? ' + ' + cfg.copilotDir : ''} → ${cfg.url} cada ${cfg.intervalSeconds}s${cfg.metadataOnly ? ' (solo métricas)' : ''}`)
  let stop = false
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stop = true; process.exit(0) })
  while (!stop) {
    try {
      cfg = loadConfig() // permite cambiar la config sin reiniciar
      if (fs.existsSync(PAUSE_PATH)) { await new Promise((r) => setTimeout(r, cfg.intervalSeconds * 1000)); continue }
      const s = await syncOnce(cfg, STATE_PATH, { onEvents: (e, sent) => { if (sent) appendSent(e) } })
      if (s.events) log(`${s.inserted} nuevos, ${s.duplicates} duplicados${s.dropped ? `, ${s.dropped} descartados` : ''}`)
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
      console.log(await syncOnce(cfg, STATE_PATH, { settleMs: 0, onEvents: (e, sent) => { if (sent) appendSent(e) } })); return
    }
    case 'backfill': {
      const cfg = loadConfig(); requireKey(cfg)
      const i = args.indexOf('--days')
      const days = i >= 0 ? Number(args[i + 1]) : 30
      if (!Number.isFinite(days) || days <= 0) throw new Error('--days debe ser un número positivo')
      const since = new Date(Date.now() - days * 86_400_000)
      console.log(`Importando los últimos ${days} días…`)
      console.log(await syncOnce(cfg, STATE_PATH, { backfill: true, since, settleMs: 0, onEvents: (e, sent) => { if (sent) appendSent(e) } })); return
    }
    case 'preview': {
      const cfg = loadConfig()
      const i = args.indexOf('--days')
      const days = i >= 0 ? Number(args[i + 1]) : undefined
      if (days !== undefined && (!Number.isFinite(days) || days <= 0)) throw new Error('--days debe ser un número positivo')
      const events: unknown[] = []
      const stats = await syncOnce(cfg, STATE_PATH, {
        dryRun: true, settleMs: 0, onEvents: (e) => events.push(...e),
        ...(days ? { backfill: true, since: new Date(Date.now() - days * 86_400_000) } : {}),
      })
      for (const e of events) console.log(JSON.stringify(e, null, 2))
      console.error(`${stats.events} evento(s) se enviarían${cfg.metadataOnly ? ' (solo métricas)' : ''}. No se envió nada.`); return
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
      const r = await startUi(4567, { setup: { onDone: () => { console.log('Listo. octomate-data quedó corriendo en segundo plano.'); process.exit(0) } } })
      const u = `http://localhost:${r.port}`
      console.log(`Abriendo ${u} para configurar la key… (si no se abre solo, copiá ese link en el navegador)`)
      openBrowser(u); return
    }
    case 'status': {
      const cfg = loadConfig(); const st = loadState(STATE_PATH)
      console.log({ url: cfg.url, key: cfg.key ? cfg.key.slice(0, 12) + '…' : '(falta)', metadataOnly: cfg.metadataOnly,
        claudeDir: cfg.claudeDir, copilotDir: cfg.copilotDir, archivosSeguidos: Object.keys(st.files).length, inicializado: st.initializedAt ?? null }); return
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
