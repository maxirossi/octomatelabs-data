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
