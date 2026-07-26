/**
 * Records the demo video.
 *
 * Drives the real UI in a real browser against the real backend — the honeypot
 * verdict on screen comes from an actual sealed inference on 0G, not a mockup.
 * Playwright records the page via CDP screencast, so no X server is needed.
 *
 * Terminal beats are rendered into the same browser so the whole film has one
 * look; the text in them is captured from real command output at record time
 * by scripts/capture-cli.ts, never hand-written.
 *
 * Output: media/raw/*.webm  (stitched and captioned by scripts/build-video.sh)
 */
import { chromium } from 'playwright-core'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const OUT = resolve('media/raw')
const UI = process.env.UI_URL ?? 'http://localhost:5173'
const VIEWPORT = { width: 1280, height: 720 }

mkdirSync(OUT, { recursive: true })

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
})

async function record(name: string, body: (page: any) => Promise<void>) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: OUT, size: VIEWPORT },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  try {
    await body(page)
  } finally {
    await page.close()
    const video = page.video()
    if (video) {
      await video.saveAs(`${OUT}/${name}.webm`)
    }
    await context.close()
  }
  console.log(`recorded ${name}`)
}

/** Renders captured terminal output as a styled page, for the CLI beats. */
function terminalPage(title: string, body: string): string {
  const escaped = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0d1117;color:#e6edf3;
      font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
    .wrap{padding:36px 44px}
    .title{color:#8b949e;font-size:13px;letter-spacing:.09em;text-transform:uppercase;
      margin-bottom:18px}
    pre{margin:0;white-space:pre-wrap}
    .g{color:#3fb950}.r{color:#f85149}.b{color:#58a6ff}.d{color:#8b949e}
  </style><div class="wrap"><div class="title">${title}</div><pre id="t"></pre></div>
  <script>
    const text = ${JSON.stringify(escaped)};
    const el = document.getElementById('t');
    let i = 0;
    // Type it out so the viewer's eye can follow rather than being hit with a wall.
    const tick = () => {
      i = Math.min(text.length, i + 14);
      el.innerHTML = text.slice(0, i)
        .replace(/(✓|SIGNATURE OK|signature verified|SAFE)/g, '<span class="g">$1</span>')
        .replace(/(DANGER|reverted|FAILED)/g, '<span class="r">$1</span>')
        .replace(/(0x[0-9a-fA-F]{8,})/g, '<span class="b">$1</span>');
      if (i < text.length) requestAnimationFrame(tick);
    };
    tick();
  </script>`
}

function captured(file: string, fallback: string): string {
  const path = resolve('media/captured', file)
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : fallback
}

// ---------------------------------------------------------------------------
// 1. The honeypot, caught live.
// ---------------------------------------------------------------------------
await record('01-honeypot', async (page) => {
  await page.goto(UI, { waitUntil: 'networkidle' })
  await wait(2500)
  await page.getByRole('button', { name: /honeypot/i }).click()
  // Let the real pipeline run: fork, simulate, sealed inference, binding.
  await page.waitForSelector('.badge.danger', { timeout: 180_000 })
  await wait(2000)
  await page.evaluate(() => window.scrollTo({ top: 400, behavior: 'smooth' }))
  await wait(3500)
})

// ---------------------------------------------------------------------------
// 2. The clean trade that does not leak — attestation panel gets the time.
// ---------------------------------------------------------------------------
await record('02-safe', async (page) => {
  await page.goto(UI, { waitUntil: 'networkidle' })
  await wait(1200)
  await page.getByRole('button', { name: /safe example/i }).click()
  await page.waitForSelector('.badge.safe', { timeout: 180_000 })
  await wait(1800)
  await page.evaluate(() => document.querySelector('.attest')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  await wait(5000)
})

// ---------------------------------------------------------------------------
// 3. The invariant — the facts panel, and the injection test passing.
// ---------------------------------------------------------------------------
await record('03-invariant', async (page) => {
  await page.goto(UI, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /honeypot/i }).click()
  await page.waitForSelector('.badge.danger', { timeout: 180_000 })
  await page.evaluate(() => document.querySelector('.facts')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  await wait(5500)
})

await record('04-tests', async (page) => {
  await page.setContent(
    terminalPage(
      'the invariant, enforced by tests',
      captured('tests.txt', '(test output not captured)'),
    ),
  )
  await wait(9000)
})

// ---------------------------------------------------------------------------
// 4. The gate: sealed inference and signature verification, from the terminal.
// ---------------------------------------------------------------------------
await record('05-verify', async (page) => {
  await page.setContent(
    terminalPage(
      'pnpm verify:0g — live 0G testnet',
      captured('verify.txt', '(verify output not captured)'),
    ),
  )
  await wait(10000)
})

await browser.close()
console.log(`\nraw clips in ${OUT}`)
