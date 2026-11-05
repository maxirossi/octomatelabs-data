import fs from 'node:fs'
import http from 'node:http'
import { ENV_PATH, HOME_DIR, PAUSE_PATH, STATE_PATH, loadConfig, parseEnv } from './config.ts'
import { tailSent } from './sentlog.ts'
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

export function startUi(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
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
        if (url.pathname === '/api/metadata-only') {
          setEnvVar('METADATA_ONLY', url.searchParams.get('value') === '1' ? 'true' : 'false')
          return json(res, 200, status())
        }
      }
      json(res, 404, { error: 'no encontrado' })
    } catch (e) { json(res, 500, { error: (e as Error).message }) }
  })
  server.listen(port, '127.0.0.1')
  return server
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
summary{cursor:pointer}code{font-size:12px}
</style></head><body>
<h1>octomate-data · lo que se envía</h1>
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
$('bs').onclick=load;load();
</script></body></html>`
