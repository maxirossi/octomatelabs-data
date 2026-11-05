import fs from 'node:fs'
import http from 'node:http'
import { ENV_PATH, HOME_DIR, PAUSE_PATH, STATE_PATH, loadConfig } from './config.ts'
import { LOGO_DATA_URI } from './logo.ts'
import { ping } from './sender.ts'
import { tailSent } from './sentlog.ts'
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
    url: cfg.url, hasKey: !!cfg.key, keyPreview: cfg.key ? cfg.key.slice(0, 12) + '…' : null, metadataOnly: cfg.metadataOnly, strictRedact: cfg.strictRedact,
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
  const interval = Number(b.intervalSeconds)
  const claudeDir = expandHome(String(b.claudeDir ?? '').trim())
  const copilotEnabled = b.copilotEnabled === true
  const strictRedact = b.strictRedact !== false
  const copilotDir = expandHome(String(b.copilotDir ?? '').trim())

  if (!key) errors.key = 'Falta la key'
  else if (!key.startsWith('omk_')) errors.key = 'La key tiene que empezar con omk_'
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
  if (key !== cur.key || url !== cur.url) {
    const r = await ping(url, key)
    if (!r.ok) return { ok: false, errors: { key: `No se pudo validar (${r.status || 'sin conexión con ' + url}${r.error ? ': ' + r.error : ''})` } }
    label = r.label ?? null
  }
  setEnvVars({
    OCTOMATELABS_URL: url, OCTOMATELABS_KEY: key, SYNC_INTERVAL_SECONDS: String(interval), CLAUDE_PROJECTS_DIR: claudeDir,
    COPILOT_ENABLED: String(copilotEnabled), REDACT_STRICT: String(strictRedact), ...(copilotDir ? { COPILOT_STORAGE_DIR: copilotDir } : {}),
  })
  return { ok: true, label }
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
input[type=text],input[type=password],input[type=number]{width:100%;background:var(--inp);color:var(--fg);border:1px solid var(--bd);border-radius:8px;padding:9px 11px;font:inherit}
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
#msg{font-size:13px}#msg.ok{color:var(--ok)}#msg.bad{color:var(--err)}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
details.ev{border:1px solid var(--bd);border-radius:10px;padding:8px 12px;margin:6px 0;background:var(--card)}
details.ev summary{cursor:pointer;font-size:13px}
pre{white-space:pre-wrap;word-break:break-word;margin:8px 0 0;font-size:12px;max-height:300px;overflow:auto}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:6px 0}.stats div{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:10px 14px}.stats b{display:block;font-size:20px}.stats span{color:var(--mut);font-size:12px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--ok);margin-right:6px;animation:pl 1.6s infinite}@keyframes pl{50%{opacity:.25}}
details.ev.new{border-color:var(--ac);animation:fl 2.5s}@keyframes fl{from{background:rgba(124,92,240,.25)}}
h3{font-size:14px;margin:22px 0 6px}.mut{color:var(--mut)}[hidden]{display:none!important}
</style></head><body><div class="wrap">
<header><img src="${LOGO_DATA_URI}" alt="OctoMateLabs"><div><h1>OctoMateLabs · Recolector</h1><p>Configuración y envíos en vivo.</p></div><span id="pill" class="pill">…</span></header>

<form id="sf" class="card" autocomplete="off" novalidate>
<h2>Conexión y fuentes</h2><p class="sub" id="subt">En OctoMateLabs → <b>Mi consumo</b> → <i>Generar key</i>, y pegala acá.</p>
<div class="grid">
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

<div class="actions"><button id="bp"></button><button id="bs">Actualizar</button></div>
<div class="stats"><div><b id="n-total">0</b><span>enviados (últimos 100)</span></div><div><b id="n-last">-</b><span>último envío</span></div><div><b id="n-tok">0</b><span>tokens out (visibles)</span></div></div>
<h3><span class="dot"></span> En vivo · lo que se está enviando</h3><div id="sent" class="mut"></div>
</div>
<script>
const $=id=>document.getElementById(id);
const H={'x-octomate-ui':'1','content-type':'application/json'};
const get=p=>fetch(p).then(r=>r.json());
const post=(p,b)=>fetch(p,{method:'POST',headers:H,body:b?JSON.stringify(b):undefined}).then(r=>r.json());
const FIELDS=['key','intervalSeconds','claudeDir','copilotDir'];
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
 if(fill){$('url').value=S.url;$('intervalSeconds').value=S.intervalSeconds;$('claudeDir').value=S.claudeDir;$('copilotDir').value=S.copilotDir||'';
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
 let r;try{r=await post('/api/settings',{key:$('key').value,intervalSeconds:Number($('intervalSeconds').value),claudeDir:$('claudeDir').value,
  copilotEnabled:$('copilotEnabled').checked,strictRedact:$('strictRedact').checked,copilotDir:$('copilotDir').value})}catch(x){r={ok:false,errors:{},error:String(x)}}
 $('sb').disabled=false;
 if(!r.ok){Object.entries(r.errors||{}).forEach(([f,m])=>mark(f,m));$('msg').className='bad';$('msg').textContent='Revisá los campos marcados.';const b=document.querySelector('.bad');if(b)b.focus();return}
 $('msg').className='ok';$('msg').textContent='✔ Guardado'+(r.label?' · key "'+r.label+'"':'')+(r.setup?(r.serviceError?' · Servicio: '+r.serviceError:' · Quedó corriendo en segundo plano; en unos segundos te llevo al panel en vivo (http://localhost:4567).'):' · se aplica en el próximo ciclo.');
 $('key').value='';load(true);if(r.setup&&!r.serviceError)setTimeout(()=>{location.href='http://localhost:4567'},7000)};
$('bp').onclick=async()=>{await post('/api/pause?value='+(S.paused?0:1));load(false)};
$('bs').onclick=()=>{load(false);live()};load(true);live();setInterval(()=>{load(false);live()},3000);
</script></body></html>`
