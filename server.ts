/**
 * Backend for the UI. The pipeline needs anvil and a wallet, so it cannot run
 * in the browser — this exposes it over SSE so the page can show real pipeline
 * stages as they complete rather than a spinner.
 */
import express from 'express'
import { loadEnv, requireEnv } from './scripts/env.js'
import { Simulator } from './src/simulate.js'
import { ZgClient } from './src/zg.js'
import { check } from './src/pipeline.js'
import { buildBuyScenario } from './src/scenarios.js'

loadEnv()

const app = express()
app.use(express.json())

const PRESETS = {
  safe: { contract: 'TestToken', name: 'Clean Token', symbol: 'CLN', buyEth: '1' },
  honeypot: { contract: 'HoneypotToken', name: 'Free Airdrop', symbol: 'HNY', buyEth: '0.5' },
  taxed: { contract: 'TaxedToken', name: 'Rewards Token', symbol: 'RWD', buyEth: '0.25' },
} as const

// One shared 0G connection: the ledger and sub-account setup costs a couple of
// on-chain transactions, and we do not want to repeat them per request.
let zgPromise: Promise<ZgClient> | null = null
function getZg(): Promise<ZgClient> {
  if (!zgPromise) {
    zgPromise = (async () => {
      const client = new ZgClient({
        privateKey: requireEnv('PRIVATE_KEY'),
        rpcUrl: process.env.ZG_RPC_URL,
        providerAddress: process.env.ZG_PROVIDER_ADDRESS || undefined,
      })
      await client.connect()
      return client
    })()
  }
  return zgPromise
}

app.get('/api/check', async (req, res) => {
  const preset = String(req.query.preset ?? '')
  if (!(preset in PRESETS)) {
    res.status(400).json({ error: `unknown preset ${preset}` })
    return
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  const sim = new Simulator()
  try {
    send('stage', { stage: 'fork_started' })
    await sim.start()

    const cfg = PRESETS[preset as keyof typeof PRESETS]
    const scenario = await buildBuyScenario(sim, {
      contract: cfg.contract,
      name: cfg.name,
      symbol: cfg.symbol,
      taxBps: 3000,
      buyEth: cfg.buyEth,
    })
    send('intent', {
      ...scenario.intent,
      value: scenario.intent.value.toString(),
      // The token's on-chain name, shown ONLY to make the point that we have it
      // and deliberately do not pass it to the model.
      tokenName: cfg.name,
      tokenAddress: scenario.token,
    })

    const zg = await getZg()
    const result = await check({
      intent: scenario.intent,
      sellVia: scenario.sellVia,
      zg,
      simulator: sim,
      onStage: (stage) => send('stage', { stage }),
    })

    send('result', {
      facts: result.facts,
      verdict: result.verdict,
      record: {
        intentHash: result.record.intentHash,
        teeSignature: result.record.teeSignature,
        teeSignerAddress: result.record.teeSignerAddress,
        attestationReportHash: result.record.attestationReportHash,
        providerAddress: result.record.providerAddress,
        model: result.record.model,
        chatId: result.record.chatId,
        signedText: result.record.signedText,
      },
      verification: result.verification,
    })
  } catch (err) {
    send('error', { message: (err as Error).message })
  } finally {
    await sim.stop()
    res.end()
  }
})

const PORT = Number(process.env.PORT ?? 8787)
app.listen(PORT, () => console.log(`sealed-check api on http://localhost:${PORT}`))
