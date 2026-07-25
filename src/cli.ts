#!/usr/bin/env node
/**
 * sealed-check CLI.
 *
 *   sealed-check --chain <id> --from <addr> --to <addr> --data <hex> --value <wei>
 *   sealed-check --preset honeypot
 *   sealed-check --preset safe
 */
import { isAddress, type Address, type Hex } from 'viem'
import { loadEnv, requireEnv } from '../scripts/env.js'
import { Simulator } from './simulate.js'
import { ZgClient } from './zg.js'
import { check, type Stage } from './pipeline.js'
import { buildBuyScenario } from './scenarios.js'
import { CHAIN_ID } from './anvil.js'
import type { Intent } from './intent.js'

loadEnv()

const USAGE = `sealed-check — simulate an unsigned transaction, adjudicate it inside a TEE.

  sealed-check --chain <id> --from <addr> --to <addr> --data <hex> [--value <wei>] [--nonce <n>]
  sealed-check --preset <safe|honeypot|taxed>

Options:
  --sell-via <addr>   Venue to attempt the sell-back through (default: --to)
  --json              Print the full verdict record as JSON and nothing else
`

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const asJson = args.json === true

if (args.help || Object.keys(args).length === 0) {
  console.log(USAGE)
  process.exit(0)
}

function note(...parts: unknown[]) {
  if (!asJson) console.error(...parts)
}

const STAGE_LABEL: Record<Stage, string> = {
  simulated: 'simulated',
  facts_extracted: 'facts extracted',
  sealed_inference: 'sealed inference',
  verdict_bound: 'verdict bound',
}

const simulator = new Simulator()
await simulator.start()

try {
  // ---- build the intent ----------------------------------------------------
  let intent: Intent
  let sellVia: Address | undefined

  const preset = typeof args.preset === 'string' ? args.preset : null
  if (preset) {
    const contract =
      preset === 'honeypot' ? 'HoneypotToken' : preset === 'taxed' ? 'TaxedToken' : 'TestToken'
    const name = preset === 'honeypot' ? 'Free Airdrop' : 'Clean Token'
    note(`preset: ${preset} — deploying fixture onto the throwaway fork`)
    const scenario = await buildBuyScenario(simulator, {
      contract: contract as 'TestToken' | 'HoneypotToken' | 'TaxedToken',
      name,
      symbol: preset === 'honeypot' ? 'HNY' : 'CLN',
      taxBps: 3000,
      buyEth: preset === 'honeypot' ? '0.5' : preset === 'taxed' ? '0.25' : '1',
    })
    intent = scenario.intent
    sellVia = scenario.sellVia
  } else {
    const from = String(args.from ?? '')
    const to = String(args.to ?? '')
    if (!isAddress(from) || !isAddress(to)) {
      console.error('--from and --to must be valid addresses\n')
      console.error(USAGE)
      process.exit(2)
    }
    intent = {
      chainId: Number(args.chain ?? CHAIN_ID),
      from: from as Address,
      to: to as Address,
      value: BigInt(String(args.value ?? '0')),
      data: (typeof args.data === 'string' ? args.data : '0x') as Hex,
      nonce: Number(args.nonce ?? 0),
    }
    if (typeof args['sell-via'] === 'string') sellVia = args['sell-via'] as Address
  }

  // ---- connect to 0G -------------------------------------------------------
  const zg = new ZgClient({
    privateKey: requireEnv('PRIVATE_KEY'),
    rpcUrl: process.env.ZG_RPC_URL,
    providerAddress: process.env.ZG_PROVIDER_ADDRESS || undefined,
  })
  note('connecting to 0G compute network…')
  const conn = await zg.connect()
  note(`provider ${conn.providerAddress}  model ${conn.model}`)

  // ---- run -----------------------------------------------------------------
  const result = await check({
    intent,
    sellVia,
    zg,
    simulator,
    onStage: (s) => note(`  ✓ ${STAGE_LABEL[s]}`),
  })

  if (asJson) {
    console.log(JSON.stringify(result.record, null, 2))
    process.exit(result.verification.ok ? 0 : 1)
  }

  const badge = result.verdict.verdict.toUpperCase()
  console.log(`\n${badge}  (confidence ${result.verdict.confidence})`)
  for (const reason of result.verdict.reasons) console.log(`  • ${reason}`)

  console.log(`\nintentHash    ${result.record.intentHash}`)
  console.log(`factsDigest   ${result.facts.factsDigest}`)
  console.log(`TEE signer    ${result.record.teeSignerAddress}`)
  console.log(`signature     ${result.record.teeSignature.slice(0, 42)}…`)
  console.log(`RA report     ${result.record.attestationReportHash ?? 'unavailable'}`)
  console.log(
    `verification  ${result.verification.ok ? 'signature verified' : 'FAILED'}` +
      (result.verification.errors.length ? ` — ${result.verification.errors.join('; ')}` : ''),
  )
  console.log('\nThis intent was never sent to a third-party scanner.')
  process.exit(result.verification.ok ? 0 : 1)
} finally {
  await simulator.stop()
}
