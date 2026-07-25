/** Prints the Facts each fixture scenario produces. Block 1 acceptance check. */
import { Simulator } from '../src/simulate.js'
import { extractFacts } from '../src/extract.js'
import { buildBuyScenario, buildApprovalScenario } from '../src/scenarios.js'

async function run(label: string, build: (s: Simulator) => Promise<any>) {
  const sim = new Simulator()
  await sim.start()
  try {
    const scenario = await build(sim)
    const result = await sim.simulate(scenario.intent, { sellVia: scenario.sellVia })
    console.log(`\n=== ${label} ===`)
    console.log(JSON.stringify(extractFacts(result, scenario.intent), null, 2))
  } finally {
    await sim.stop()
  }
}

await run('CLEAN buy (ordinary ERC-20)', (s) =>
  buildBuyScenario(s, { contract: 'TestToken', name: 'Clean Token', symbol: 'CLN' }),
)
await run('HONEYPOT buy (sell reverts)', (s) =>
  buildBuyScenario(s, { contract: 'HoneypotToken', name: 'Free Airdrop', symbol: 'HNY' }),
)
await run('TAXED buy (30% skim on sell)', (s) =>
  buildBuyScenario(s, { contract: 'TaxedToken', name: 'Taxed', symbol: 'TAX', taxBps: 3000 }),
)
await run('UNLIMITED approval to fresh spender', (s) =>
  buildApprovalScenario(s, { unlimited: true, aged: false }),
)
await run('BOUNDED approval to aged spender', (s) =>
  buildApprovalScenario(s, { unlimited: false, aged: true }),
)
