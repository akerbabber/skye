import { encodeFunctionData, parseEther, parseAbi, type Address } from 'viem'
import { Simulator } from './simulate.js'
import type { Intent } from './intent.js'
import { CHAIN_ID } from './anvil.js'

const TOKEN_ADMIN_ABI = parseAbi([
  'function setPair(address)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
])

const POOL_ABI = parseAbi(['function sync()', 'function buy(uint256) payable returns (uint256)'])

/** A user address with no special role. Fixed so runs are reproducible. */
export const USER: Address = '0x1111111111111111111111111111111111111111'

export interface Scenario {
  intent: Intent
  sellVia: Address
  token: Address
  pool: Address
}

/**
 * Builds a buy-a-token scenario on a fresh chain.
 *
 * `contract` selects the token's behaviour; `name` is deliberately a parameter
 * because the injection test needs two runs that differ *only* in the token's
 * attacker-controlled name.
 */
export async function buildBuyScenario(
  sim: Simulator,
  opts: {
    contract: 'TestToken' | 'HoneypotToken' | 'TaxedToken'
    name: string
    symbol?: string
    taxBps?: number
    /** Buy size. Varies per preset so each demo run has a distinct intentHash. */
    buyEth?: string
  },
): Promise<Scenario> {
  const supply = parseEther('1000000')
  const args: unknown[] = [opts.name, opts.symbol ?? 'TKN', supply]
  if (opts.contract === 'TaxedToken') args.push(BigInt(opts.taxBps ?? 3000))

  const token = await sim.deploy(opts.contract, args)
  const pool = await sim.deploy('MiniPool', [token], parseEther('10'))

  if (opts.contract !== 'TestToken') {
    await sim.send(token, encodeFunctionData({
      abi: TOKEN_ADMIN_ABI,
      functionName: 'setPair',
      args: [pool],
    }))
  }

  // Seed the pool with tokens, then let it record its reserves.
  await sim.send(token, encodeFunctionData({
    abi: TOKEN_ADMIN_ABI,
    functionName: 'transfer',
    args: [pool, parseEther('500000')],
  }))
  await sim.send(pool, encodeFunctionData({ abi: POOL_ABI, functionName: 'sync' }))

  return {
    token,
    pool,
    sellVia: pool,
    intent: {
      chainId: CHAIN_ID,
      from: USER,
      to: pool,
      value: parseEther(opts.buyEth ?? '1'),
      data: encodeFunctionData({ abi: POOL_ABI, functionName: 'buy', args: [0n] }),
      nonce: 0,
    },
  }
}

/**
 * An unlimited approval to a spender deployed moments ago — the other check.
 * `aged` controls whether the spender has any history behind it.
 */
export async function buildApprovalScenario(
  sim: Simulator,
  opts: { unlimited: boolean; aged: boolean },
): Promise<Scenario> {
  const MAX = 2n ** 256n - 1n

  let spender: Address
  if (opts.aged) {
    // Deploy the spender first, then mine history on top of it.
    spender = await sim.deploy('BoringRouter')
    await sim.mine(500)
  } else {
    await sim.mine(500)
    spender = await sim.deploy('BoringRouter')
  }

  const token = await sim.deploy('TestToken', ['Fixture Token', 'FIX', parseEther('1000000')])

  return {
    token,
    pool: spender,
    sellVia: spender,
    intent: {
      chainId: CHAIN_ID,
      from: USER,
      to: token,
      value: 0n,
      data: encodeFunctionData({
        abi: TOKEN_ADMIN_ABI,
        functionName: 'approve',
        args: [spender, opts.unlimited ? MAX : parseEther('100')],
      }),
      nonce: 0,
    },
  }
}
