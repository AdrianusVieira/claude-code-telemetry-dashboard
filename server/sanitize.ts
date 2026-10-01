const HIDDEN = '[REDACTED]'
const MAX_PROMPT_LENGTH = 16_000

// This is deliberately conservative: a false positive hides useful context,
// while a false negative would persist a credential.
export function sanitizePrompt(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value === '<REDACTED>') return null
  if (value.length > MAX_PROMPT_LENGTH) return '[PROMPT OMITTED: TOO LONG]'

  let text = value.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, HIDDEN)
  text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, `${HIDDEN}`)
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, HIDDEN)
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, HIDDEN)
  text = text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${HIDDEN}@`)
  text = text.replace(/([?&](?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|token|senha)=)[^\s&#]+/gi, `$1${HIDDEN}`)
  text = text.replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|private[_-]?key|password|passwd|pwd|secret|token|senha|segredo|credential|credencial)(?:["']?))[ \t]*(?::|=|=>|é(?=[ \t])|is(?=[ \t]))[ \t]*(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\r\n]+)/gi, `$1=${HIDDEN}`)
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL REDACTED]')
  text = text.replace(/\b\d{3}[. -]?\d{3}[. -]?\d{3}[- ]?\d{2}\b|\b\d{2}[. -]?\d{3}[. -]?\d{3}[/-]?\d{4}[- ]?\d{2}\b/g, '[ID REDACTED]')
  text = text.replace(/\b(?:\+?55[\s-]?)?\(?\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}\b/g, '[PHONE REDACTED]')
  text = text.replace(/\b(?:\d[ -]?){13,19}\b/g, '[NUMBER REDACTED]')
  text = text.replace(/[A-Za-z0-9+/_=-]{16,}/g, (candidate) => {
    if (candidate.includes('REDACTED') || candidate.includes('OMITTED')) return candidate
    const hasLetters = /[A-Za-z]/.test(candidate)
    const hasDigits = /\d/.test(candidate)
    const hasSymbols = /[+/_=-]/.test(candidate)
    return (hasLetters && hasDigits && (candidate.length >= 16 || hasSymbols)) ||
      (candidate.length >= 40 && hasLetters) ? HIDDEN : candidate
  })
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim() || null
}
