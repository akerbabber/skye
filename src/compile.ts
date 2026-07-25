import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import type { Abi, Hex } from 'viem'

const require = createRequire(import.meta.url)

export interface Compiled {
  abi: Abi
  bytecode: Hex
}

let cache: Record<string, Compiled> | null = null

/**
 * Compiles `fixtures/Fixtures.sol` with the solc npm package. We use solc
 * directly rather than forge so the only external binary this project needs is
 * anvil.
 */
export function compileFixtures(): Record<string, Compiled> {
  if (cache) return cache

  const path = fileURLToPath(new URL('../fixtures/Fixtures.sol', import.meta.url))
  const source = readFileSync(path, 'utf8')

  const solc = require('solc')
  const input = {
    language: 'Solidity',
    sources: { 'Fixtures.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  }

  const output = JSON.parse(solc.compile(JSON.stringify(input)))
  const errors = (output.errors ?? []).filter((e: any) => e.severity === 'error')
  if (errors.length) {
    throw new Error(`solc: ${errors.map((e: any) => e.formattedMessage).join('\n')}`)
  }

  const contracts = output.contracts['Fixtures.sol']
  cache = Object.fromEntries(
    Object.entries(contracts).map(([name, c]: [string, any]) => [
      name,
      { abi: c.abi as Abi, bytecode: `0x${c.evm.bytecode.object}` as Hex },
    ]),
  )
  return cache!
}
