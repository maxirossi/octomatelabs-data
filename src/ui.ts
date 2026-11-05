import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { addProfile, checkKeyEmail, launcherPath, loggedInEmail, removeProfile, validEmail } from './accounts.ts'
import { ENV_PATH, HOME_DIR, PAUSE_PATH, STATE_PATH, loadConfig, loadProfiles, syncTargets } from './config.ts'
import { LOGO_DATA_URI } from './logo.ts'
import { ping } from './sender.ts'
import { tailSent } from './sentlog.ts'
import type { SentEntry } from './sentlog.ts'
import { PROVIDER_KINDS, addProvider, chat, listModels, loadProviders, removeProvider } from './llm.ts'
import { installService } from './service.ts'
import { loadState } from './state.ts'
import { syncOnce } from './sync.ts'
import type { UsageEvent } from './types.ts'

/** Actualiza varias variables del ~/.octomatelabs/.env conservando el resto. */
export function setEnvVars(vars: Record<string, string>, file = ENV_PATH): void {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { /* nuevo */ }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !Object.keys(vars).some((k) => l.startsWith(k + '=')))
  for (const [k, v] of Object.entries(vars)) lines.push(`${k}=${v}`)
  fs.mkdirSync(HOME_DIR, { recursive: true })
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* Windows */ } // el modo solo aplica al crear: forzarlo si el .env ya existía
}

function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory() } catch { return false } }
const expandHome = (p: string) => (p.startsWith('~') ? p.replace('~', process.env.HOME ?? process.env.USERPROFILE ?? '~') : p)

function status() {
  const cfg = loadConfig(); const st = loadState(STATE_PATH)
  return {
    url: cfg.url, accountEmail: cfg.accountEmail, loggedEmail: loggedInEmail(path.join(os.homedir(), '.claude.json')), hasKey: !!cfg.key, keyPreview: cfg.key ? cfg.key.slice(0, 12) + '…' : null, metadataOnly: cfg.metadataOnly, strictRedact: cfg.strictRedact,
    paused: fs.existsSync(PAUSE_PATH), intervalSeconds: cfg.intervalSeconds, claudeDir: cfg.claudeDir,
    copilotEnabled: cfg.copilotDir !== null,
    copilotDir: cfg.copilotDir ?? loadConfig({ ...process.env, COPILOT_ENABLED: 'true' }).copilotDir,
    trackedFiles: Object.keys(st.files).length, initializedAt: st.initializedAt ?? null,
  }
}

export type FieldErrors = Record<string, string>

/** Valida y guarda la configuración. Devuelve errores por campo (sin guardar nada) o { ok, label }. */
export async function saveSettings(b: Record<string, unknown>): Promise<{ ok: true; label: string | null } | { ok: false; errors: FieldErrors }> {
  const cur = loadConfig()
  const errors: FieldErrors = {}
  const url = cur.url // la URL de la API no es editable desde la UI
  const key = String(b.key ?? '').trim() || cur.key
  const accountEmail = String(b.accountEmail ?? '').trim().toLowerCase()
  const interval = Number(b.intervalSeconds)
  const claudeDir = expandHome(String(b.claudeDir ?? '').trim())
  const copilotEnabled = b.copilotEnabled === true
  const strictRedact = b.strictRedact !== false
  const copilotDir = expandHome(String(b.copilotDir ?? '').trim())

  if (!key) errors.key = 'Falta la key'
  else if (!key.startsWith('omk_')) errors.key = 'La key tiene que empezar con omk_'
  if (!accountEmail) errors.accountEmail = 'Indicá el email de tu cuenta de Claude Code'
  else if (!validEmail(accountEmail)) errors.accountEmail = 'Email inválido'
  if (!Number.isInteger(interval) || interval < 5 || interval > 3600) errors.intervalSeconds = 'Un número entero entre 5 y 3600 segundos'
  if (!claudeDir) errors.claudeDir = 'Indicá la carpeta de proyectos de Claude Code'
  else if (!isDir(claudeDir)) errors.claudeDir = 'Esa carpeta no existe (¿usás Claude Code en esta máquina?)'
  if (copilotEnabled) {
    if (!copilotDir) errors.copilotDir = 'Indicá la carpeta de workspaceStorage de VS Code'
    else if (!isDir(copilotDir)) errors.copilotDir = 'Esa carpeta no existe'
  }
  if (Object.keys(errors).length) return { ok: false, errors }

  // La key solo se prueba contra el servidor si cambió algo de la conexión.
  let label: string | null = null
  if (key !== cur.key || url !== cur.url || accountEmail !== cur.accountEmail) {
    try { label = (await checkKeyEmail(url, key, accountEmail)).label } catch (e) { return { ok: false, errors: { key: (e as Error).message } } }
  }
  setEnvVars({
    OCTOMATELABS_URL: url, OCTOMATELABS_KEY: key, ACCOUNT_EMAIL: accountEmail, SYNC_INTERVAL_SECONDS: String(interval), CLAUDE_PROJECTS_DIR: claudeDir,
    COPILOT_ENABLED: String(copilotEnabled), REDACT_STRICT: String(strictRedact), ...(copilotDir ? { COPILOT_STORAGE_DIR: copilotDir } : {}),
  })
  return { ok: true, label }
}

async function preview(): Promise<{ count: number; events: UsageEvent[] }> {
  const events: UsageEvent[] = []
  for (const t of syncTargets()) await syncOnce(t.cfg, t.statePath, { dryRun: true, settleMs: 0, onEvents: (e) => events.push(...e) })
  return { count: events.length, events: events.slice(-100).reverse() }
}

export interface SessionSummary {
  id: string; source: string; client: string | null; project: string | null; model: string | null
  firstAt: string; lastAt: string; turns: number; subagentTurns: number; agents: string[]; tools: string[]
  input: number; output: number; cacheRead: number; cacheCreation: number; thinking: number
}

/** Groups the sent log by session (Claude Code / Copilot conversations), most recently active first. */
export function summarizeSessions(entries: SentEntry[]): SessionSummary[] {
  const map = new Map<string, SessionSummary>()
  for (const { event: e } of entries) {
    const id = e.session_id || `${e.source}-${e.external_id}`
    let s = map.get(id)
    if (!s) { s = { id, source: e.source, client: e.client ?? null, project: e.project ?? null, model: e.model ?? null, firstAt: e.occurred_at, lastAt: e.occurred_at, turns: 0, subagentTurns: 0, agents: [], tools: [], input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 }; map.set(id, s) }
    s.turns++
    if (e.is_subagent) s.subagentTurns++
    if (e.agent_name && !s.agents.includes(e.agent_name)) s.agents.push(e.agent_name)
    for (const t of e.tools ?? []) if (!s.tools.includes(t)) s.tools.push(t)
    s.input += e.input_tokens; s.output += e.output_tokens; s.cacheRead += e.cache_read_tokens; s.cacheCreation += e.cache_creation_tokens; s.thinking += e.thinking_tokens
    if (e.occurred_at < s.firstAt) s.firstAt = e.occurred_at
    if (e.occurred_at > s.lastAt) { s.lastAt = e.occurred_at; s.model = e.model ?? s.model }
  }
  return [...map.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt))
}

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req: http.IncomingMessage, max = 10_000): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const c of req) { raw += c; if (raw.length > max) throw new Error('cuerpo demasiado grande') }
  return JSON.parse(raw || '{}')
}

export interface UiOptions {
  /** Modo instalación: al guardar la configuración instala el servicio y llama a onDone. */
  setup?: { onDone: () => void }
  /** No probar puertos siguientes: el panel del servicio tiene que estar siempre en el mismo. */
  fixedPort?: boolean
}

export function startUi(port: number, opts: UiOptions = {}): Promise<{ server: http.Server; port: number }> {
  const server = createUiServer(opts)
  return new Promise((resolve, reject) => {
    let p = port
    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE' && !opts.fixedPort && p < port + 20) server.listen(++p, '127.0.0.1')
      else reject(e)
    })
    server.on('listening', () => resolve({ server, port: p }))
    server.listen(p, '127.0.0.1')
  })
}

function createUiServer(opts: UiOptions): http.Server {
  return http.createServer(async (req, res) => {
    // Defensa contra DNS rebinding / CSRF: solo se atiende a localhost y las escrituras exigen un header propio.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '')
    if (host !== 'localhost' && host !== '127.0.0.1') return json(res, 403, { error: 'host no permitido' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" })
        return void res.end(PAGE)
      }
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, status())
      if (req.method === 'GET' && url.pathname === '/api/sent') return json(res, 200, tailSent(100))
      if (req.method === 'GET' && url.pathname === '/api/preview') return json(res, 200, await preview())
      if (req.method === 'GET' && url.pathname === '/api/accounts') {
        return json(res, 200, loadProfiles().map((p) => ({ name: p.name, email: p.email, keyPreview: p.key.slice(0, 12) + '…', configDir: p.configDir, command: launcherPath(p.name).split(/[\\/]/).pop() })))
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') return json(res, 200, summarizeSessions(tailSent(3000)).slice(0, 50))
      if (req.method === 'GET' && url.pathname === '/api/session') {
        const id = url.searchParams.get('id') ?? ''
        const turns = tailSent(3000).map((x) => x.event).filter((e) => (e.session_id || `${e.source}-${e.external_id}`) === id).reverse()
          .map((e) => ({ at: e.occurred_at, model: e.model, agent: e.is_subagent ? e.agent_name || 'subagent' : null, tools: e.tools ?? [], input: e.input_tokens, output: e.output_tokens, cacheRead: e.cache_read_tokens, request: e.request_text ?? null, response: e.response_text ?? null }))
        return json(res, 200, turns)
      }
      if (req.method === 'GET' && url.pathname === '/api/llm/providers') {
        return json(res, 200, { kinds: PROVIDER_KINDS, providers: loadProviders().map((p) => ({ id: p.id, kind: p.kind, label: p.label, baseUrl: p.baseUrl, fromEnv: !!p.fromEnv, hasKey: !!p.apiKey })) })
      }
      if (req.method === 'GET' && url.pathname === '/api/llm/models') {
        const p = loadProviders().find((x) => x.id === url.searchParams.get('id'))
        if (!p) return json(res, 200, { ok: false, error: 'Provider not found' })
        try { return json(res, 200, { ok: true, models: await listModels(p) }) } catch (e) { return json(res, 200, { ok: false, error: (e as Error).message }) }
      }
      if (req.method === 'GET' && url.pathname === '/api/check-path') {
        const p = expandHome(url.searchParams.get('p') ?? '')
        return json(res, 200, { exists: !!p && isDir(p) })
      }
      if (req.method === 'POST') {
        if (req.headers['x-octomate-ui'] !== '1') return json(res, 403, { error: 'falta header' })
        if (url.pathname === '/api/pause') {
          if (url.searchParams.get('value') === '1') fs.writeFileSync(PAUSE_PATH, new Date().toISOString()); else fs.rmSync(PAUSE_PATH, { force: true })
          return json(res, 200, status())
        }
        if (url.pathname === '/api/llm/providers/add') {
          const b = await readBody(req)
          try { const p = addProvider({ id: String(b.id ?? ''), kind: String(b.kind ?? ''), label: String(b.label ?? ''), apiKey: String(b.apiKey ?? ''), baseUrl: String(b.baseUrl ?? '') }); return json(res, 200, { ok: true, id: p.id }) } catch (e) { return json(res, 200, { ok: false, error: (e as Error).message }) }
        }
        if (url.pathname === '/api/llm/providers/remove') {
          try { removeProvider(String((await readBody(req)).id ?? '')); return json(res, 200, { ok: true }) } catch (e) { return json(res, 200, { ok: false, error: (e as Error).message }) }
        }
        if (url.pathname === '/api/llm/chat') {
          const b = await readBody(req, 2_000_000)
          const p = loadProviders().find((x) => x.id === b.provider)
          if (!p) return json(res, 200, { ok: false, error: 'Provider not found' })
          const messages = (Array.isArray(b.messages) ? b.messages : []).filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          try { return json(res, 200, { ok: true, ...(await chat(p, String(b.model ?? ''), messages)) }) } catch (e) { return json(res, 200, { ok: false, error: (e as Error).message }) }
        }
        if (url.pathname === '/api/accounts/add') {
          const b = await readBody(req)
          try {
            const r = await addProfile(String(b.name ?? ''), String(b.email ?? ''), String(b.key ?? ''))
            return json(res, 200, { ok: true, command: launcherPath(r.profile.name), commandName: launcherPath(r.profile.name).split(/[\\/]/).pop(), label: r.label, onPath: r.onPath })
          } catch (e) { return json(res, 200, { ok: false, error: (e as Error).message }) }
        }
        if (url.pathname === '/api/accounts/remove') {
          try { removeProfile(String((await readBody(req)).name ?? '')); return json(res, 200, { ok: true }) } catch (e) { return json(res, 200, { ok: false, error: (e as Error).message }) }
        }
        if (url.pathname === '/api/settings') {
          const r = await saveSettings(await readBody(req))
          if (!r.ok) return json(res, 200, r)
          let service: string | null = null; let serviceError: string | null = null
          if (opts.setup) {
            try { service = installService() } catch (e) { serviceError = (e as Error).message }
            setTimeout(opts.setup.onDone, 5000)
          }
          return json(res, 200, { ...r, service, serviceError, setup: !!opts.setup })
        }
      }
      json(res, 404, { error: 'no encontrado' })
    } catch (e) { json(res, 500, { error: (e as Error).message }) }
  })
}

const PAGE = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OctoMateLabs · Recolector</title><link rel="icon" href="${LOGO_DATA_URI}">
<style>
:root{color-scheme:light dark;--bg:#f7f6fb;--fg:#1d1b2b;--mut:#6b6880;--bd:#e2dff0;--card:#fff;--ac:#7c5cf0;--ac2:#d86be6;--ok:#12805c;--err:#d6314a;--inp:#fbfaff}
@media(prefers-color-scheme:dark){:root{--bg:#0f0e17;--fg:#ecebf5;--mut:#9b98b3;--bd:#2a2840;--card:#171527;--ac:#9b82ff;--ac2:#e58bf0;--ok:#3ecf9e;--err:#ff6b81;--inp:#0f0e17}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 Inter,system-ui,sans-serif}
.app{display:flex;min-height:100vh}
.side{width:236px;flex:none;position:sticky;top:0;height:100vh;border-right:1px solid var(--bd);background:var(--card);padding:18px 12px;display:flex;flex-direction:column;gap:4px;overflow:auto}
.brand{display:flex;align-items:center;gap:10px;padding:0 6px 14px}.brand img{height:40px;width:auto}.brand b{display:block;font-size:14px;line-height:1.2}.brand span{color:var(--mut);font-size:11px}
.side nav{display:flex;flex-direction:column;gap:2px}
.side a{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:9px;color:var(--fg);text-decoration:none;font-weight:500;border:1px solid transparent}
.side a:hover{background:var(--inp)}.side a.on{background:var(--inp);border-color:var(--ac);color:var(--ac)}
.side .foot{margin-top:auto;padding:10px 6px 0}.side .pill{margin:0;display:inline-block}
.main{flex:1;min-width:0}
@media(max-width:760px){.app{flex-direction:column}.side{width:auto;height:auto;position:static;border-right:0;border-bottom:1px solid var(--bd);padding:10px}.side nav{flex-direction:row;flex-wrap:wrap}.side .foot{display:none}}
.chat{display:flex;flex-direction:column;height:calc(100vh - 70px);min-height:420px}
.chat .top{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
select{font:inherit;background:var(--inp);color:var(--fg);border:1px solid var(--bd);border-radius:8px;padding:8px 10px;max-width:100%}
#msgs{flex:1;overflow:auto;border:1px solid var(--bd);border-radius:14px;background:var(--card);padding:14px;display:flex;flex-direction:column;gap:10px}
.m{max-width:85%;padding:9px 13px;border-radius:12px;white-space:pre-wrap;word-break:break-word}
.m.user{align-self:flex-end;background:linear-gradient(135deg,var(--ac),var(--ac2));color:#fff}
.m.assistant{align-self:flex-start;background:var(--inp);border:1px solid var(--bd)}
.m.error{align-self:flex-start;color:var(--err);border:1px solid var(--err);background:transparent}
.m small{display:block;margin-top:6px;opacity:.65;font-size:11px}
.info{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.chip{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:5px 11px;font-size:12px;color:var(--mut)}.chip b{color:var(--fg);font-size:13px}
.ctx{height:5px;border-radius:3px;background:var(--bd);margin-top:4px;overflow:hidden;min-width:90px}.ctx i{display:block;height:100%;background:linear-gradient(90deg,var(--ac),var(--ac2))}.ctx i.hot{background:var(--err)}
.m.tool{align-self:flex-start;font-size:12px;color:var(--mut);padding:4px 10px;border:1px dashed var(--bd);background:transparent}
.compose{display:flex;gap:8px;margin-top:10px;align-items:flex-end}
textarea{flex:1;font:inherit;background:var(--inp);color:var(--fg);border:1px solid var(--bd);border-radius:10px;padding:10px 12px;resize:vertical;min-height:44px;max-height:200px}
textarea:focus{outline:2px solid var(--ac);outline-offset:-1px;border-color:transparent}
.wrap{max-width:860px;margin:0 auto;padding:20px 16px 48px}
header{display:flex;align-items:center;gap:14px;margin:8px 0 20px}
header img{height:56px;width:auto}
header h1{font-size:20px;margin:0;line-height:1.2}header p{margin:2px 0 0;color:var(--mut)}
.pill{margin-left:auto;padding:4px 12px;border-radius:99px;font-size:12px;font-weight:600;border:1px solid var(--bd);background:var(--card)}
.pill.on{color:var(--ok);border-color:var(--ok)}.pill.off{color:var(--err);border-color:var(--err)}
.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:18px 20px;margin:14px 0;box-shadow:0 1px 2px rgba(60,40,120,.05)}
.card h2{font-size:15px;margin:0 0 2px}.card .sub{color:var(--mut);margin:0 0 14px;font-size:13px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:640px){.grid{grid-template-columns:1fr}}
.full{grid-column:1/-1}
label{display:block;font-weight:600;font-size:13px;margin-bottom:4px}
.hint{font-weight:400;color:var(--mut);font-size:12px;margin-top:3px}
input[type=text],input[type=password],input[type=number],input[type=url]{width:100%;background:var(--inp);color:var(--fg);border:1px solid var(--bd);border-radius:8px;padding:9px 11px;font:inherit}
input:focus{outline:2px solid var(--ac);outline-offset:-1px;border-color:transparent}
input.bad{border-color:var(--err)}input.good{border-color:var(--ok)}
.err{color:var(--err);font-size:12px;margin-top:3px;min-height:0}
.keyrow{display:flex;gap:6px}.keyrow button{white-space:nowrap}
.sw{display:flex;align-items:center;gap:10px;font-weight:600;cursor:pointer}.sw input{width:18px;height:18px;accent-color:var(--ac)}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--bd);background:var(--card);color:var(--fg);padding:8px 14px}
button:hover{border-color:var(--ac)}
button.primary{background:linear-gradient(135deg,var(--ac),var(--ac2));color:#fff;border:0;font-weight:600;padding:10px 20px}
button.primary:disabled{opacity:.6;cursor:wait}
.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:16px}
#msg,#amsg{font-size:13px}#msg.ok,#amsg.ok{color:var(--ok)}#msg.bad,#amsg.bad{color:var(--err)}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
details.ev{border:1px solid var(--bd);border-radius:10px;padding:8px 12px;margin:6px 0;background:var(--card)}
details.ev summary{cursor:pointer;font-size:13px}
pre{white-space:pre-wrap;word-break:break-word;margin:8px 0 0;font-size:12px;max-height:300px;overflow:auto}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:6px 0}.stats div{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:10px 14px}.stats b{display:block;font-size:20px}.stats span{color:var(--mut);font-size:12px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--ok);margin-right:6px;animation:pl 1.6s infinite}@keyframes pl{50%{opacity:.25}}
details.ev.new{border-color:var(--ac);animation:fl 2.5s}@keyframes fl{from{background:rgba(124,92,240,.25)}}
h3{font-size:14px;margin:22px 0 6px}.mut{color:var(--mut)}[hidden]{display:none!important}
</style></head><body><div class="app">
<aside class="side"><div class="brand"><img src="${LOGO_DATA_URI}" alt="OctoMateLabs"><div><b>OctoMateLabs</b><span>Recolector</span></div></div>
<nav><a href="#chat" data-v="chat">💬 Chat LLM</a><a href="#live" data-v="live">📡 Envíos en vivo</a><a href="#models" data-v="models">🧠 Modelos / keys</a><a href="#config" data-v="config">⚙️ Configuración</a><a href="#accounts" data-v="accounts">👥 Cuentas</a></nav>
<div class="foot"><span id="pill" class="pill">…</span></div></aside>
<main class="main"><div class="wrap">

<section class="view" id="v-chat"><div class="chat">
<div class="top"><select id="cconv" aria-label="Conversaciones" style="min-width:220px"></select><select id="cprov" aria-label="Proveedor"></select><select id="cmodel" aria-label="Modelo"></select><button type="button" id="cnew">Nueva conversación</button><button type="button" id="cdel" title="Borrar esta conversación">Borrar</button></div>
<div class="info" id="cinfo"></div>
<div id="msgs"><div class="mut" id="cempty">Elegí un proveedor y un modelo, y escribí abajo. Las consultas van directo desde esta máquina al proveedor; no pasan por OctoMateLabs.</div></div>
<div class="compose" id="compose"><textarea id="cin" rows="2" placeholder="Escribí tu mensaje… (Enter envía, Shift+Enter nueva línea)"></textarea><button class="primary" id="csend" type="button">Enviar</button></div>
</div></section>

<section class="view" id="v-models" hidden>
<div class="card"><h2>Modelos / keys</h2><p class="sub">Proveedores disponibles para el chat. Se toman también de <code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code> y <code>GEMINI_API_KEY</code> si existen. Lo que agregues acá se guarda en <code>~/.octomatelabs/llm.json</code> (permisos 0600).</p>
<div id="plist" class="mut"></div>
<div class="grid" style="margin-top:12px">
<div><label for="pk">Tipo</label><select id="pk"></select></div>
<div><label for="pid">Nombre (id)</label><input type="text" id="pid" placeholder="anthropic-trabajo" spellcheck="false"></div>
<div class="full"><label for="pkey">API key</label><input type="password" id="pkey" placeholder="No hace falta para Ollama" spellcheck="false" autocomplete="off"></div>
<div class="full"><label for="purl">URL base (opcional)</label><input type="url" id="purl" placeholder="Para servidores compatibles con OpenAI u Ollama remoto" spellcheck="false"></div>
</div>
<div class="bar"><button type="button" id="padd">Agregar proveedor</button><span id="pmsg"></span></div></div>
</section>

<section class="view" id="v-live" hidden>
<div class="actions"><button id="bp"></button><button id="bs">Actualizar</button></div>
<div class="stats"><div><b id="n-total">0</b><span>enviados (últimos 100)</span></div><div><b id="n-last">-</b><span>último envío</span></div><div><b id="n-tok">0</b><span>tokens out (visibles)</span></div></div>
<h3><span class="dot"></span> En vivo · lo que se está enviando</h3><div id="sent" class="mut"></div>
</section>

<section class="view" id="v-config" hidden>
<form id="sf" class="card" autocomplete="off" novalidate>
<h2>Conexión y fuentes</h2><p class="sub" id="subt">En OctoMateLabs → <b>Mi consumo</b> → <i>Generar key</i>, y pegala acá.</p>
<div class="grid">
<div class="full"><label for="accountEmail">Email de tu cuenta de Claude Code</label><input type="text" id="accountEmail" spellcheck="false" placeholder="nombre@empresa.com"><div class="hint" id="lhint"></div><div class="err" id="e-accountEmail"></div></div>
<div class="full"><label for="key">Key</label><div class="keyrow"><input type="password" id="key" placeholder="omk_..." spellcheck="false"><button type="button" id="eye">Ver</button></div><div class="hint" id="khint"></div><div class="err" id="e-key"></div></div>
<div class="full"><label for="url">URL de la API</label><input type="text" id="url" readonly tabindex="-1" style="opacity:.7;cursor:not-allowed"></div>
<div class="full"><label for="intervalSeconds">Intervalo de sincronización (segundos)</label><input type="number" id="intervalSeconds" min="5" max="3600"><div class="hint">Entre 5 y 3600.</div><div class="err" id="e-intervalSeconds"></div></div>
<div class="full"><label for="claudeDir">Carpeta de Claude Code</label><input type="text" id="claudeDir" spellcheck="false" data-path="1"><div class="err" id="e-claudeDir"></div></div>
<div class="full"><label class="sw"><input type="checkbox" id="strictRedact"> Cifrar información sensible</label><div class="hint">Corta claves, tokens, contraseñas y valores secretos que aparezcan en prompts y responses antes de enviarlos (se reemplazan por [REDACTED]). Recomendado.</div></div>
<div class="full"><label class="sw"><input type="checkbox" id="copilotEnabled"> Incluir GitHub Copilot Chat (VS Code)</label>
<div id="cop" style="margin-top:8px"><label for="copilotDir">Carpeta workspaceStorage de VS Code</label><input type="text" id="copilotDir" spellcheck="false" data-path="1"><div class="err" id="e-copilotDir"></div></div></div>
</div>
<div class="bar"><button class="primary" id="sb" type="submit">Guardar y conectar</button><span id="msg"></span></div>
</form>
</section>

<section class="view" id="v-accounts" hidden><div class="card" id="acc">
<h2>Cuentas de Claude Code</h2><p class="sub">¿Usás Claude Code con más de una cuenta (trabajo, personal…)? Agregá cada una con su propia key y se ven separadas en <b>Mi consumo</b>. Se crea un comando <code>claude-&lt;nombre&gt;</code> que abre Claude Code con esa cuenta: no hace falta desloguearse.</p>
<div id="acclist" class="mut"></div>
<div class="grid" style="margin-top:12px">
<div><label for="an">Nombre</label><input type="text" id="an" placeholder="trabajo" spellcheck="false"></div>
<div><label for="ae">Email de esa cuenta de Claude Code</label><input type="text" id="ae" placeholder="nombre@empresa.com" spellcheck="false"></div>
<div class="full"><label for="ak">Key de esa cuenta (generada con ese email)</label><input type="password" id="ak" placeholder="omk_..." spellcheck="false"></div>
</div>
<div class="bar"><button type="button" id="aadd">Agregar cuenta</button><span id="amsg"></span></div>
</div></section>
</div></main></div>
<script>
const $=id=>document.getElementById(id);
const H={'x-octomate-ui':'1','content-type':'application/json'};
const get=p=>fetch(p).then(r=>r.json());
const post=(p,b)=>fetch(p,{method:'POST',headers:H,body:b?JSON.stringify(b):undefined}).then(r=>r.json());
const FIELDS=['accountEmail','key','intervalSeconds','claudeDir','copilotDir'];
function mark(f,msg,ok){const i=$(f),e=$('e-'+f);if(!i||!e)return;e.textContent=msg||'';i.classList.toggle('bad',!!msg);i.classList.toggle('good',!msg&&!!ok)}
async function checkPath(f){const v=$(f).value.trim();if(f==='copilotDir'&&!$('copilotEnabled').checked){mark(f,'');return}
 if(!v){mark(f,'Obligatorio');return}const r=await get('/api/check-path?p='+encodeURIComponent(v));mark(f,r.exists?'':'Esa carpeta no existe',r.exists)}
function ev(e,when){const d=document.createElement('details');d.className='ev';const s=document.createElement('summary');
 s.textContent=[when||e.occurred_at,e.source,e.model||'-',e.project||'-','in '+e.input_tokens,'out '+e.output_tokens].join(' · ');
 const p=document.createElement('pre');p.textContent=JSON.stringify(e,null,2);d.append(s,p);return d}
let S=null;
async function load(fill){
 S=await get('/api/status');
 const pill=$('pill');pill.textContent=!S.hasKey?'Sin configurar':S.paused?'En pausa':'Activo';pill.className='pill '+(!S.hasKey?'off':S.paused?'off':'on');
 if(fill){$('url').value=S.url;$('accountEmail').value=S.accountEmail||'';$('lhint').textContent=S.loggedEmail?(S.accountEmail&&S.loggedEmail!==S.accountEmail?'⚠ Claude Code está logueado como '+S.loggedEmail+': no se envía nada hasta que coincida.':'Sesión actual de Claude Code: '+S.loggedEmail):'';$('intervalSeconds').value=S.intervalSeconds;$('claudeDir').value=S.claudeDir;$('copilotDir').value=S.copilotDir||'';
  $('copilotEnabled').checked=S.copilotEnabled;$('strictRedact').checked=S.strictRedact;$('cop').hidden=!S.copilotEnabled;
  $('khint').textContent=S.hasKey?'Key guardada ('+S.keyPreview+'). Dejá el campo vacío para conservarla o pegá otra para reemplazarla.':'';
  $('subt').hidden=S.hasKey;$('sb').textContent=S.hasKey?'Guardar cambios':'Guardar y conectar'}
 $('bp').textContent=S.paused?'Reanudar envío':'Pausar envío';
}
const seen=new Set();let first=true;
const kid=x=>x.event.source+'|'+x.event.external_id;
async function live(){
 let sent;try{sent=await get('/api/sent')}catch{$('pill').textContent='Panel sin conexión';$('pill').className='pill off';return}
 const box=$('sent');
 if(!sent.length&&first)box.textContent='Esperando actividad… apenas uses Claude Code o Copilot aparece acá.';
 const fresh=sent.filter(x=>!seen.has(kid(x)));
 if(fresh.length){if(first)box.textContent='';
  for(const x of fresh.reverse()){seen.add(kid(x));const d=ev(x.event,new Date(x.sentAt).toLocaleTimeString());if(!first)d.classList.add('new');box.prepend(d)}
  while(box.children.length>100)box.lastChild.remove()}
 first=false;
 $('n-total').textContent=sent.length;$('n-last').textContent=sent[0]?new Date(sent[0].sentAt).toLocaleTimeString():'-';
 $('n-tok').textContent=sent.reduce((a,x)=>a+(x.event.output_tokens||0),0).toLocaleString();
}
$('eye').onclick=()=>{const k=$('key');const h=k.type==='password';k.type=h?'text':'password';$('eye').textContent=h?'Ocultar':'Ver'};
$('copilotEnabled').onchange=()=>{$('cop').hidden=!$('copilotEnabled').checked;if($('copilotEnabled').checked)checkPath('copilotDir');else mark('copilotDir','')};
document.querySelectorAll('[data-path]').forEach(i=>i.addEventListener('blur',()=>checkPath(i.id)));
$('key').addEventListener('input',()=>{const v=$('key').value.trim();mark('key',v&&!v.startsWith('omk_')?'La key tiene que empezar con omk_':'')});
$('intervalSeconds').addEventListener('input',()=>{const n=Number($('intervalSeconds').value);mark('intervalSeconds',Number.isInteger(n)&&n>=5&&n<=3600?'':'Un número entero entre 5 y 3600')});
$('sf').onsubmit=async e=>{e.preventDefault();FIELDS.forEach(f=>mark(f,''));$('sb').disabled=true;$('msg').className='';$('msg').textContent='Validando…';
 let r;try{r=await post('/api/settings',{accountEmail:$('accountEmail').value,key:$('key').value,intervalSeconds:Number($('intervalSeconds').value),claudeDir:$('claudeDir').value,
  copilotEnabled:$('copilotEnabled').checked,strictRedact:$('strictRedact').checked,copilotDir:$('copilotDir').value})}catch(x){r={ok:false,errors:{},error:String(x)}}
 $('sb').disabled=false;
 if(!r.ok){Object.entries(r.errors||{}).forEach(([f,m])=>mark(f,m));$('msg').className='bad';$('msg').textContent='Revisá los campos marcados.';const b=document.querySelector('.bad');if(b)b.focus();return}
 $('msg').className='ok';$('msg').textContent='✔ Guardado'+(r.label?' · key "'+r.label+'"':'')+(r.setup?(r.serviceError?' · Servicio: '+r.serviceError:' · Quedó corriendo en segundo plano; en unos segundos te llevo al panel en vivo (http://localhost:4567).'):' · se aplica en el próximo ciclo.');
 $('key').value='';load(true);if(r.setup&&!r.serviceError)setTimeout(()=>{location.href='http://localhost:4567'},7000)};
async function accounts(){
 const l=await get('/api/accounts'),box=$('acclist');box.textContent='';
 const row=(t,b)=>{const d=document.createElement('div');d.style.cssText='display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--bd)';const s=document.createElement('span');s.textContent=t;s.style.flex='1';d.append(s);if(b)d.append(b);box.append(d)};
 row('default · '+(S&&S.accountEmail||'sin email')+' · cuenta principal (~/.claude)');
 for(const a of l){const b=document.createElement('button');b.textContent='Quitar';b.onclick=async()=>{if(!confirm('¿Quitar la cuenta "'+a.name+'" del recolector? (no borra su carpeta de Claude Code)'))return;await post('/api/accounts/remove',{name:a.name});accounts()};
  row(a.name+' · '+a.email+' · '+a.keyPreview+' · abrí Claude Code con: '+a.command,b)}}
$('aadd').onclick=async()=>{const m=$('amsg');m.className='';m.textContent='Validando…';$('aadd').disabled=true;
 let r;try{r=await post('/api/accounts/add',{name:$('an').value,email:$('ae').value,key:$('ak').value})}catch(x){r={ok:false,error:String(x)}}
 $('aadd').disabled=false;
 if(!r.ok){m.className='bad';m.textContent=r.error;return}
 m.className='ok';m.textContent='✔ Agregada. Abrí Claude Code con "'+r.commandName+'" y hacé /login con esa cuenta (una sola vez).'+(r.onPath?'':' Agregá '+r.command.replace(/[\\/][^\\/]*$/,'')+' a tu PATH.');
 $('an').value='';$('ae').value='';$('ak').value='';accounts()};
// ── Sidebar navigation ──
const VIEWS=['chat','live','models','config','accounts'];
function show(){const v=VIEWS.includes(location.hash.slice(1))?location.hash.slice(1):'chat';
 VIEWS.forEach(x=>{$('v-'+x).hidden=x!==v});document.querySelectorAll('.side a').forEach(a=>a.classList.toggle('on',a.dataset.v===v));
 if(v==='chat')$('cin').focus()}
window.addEventListener('hashchange',show);
// ── LLM providers ──
let PROV=[];
async function providers(){
 const r=await get('/api/llm/providers');PROV=r.providers;
 if(!$('pk').options.length)r.kinds.forEach(k=>{const o=document.createElement('option');o.value=k;o.textContent=k;$('pk').append(o)});
 const sel=$('cprov'),prev=sel.value;sel.textContent='';
 PROV.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.label+' ('+p.kind+')';sel.append(o)});
 if(!PROV.length){const o=document.createElement('option');o.textContent='Sin proveedores: agregá uno en "Modelos / keys"';o.value='';sel.append(o)}
 else if(PROV.some(p=>p.id===prev))sel.value=prev;
 const box=$('plist');box.textContent='';
 if(!PROV.length)box.textContent='Todavía no hay proveedores configurados.';
 for(const p of PROV){const d=document.createElement('div');d.style.cssText='display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--bd)';
  const s=document.createElement('span');s.style.flex='1';s.textContent=p.label+' · '+p.kind+(p.baseUrl?' · '+p.baseUrl:'')+(p.fromEnv?' · variable de entorno':'');d.append(s);
  if(!p.fromEnv){const b=document.createElement('button');b.textContent='Quitar';b.onclick=async()=>{if(!confirm('¿Quitar el proveedor "'+p.id+'"?'))return;await post('/api/llm/providers/remove',{id:p.id});providers()};d.append(b)}
  box.append(d)}
 await models()}
async function models(){
 const sel=$('cmodel');sel.textContent='';const id=$('cprov').value;if(!id)return;
 const o=document.createElement('option');o.textContent='Cargando modelos…';sel.append(o);
 const r=await get('/api/llm/models?id='+encodeURIComponent(id));sel.textContent='';
 if(!r.ok){const e=document.createElement('option');e.textContent='No se pudo listar: '+r.error;e.value='';sel.append(e);return}
 r.models.forEach(m=>{const e=document.createElement('option');e.value=m;e.textContent=m;sel.append(e)})}
$('cprov').onchange=models;
$('padd').onclick=async()=>{const m=$('pmsg');m.className='';m.textContent='Guardando…';
 const r=await post('/api/llm/providers/add',{kind:$('pk').value,id:$('pid').value,apiKey:$('pkey').value,baseUrl:$('purl').value});
 if(!r.ok){m.className='bad';m.textContent=r.error;return}
 m.className='ok';m.textContent='✔ Agregado';$('pid').value='';$('pkey').value='';$('purl').value='';await providers();$('cprov').value=r.id;models()};
// ── Chat: saved conversations (browser localStorage) + read-only Claude Code sessions ──
const LS='octomate-chats';
const loadChats=()=>{try{return JSON.parse(localStorage.getItem(LS)||'[]')}catch{return[]}};
const saveChats=()=>{try{localStorage.setItem(LS,JSON.stringify(CHATS.slice(0,50)))}catch{}};
let CHATS=loadChats(),CUR=null,SESS=[],busy=false;
const WINDOW=[[/gpt-4\.1|gemini|fable|opus-5/,1000000],[/claude/,200000],[/gpt-4o|gpt-4/,128000]];
const ctxWindow=m=>{const w=WINDOW.find(([r])=>r.test(m||''));return w?w[1]:0};
const fmt=n=>(n||0).toLocaleString();
const newChat=()=>{const c={id:'c'+Date.now(),title:'Nueva conversación',provider:'',model:'',msgs:[],at:Date.now()};CHATS.unshift(c);CUR='chat:'+c.id;saveChats();return c};
const curChat=()=>CHATS.find(c=>'chat:'+c.id===CUR);
function convList(){const sel=$('cconv');sel.textContent='';
 const g1=document.createElement('optgroup');g1.label='Chats';
 CHATS.forEach(c=>{const o=document.createElement('option');o.value='chat:'+c.id;o.textContent=c.title+' · '+c.msgs.filter(m=>m.role!=='error').length+' msgs';g1.append(o)});
 const g2=document.createElement('optgroup');g2.label='Sesiones de Claude Code / Copilot (solo lectura)';
 SESS.forEach(x=>{const o=document.createElement('option');o.value='sess:'+x.id;o.textContent=new Date(x.lastAt).toLocaleTimeString()+' · '+(x.project||'-').split(/[\\/]/).pop()+' · '+x.turns+' turnos';g2.append(o)});
 if(CHATS.length)sel.append(g1);if(SESS.length)sel.append(g2);sel.value=CUR}
function chip(label,val,extra){const d=document.createElement('div');d.className='chip';const b=document.createElement('b');b.textContent=val;d.append(label+' ',b);if(extra)d.append(extra);$('cinfo').append(d)}
function bubble(cls,text,meta){const d=document.createElement('div');d.className='m '+cls;d.textContent=text;if(meta){const s=document.createElement('small');s.textContent=meta;d.append(s)}
 $('cempty').hidden=true;$('msgs').append(d);$('msgs').scrollTop=1e9;return d}
function infoChat(c){$('cinfo').textContent='';
 const ok=c.msgs.filter(m=>m.role!=='error'),as=ok.filter(m=>m.role==='assistant');
 const last=as[as.length-1],tin=as.reduce((a,m)=>a+(m.in||0),0),tout=as.reduce((a,m)=>a+(m.out||0),0);
 const w=ctxWindow(c.model),used=last?last.in+last.out:0;
 let bar=null;if(w&&used){bar=document.createElement('div');bar.className='ctx';const i=document.createElement('i');const pc=Math.min(100,used/w*100);i.style.width=pc+'%';if(pc>80)i.className='hot';bar.append(i)}
 chip('Contexto',w?fmt(used)+' / '+fmt(w)+' ('+(used/w*100).toFixed(1)+'%)':fmt(used)+' tokens',bar);
 chip('Mensajes',ok.length);chip('Tokens in',fmt(tin));chip('Tokens out',fmt(tout));chip('Modelo',c.model||'-');
 if(as.length)chip('Latencia media',(as.reduce((a,m)=>a+(m.ms||0),0)/as.length/1000).toFixed(1)+' s')}
function infoSess(x){$('cinfo').textContent='';
 chip('Turnos',x.turns);chip('Subagentes',x.subagentTurns+(x.agents.length?' ('+x.agents.join(', ')+')':''));
 chip('Tokens in',fmt(x.input));chip('Tokens out',fmt(x.output));chip('Cache read',fmt(x.cacheRead));chip('Cache write',fmt(x.cacheCreation));
 if(x.thinking)chip('Thinking',fmt(x.thinking));chip('Modelo',x.model||'-');chip('Proyecto',(x.project||'-').split(/[\\/]/).pop());
 if(x.tools.length)chip('Herramientas',x.tools.length+': '+x.tools.slice(0,6).join(', '))}
async function render(){
 $('msgs').querySelectorAll('.m').forEach(m=>m.remove());$('cempty').hidden=false;
 const ro=CUR&&CUR.startsWith('sess:');$('compose').hidden=ro;$('cdel').hidden=ro;$('cprov').hidden=ro;$('cmodel').hidden=ro;
 if(ro){const x=SESS.find(s=>'sess:'+s.id===CUR);if(!x)return;infoSess(x);
  const turns=await get('/api/session?id='+encodeURIComponent(x.id));
  for(const t of turns){if(t.request)bubble('user',t.request,(t.agent?'subagente '+t.agent+' · ':'')+new Date(t.at).toLocaleTimeString());
   if(t.tools.length)bubble('tool','🔧 '+t.tools.join(', '));
   bubble('assistant',t.response||'(sin texto)',(t.model||'-')+' · in '+t.input+' · out '+t.output+' · cache '+t.cacheRead)}
  return}
 const c=curChat();if(!c)return;
 if(c.provider&&PROV.some(p=>p.id===c.provider)){$('cprov').value=c.provider;await models();if(c.model)$('cmodel').value=c.model}
 c.msgs.forEach(m=>bubble(m.role==='error'?'error':m.role,m.content,m.role==='assistant'?(m.model||'')+' · in '+m.in+' · out '+m.out+' · '+((m.ms||0)/1000).toFixed(1)+' s':''));
 infoChat(c)}
async function sessions(){try{SESS=await get('/api/sessions')}catch{return}if(!busy){const keep=CUR;convList();if(keep&&$('cconv').value!==keep)$('cconv').value=CUR}}
async function send(){
 const text=$('cin').value.trim();if(!text||busy)return;
 const provider=$('cprov').value,model=$('cmodel').value;
 if(!provider||!model){bubble('error','Elegí un proveedor y un modelo antes de enviar.');return}
 const c=curChat();if(!c)return;busy=true;$('csend').disabled=true;$('cin').value='';
 c.provider=provider;c.model=model;c.msgs.push({role:'user',content:text});if(c.title==='Nueva conversación')c.title=text.slice(0,40);bubble('user',text);
 const wait=bubble('assistant','…');
 let r;try{r=await post('/api/llm/chat',{provider,model,messages:c.msgs.filter(m=>m.role!=='error').map(m=>({role:m.role,content:m.content}))})}catch(x){r={ok:false,error:String(x)}}
 wait.remove();
 if(r.ok){c.msgs.push({role:'assistant',content:r.text||'(respuesta vacía)',model,in:r.inputTokens,out:r.outputTokens,ms:r.ms})}
 else{c.msgs.pop();c.msgs.push({role:'error',content:r.error||'Error desconocido'})}
 c.at=Date.now();saveChats();busy=false;$('csend').disabled=false;convList();await render();$('cin').focus()}
$('csend').onclick=send;
$('cin').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
$('cconv').onchange=()=>{CUR=$('cconv').value;render()};
$('cmodel').onchange=()=>{const c=curChat();if(c){c.model=$('cmodel').value;c.provider=$('cprov').value;saveChats();infoChat(c)}};
$('cnew').onclick=()=>{newChat();convList();render();$('cin').focus()};
$('cdel').onclick=()=>{const c=curChat();if(!c||!confirm('¿Borrar "'+c.title+'"?'))return;CHATS=CHATS.filter(x=>x!==c);saveChats();CUR=CHATS.length?'chat:'+CHATS[0].id:(newChat(),CUR);convList();render()};
function initChat(){if(!CHATS.length)newChat();else CUR='chat:'+CHATS[0].id;convList();sessions().then(render)}
$('bp').onclick=async()=>{await post('/api/pause?value='+(S.paused?0:1));load(false)};
$('bs').onclick=()=>{load(false);live()};show();providers().then(initChat);load(true);live();accounts();setInterval(()=>{load(false);live()},3000);setInterval(sessions,10000);
</script></body></html>`
