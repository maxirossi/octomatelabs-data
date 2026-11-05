import fs from 'node:fs'
import http from 'node:http'
import { ENV_PATH, HOME_DIR, PAUSE_PATH, STATE_PATH, loadConfig, parseEnv } from './config.ts'
import { ping } from './sender.ts'
import { tailSent } from './sentlog.ts'
import { installService } from './service.ts'
import { loadState } from './state.ts'
import { syncOnce } from './sync.ts'
import type { UsageEvent } from './types.ts'

function setEnvVar(key: string, value: string): void {
  let text = ''
  try { text = fs.readFileSync(ENV_PATH, 'utf8') } catch { /* nuevo */ }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith(key + '='))
  lines.push(`${key}=${value}`)
  fs.mkdirSync(HOME_DIR, { recursive: true })
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', { mode: 0o600 })
}

function status() {
  const cfg = loadConfig(); const st = loadState(STATE_PATH)
  return {
    url: cfg.url, key: cfg.key ? cfg.key.slice(0, 12) + '…' : null, metadataOnly: cfg.metadataOnly,
    paused: fs.existsSync(PAUSE_PATH), intervalSeconds: cfg.intervalSeconds, claudeDir: cfg.claudeDir,
    copilotDir: cfg.copilotDir, trackedFiles: Object.keys(st.files).length, initializedAt: st.initializedAt ?? null,
  }
}

async function preview(): Promise<{ count: number; events: UsageEvent[] }> {
  const cfg = loadConfig()
  const events: UsageEvent[] = []
  await syncOnce(cfg, STATE_PATH, { dryRun: true, settleMs: 0, onEvents: (e) => events.push(...e) })
  return { count: events.length, events: events.slice(-100).reverse() }
}

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const c of req) { raw += c; if (raw.length > 10_000) throw new Error('cuerpo demasiado grande') }
  return JSON.parse(raw || '{}')
}

/** Valida la key contra el servidor y recién ahí la guarda en ~/.octomatelabs/.env. */
async function saveConfig(body: Record<string, unknown>) {
  const url = String(body.url ?? '').trim().replace(/\/+$/, '') || loadConfig().url
  const key = String(body.key ?? '').trim()
  if (!/^https?:\/\//.test(url)) throw new Error('La URL debe empezar con http:// o https://')
  if (!key.startsWith('omk_')) throw new Error('La key tiene que empezar con omk_')
  const r = await ping(url, key)
  if (!r.ok) throw new Error(`No se pudo validar la key (${r.status || 'sin conexión'}${r.error ? ': ' + r.error : ''})`)
  setEnvVar('OCTOMATELABS_URL', url)
  setEnvVar('OCTOMATELABS_KEY', key)
  return { label: r.label ?? null }
}

export interface UiOptions {
  /** Modo instalación: al guardar la key instala el servicio y llama a onDone. */
  setup?: { onDone: () => void }
}

export function startUi(port: number, opts: UiOptions = {}): Promise<{ server: http.Server; port: number }> {
  const server = createUiServer(opts)
  return new Promise((resolve, reject) => {
    let p = port
    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE' && p < port + 20) server.listen(++p, '127.0.0.1')
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
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" })
        return void res.end(PAGE)
      }
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, status())
      if (req.method === 'GET' && url.pathname === '/api/sent') return json(res, 200, tailSent(100))
      if (req.method === 'GET' && url.pathname === '/api/preview') return json(res, 200, await preview())
      if (req.method === 'POST') {
        if (req.headers['x-octomate-ui'] !== '1') return json(res, 403, { error: 'falta header' })
        if (url.pathname === '/api/pause') {
          const paused = url.searchParams.get('value') === '1'
          if (paused) fs.writeFileSync(PAUSE_PATH, new Date().toISOString()); else fs.rmSync(PAUSE_PATH, { force: true })
          return json(res, 200, status())
        }
        if (url.pathname === '/api/config') {
          const r = await saveConfig(await readBody(req))
          let service: string | null = null; let serviceError: string | null = null
          if (opts.setup) {
            try { service = installService() } catch (e) { serviceError = (e as Error).message }
            setTimeout(opts.setup.onDone, 4000)
          }
          return json(res, 200, { ok: true, ...r, service, serviceError, setup: !!opts.setup })
        }
        if (url.pathname === '/api/metadata-only') {
          setEnvVar('METADATA_ONLY', url.searchParams.get('value') === '1' ? 'true' : 'false')
          return json(res, 200, status())
        }
      }
      json(res, 404, { error: 'no encontrado' })
    } catch (e) { json(res, 500, { error: (e as Error).message }) }
  })
}

// parseEnv se reexporta para tests de setEnvVar sin tocar el disco del usuario
export { parseEnv }

const PAGE = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>octomate-data</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mut:#666;--bd:#ddd;--card:#f6f6f6;--ac:#0a7d5a}
@media(prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--mut:#999;--bd:#333;--card:#1b1b1b;--ac:#3ecf9e}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;max-width:960px;margin-inline:auto}
h1{font-size:18px;margin:0 0 12px}h2{font-size:15px;margin:24px 0 8px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
.card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:10px 12px;margin:6px 0}
button{background:var(--card);color:var(--fg);border:1px solid var(--bd);border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit}
button:hover{border-color:var(--ac)}.mut{color:var(--mut)}.ok{color:var(--ac)}
pre{white-space:pre-wrap;word-break:break-word;margin:6px 0 0;font-size:12px;max-height:300px;overflow:auto}
input{background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:6px;padding:6px 8px;font:inherit}[hidden]{display:none!important}.err{color:#d33}summary{cursor:pointer}code{font-size:12px}
</style></head><body>
<h1>octomate-data · lo que se envía</h1>
<div id="setup" class="card" hidden>
<b>Conectar con OctoMateLabs</b>
<p class="mut" style="margin:6px 0">En OctoMateLabs → <b>Mi consumo</b> → <i>Generar key</i>, y pegala acá.</p>
<form id="sf"><div class="row"><label>Key<br><input id="key" placeholder="omk_..." autocomplete="off" spellcheck="false" style="width:320px"></label></div>
<details><summary class="mut">Avanzado: URL de la API</summary><input id="url" style="width:320px"></details>
<div class="row"><button type="submit" id="sb">Guardar y conectar</button><span id="sm"></span></div></form>
</div>
<div id="st" class="card">Cargando…</div>
<div class="row">
<button id="bp"></button><button id="bm"></button><button id="br">Ver qué se enviaría ahora</button><button id="bs">Actualizar</button>
</div>
<h2 id="t1">Pendiente de enviar (vista previa)</h2><div id="pv" class="mut">Tocá “Ver qué se enviaría ahora”. No se envía nada.</div>
<h2>Últimos enviados</h2><div id="sent"></div>
<script>
const $=id=>document.getElementById(id);
const api=(p,post)=>fetch(p,post?{method:'POST',headers:{'x-octomate-ui':'1'}}:{}).then(r=>r.json());
function ev(e,when){const d=document.createElement('details');d.className='card';
 const s=document.createElement('summary');
 s.textContent=[when||e.occurred_at,e.source,e.model||'-',e.project||'-','in '+e.input_tokens,'out '+e.output_tokens].join(' · ');
 const p=document.createElement('pre');p.textContent=JSON.stringify(e,null,2);d.append(s,p);return d}
async function load(){
 const s=await api('/api/status');
 $('setup').hidden=!!s.key&&!window.__editing;$('url').value=s.url;
 $('st').textContent='';
 const l=(k,v)=>{const x=document.createElement('div');const b=document.createElement('b');b.textContent=k+': ';x.append(b,String(v));$('st').append(x)};
 l('Servidor',s.url);l('Key',s.key||'(falta)');l('Estado',s.paused?'EN PAUSA':'activo');
 l('Modo',s.metadataOnly?'solo métricas (sin prompts ni responses)':'completo (con prompts y responses)');
 l('Intervalo',s.intervalSeconds+'s');l('Claude',s.claudeDir);l('Copilot',s.copilotDir||'desactivado');
 $('bp').textContent=s.paused?'Reanudar envío':'Pausar envío';$('bp').onclick=async()=>{await api('/api/pause?value='+(s.paused?0:1),1);load()};
 $('bm').textContent=s.metadataOnly?'Enviar todo (con texto)':'Enviar solo métricas';$('bm').onclick=async()=>{await api('/api/metadata-only?value='+(s.metadataOnly?0:1),1);load()};
 const sent=await api('/api/sent');$('sent').textContent='';
 if(!sent.length)$('sent').textContent='Todavía no se registró ningún envío.';
 sent.forEach(x=>$('sent').append(ev(x.event,x.sentAt)));
}
$('br').onclick=async()=>{$('pv').textContent='Calculando…';const r=await api('/api/preview');
 $('pv').textContent='';$('t1').textContent='Pendiente de enviar (vista previa): '+r.count;
 if(!r.count)$('pv').textContent='Nada pendiente.';r.events.forEach(e=>$('pv').append(ev(e)))};
$('sf').onsubmit=async e=>{e.preventDefault();$('sb').disabled=true;$('sm').className='mut';$('sm').textContent='Validando…';
 const r=await fetch('/api/config',{method:'POST',headers:{'x-octomate-ui':'1','content-type':'application/json'},body:JSON.stringify({key:$('key').value,url:$('url').value})}).then(r=>r.json());
 $('sb').disabled=false;
 if(!r.ok){$('sm').className='err';$('sm').textContent=r.error;return}
 $('sm').className='ok';$('sm').textContent='✔ Conectado'+(r.label?' ('+r.label+')':'')+(r.setup?(r.serviceError?'. Servicio: '+r.serviceError:'. Quedó corriendo en segundo plano; podés cerrar esta pestaña.'):'');
 $('key').value='';window.__editing=false;load()};
$('bs').onclick=load;load();
</script></body></html>`
