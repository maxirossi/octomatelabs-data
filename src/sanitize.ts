// Redacción de secretos antes de salir de la máquina. Mismos patrones que el server (defensa en profundidad).
const PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]
const CONN = /(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/]+:[^@\s]+@/gi
const ENV_LINE = /^(\s*[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*\s*=\s*).+$/gim

export const MAX_TEXT = 100_000

export function redact(text: string | null | undefined): string | null {
  if (!text) return text ?? null
  let out = text
  for (const p of PATTERNS) out = out.replace(p, '[REDACTED]')
  out = out.replace(CONN, '$1://[REDACTED]@').replace(ENV_LINE, '$1[REDACTED]')
  return out.slice(0, MAX_TEXT)
}

// Modo estricto ("Cifrar información sensible"): corta además cualquier valor que parezca secreto aunque no
// tenga un formato conocido. Prefiere de más: un falso positivo oculta un texto, un falso negativo filtra una clave.
const NAMES = 'api[_-]?key|apikey|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|auth(?:orization)?|passw(?:or)?d|pwd|passphrase|private[_-]?key|access[_-]?key|credential|[A-Za-z0-9_]key'
const STRICT: Array<[RegExp, string]> = [
  // nombre: valor / nombre=valor / "nombre": "valor" (cualquier mayúscula/minúscula, con o sin comillas)
  [new RegExp(`((?:[A-Za-z0-9_.-]*(?:${NAMES})[A-Za-z0-9_.-]*)["']?\\s*[:=]\\s*["']?)(?!\\[REDACTED\\])[^\\s"',;&)}\\]]{4,}`, 'gi'), '$1[REDACTED]'],
  // flags de CLI: --password x, --token=x, --api-key x
  [new RegExp(`(--(?:[a-z-]*(?:${NAMES})[a-z-]*)[ =])(?!\\[REDACTED\\])[^\\s]+`, 'gi'), '$1[REDACTED]'],
  // query strings con credenciales
  [/([?&](?:access_token|token|key|api_key|apikey|secret|sig|signature|password)=)[^&\s"']+/gi, '$1[REDACTED]'],
  // prefijos de tokens conocidos
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|\bnpm_[A-Za-z0-9]{30,}|\bglpat-[A-Za-z0-9_-]{15,}|\bAPP_USR-[0-9A-Za-z-]{20,}|\bomk_[A-Za-z0-9_-]{20,}|\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  // cadenas largas de aspecto aleatorio (>=32, con letras y dígitos, no son un hash hex en minúscula como un SHA de git)
  [/(?<![A-Za-z0-9_/.-])[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_/.-])/g, '__LONG__'],
]

export function redactStrict(text: string | null | undefined): string | null {
  const base = redact(text)
  if (!base) return base
  let out = base
  for (const [re, rep] of STRICT) {
    out = out.replace(re, (...m) => {
      if (rep !== '__LONG__') return rep.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? '')
      const t = m[0] as string
      const random = /[0-9]/.test(t) && /[A-Za-z]/.test(t) && !/^[0-9a-f]+$/.test(t)
      return random ? '[REDACTED]' : t
    })
  }
  return out
}
