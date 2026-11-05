# octomatelabs-data

Recolector liviano que lee el historial local de **Claude Code** (terminal y VS Code) y de **GitHub Copilot Chat** (VS Code) y lo envía a tu cuenta de [OctoMateLabs](https://octomatelabs.site): tokens, modelos, cache, thinking, subagentes, herramientas y, opcionalmente, request/response.

Setear la key y listo.

## Instalación

```sh
# Linux / macOS
curl -fsSL https://github.com/maxirossi/octomatelabs-data/releases/latest/download/install.sh | sh
# Windows (PowerShell)
irm https://github.com/maxirossi/octomatelabs-data/releases/latest/download/install.ps1 | iex
# Con Node >= 20
npx octomatelabs-data init
```

## Uso

1. En OctoMateLabs → **Mi consumo** → *Generar key*.
2. `octomate-data init` (pega la URL y la key; las valida y las guarda en `~/.octomatelabs/.env`). También podés crear ese `.env` a mano, ver `.env.example`.
3. `octomate-data install-service` para que corra solo al iniciar sesión (systemd de usuario / LaunchAgent / tarea programada).

| Comando | Qué hace |
|---|---|
| `init` | Configura y valida la key |
| `run` | Sincroniza en primer plano cada `SYNC_INTERVAL_SECONDS` (30) |
| `once` | Un solo ciclo |
| `backfill --days N` | Importa el histórico (por defecto 30 días) |
| `preview [--days N]` | Imprime el JSON exacto que se enviaría (ya sanitizado) sin enviar nada |
| `ui [--port N]` | Panel local en `http://localhost:4567`: configuración (key, intervalo, carpetas), pausar/reanudar y ver lo enviado |
| `status` / `ping` | Estado y prueba de conexión |
| `install-service` / `uninstall-service` | Servicio en segundo plano |

## Qué se envía y qué no

- **Primera ejecución:** el histórico existente *no* se envía; solo lo nuevo. Para importarlo: `backfill`.
- **Cifrar información sensible** (checkbox del panel, `REDACT_STRICT`, activado por defecto): además de lo de abajo, corta cualquier valor que parezca una clave (`password: …`, `--token …`, `?api_key=…`, cadenas largas aleatorias) y lo reemplaza por `[REDACTED]`. Es un enmascarado, no un cifrado: el dato original no sale de tu máquina. Desactivarlo deja solo la redacción básica.
- Se redactan localmente secretos (claves `sk-`, JWT, `KEY=…`, contraseñas en URLs, claves PEM…) y el server vuelve a redactar.
- `METADATA_ONLY=true` envía solo métricas, sin prompts ni responses.
- El envío es idempotente (por id de mensaje) y con reintentos: si no hay red, no se pierde nada y no se duplica.

## Desarrollo

```sh
npm ci && npm run typecheck && npm test && npm run build   # dist/cli.mjs
```
Release: `git tag vX.Y.Z && git push --tags` (GitHub Actions compila binarios para Linux, macOS y Windows).

## Transparencia: ver qué se manda

- `octomate-data preview` muestra lo pendiente; no envía ni avanza nada (la primera ejecución no tiene pendiente: el histórico solo sale con `backfill`).
- `~/.octomatelabs/sent.log` (JSONL, permisos 0600, rota a 5 MB) registra cada evento aceptado por el servidor. Incluye prompts salvo con `METADATA_ONLY=true`.
- `octomate-data ui` es un panel solo en `127.0.0.1` (rechaza otros hosts; las escrituras exigen un header propio). Pausar crea `~/.octomatelabs/paused`, que `run` respeta; borrarlo reanuda.

## Fuentes

| Fuente | Dónde lee | Notas |
|---|---|---|
| `claude_code` | `~/.claude/projects/**/*.jsonl` | tokens exactos (input, output, cache, thinking), subagentes con su tipo |
| `copilot` | `<VS Code>/User/workspaceStorage/*/chatSessions/*.jsonl` | Copilot informa tokens por request (input aproximado); modelo, herramientas, subagentes en `raw`. `COPILOT_ENABLED=false` lo desactiva |

Son las mismas fuentes que captura SDD Observatory. Codex CLI queda para más adelante.
