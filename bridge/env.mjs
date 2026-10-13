import { readFileSync } from 'node:fs'

/**
 * Settings from .env.local, for the bridge as well as the page.
 *
 * Vite already reads that file for the browser's VITE_* settings, and asking
 * a Windows user to also export AURORA_* variables in a shell — `set` in cmd,
 * `$env:` in PowerShell, neither of which outlives the window — is how
 * settings get lost. So the bridge reads the same file. Only its own keys are
 * taken, and never one the environment already has: the file cannot change
 * which account Claude Code bills, or override a deliberate export.
 */
export function loadLocalEnv() {
  // .env.local first, so it wins over .env: nothing set is ever overwritten.
  for (const name of ['.env.local', '.env']) {
    let text
    try {
      text = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?((?:AURORA|CAPSULA|ELEVENLABS)_[A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
      if (!m || process.env[m[1]] !== undefined) continue
      const quoted = /^(['"])(.*)\1$/.exec(m[2])
      process.env[m[1]] = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, '')
    }
  }
}
