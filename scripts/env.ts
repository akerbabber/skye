/** Minimal .env loader — no dotenv dependency. Existing process env wins. */
import { readFileSync } from 'node:fs'

export function loadEnv(path = '.env'): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

export function requireEnv(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`missing env var ${key} — copy .env.example to .env and fill it in`)
  return v
}
