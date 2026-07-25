import {
  createTestClient,
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  parseAbi,
  encodeFunctionData,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
} from 'viem'
import { foundry } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import type { Intent } from './intent.js'
import { startAnvil, type AnvilHandle } from './anvil.js'
import { compileFixtures } from './compile.js'

/** anvil's first default account — the deployer for all fixtures. */
const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const

export const ERC20_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address,uint256) returns (bool)',
])

const POOL_ABI = parseAbi([
  'function buy(uint256 minOut) payable returns (uint256)',
  'function sell(uint256 amountIn, uint256 minOut) returns (uint256)',
  'function sync()',
  'function token() view returns (address)',
])

/** What the buy leg actually did, before any interpretation. */
export interface SimResult {
  chainId: number
  executionReverted: boolean
  gasUsed: bigint
  /** Signed net movement per asset for `intent.from`. zeroAddress = native ETH. */
  balanceDeltas: Array<{ asset: Address; delta: bigint; decimals: number }>
  approvals: Array<{
    token: Address
    spender: Address
    amount: bigint
    spenderHasCode: boolean
    spenderDeployBlock: number | null
    currentBlock: number
  }>
  sell: {
    outcome: 'ok' | 'reverted' | 'returned_less' | 'not_applicable'
    /** Basis points of the sold amount that never arrived. -1 if unmeasurable. */
    taxBps: number
  }
  /** Kept out of Facts on purpose — for debugging only, never reaches the judge. */
  rawLogs: Log[]
}

export interface SimulationContext {
  /** Venue to attempt the sell-back through. Defaults to `intent.to`. */
  sellVia?: Address
}

export class Simulator {
  private anvil: AnvilHandle | null = null

  get url(): string {
    if (!this.anvil) throw new Error('simulator not started')
    return this.anvil.url
  }

  async start(): Promise<void> {
    if (!this.anvil) this.anvil = await startAnvil()
  }

  async stop(): Promise<void> {
    this.anvil?.stop()
    this.anvil = null
  }

  private clients() {
    const transport = http(this.url)
    return {
      pub: createPublicClient({ chain: foundry, transport }),
      test: createTestClient({ chain: foundry, transport, mode: 'anvil' }),
      wallet: createWalletClient({
        chain: foundry,
        transport,
        account: privateKeyToAccount(DEPLOYER_PK),
      }),
    }
  }

  /** Deploys a fixture contract and returns its address. */
  async deploy(name: string, args: readonly unknown[] = [], value = 0n): Promise<Address> {
    const { pub, wallet } = this.clients()
    const artifact = compileFixtures()[name]
    if (!artifact) throw new Error(`unknown fixture contract ${name}`)
    const hash = await wallet.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: args as never,
      value,
    })
    const receipt = await pub.waitForTransactionReceipt({ hash })
    if (!receipt.contractAddress) throw new Error(`deploy of ${name} produced no address`)
    return receipt.contractAddress
  }

  /** Sends a transaction from the deployer account. Used for fixture setup. */
  async send(to: Address, data: Hex, value = 0n): Promise<void> {
    const { pub, wallet } = this.clients()
    const hash = await wallet.sendTransaction({ to, data, value })
    const receipt = await pub.waitForTransactionReceipt({ hash })
    if (receipt.status === 'reverted') throw new Error(`fixture setup tx reverted: ${to} ${data}`)
  }

  /** Mines empty blocks, so spender-age has something to measure against. */
  async mine(blocks: number): Promise<void> {
    await this.clients().test.mine({ blocks })
  }

  /**
   * Executes an intent on the fork and reports what it did.
   *
   * Everything returned here is measured from execution. No contract metadata
   * is read, and nothing the target contract *says* about itself is trusted.
   */
  async simulate(intent: Intent, ctx: SimulationContext = {}): Promise<SimResult> {
    const { pub, test } = this.clients()

    // Give the sender enough ETH that a revert is never about funds.
    await test.setBalance({ address: intent.from, value: 10n ** 20n })
    await test.impersonateAccount({ address: intent.from })

    const snapshot = await test.snapshot()

    const ethBefore = await pub.getBalance({ address: intent.from })

    let executionReverted = false
    let gasUsed = 0n
    let gasFeePaid = 0n
    let logs: Log[] = []

    try {
      const hash = await test.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: intent.from,
            to: intent.to,
            value: `0x${intent.value.toString(16)}` as Hex,
            data: intent.data,
          },
        ],
      } as never)
      const receipt = await pub.waitForTransactionReceipt({ hash: hash as Hex })
      executionReverted = receipt.status === 'reverted'
      gasUsed = receipt.gasUsed
      gasFeePaid = receipt.gasUsed * receipt.effectiveGasPrice
      logs = receipt.logs
    } catch {
      // A rejected send is a revert as far as the user is concerned.
      executionReverted = true
    }

    const events = parseEventLogs({ abi: ERC20_ABI, logs })

    // ---- balance deltas, measured per touched token ----------------------
    const touched = new Set<Address>()
    for (const e of events) {
      if (e.eventName === 'Transfer') touched.add(e.address.toLowerCase() as Address)
    }

    const balanceDeltas: SimResult['balanceDeltas'] = []
    const ethAfter = await pub.getBalance({ address: intent.from })
    // Report value movement only, with the gas fee exactly cancelled using the
    // price actually paid. This is load-bearing for the security invariant, not
    // a cosmetic choice: a longer attacker-controlled token name makes the
    // token's own deployment cost more gas, which shifts the block base fee,
    // which would otherwise leak the name's length into this number. Cancelling
    // with `effectiveGasPrice` from the receipt removes the channel; cancelling
    // with a separately-fetched `getGasPrice()` does not.
    const ethDelta = ethAfter - ethBefore + gasFeePaid
    if (ethDelta !== 0n) {
      balanceDeltas.push({ asset: zeroAddress, delta: ethDelta, decimals: 18 })
    }

    for (const token of touched) {
      let net = 0n
      for (const e of events) {
        if (e.eventName !== 'Transfer') continue
        if ((e.address.toLowerCase() as Address) !== token) continue
        const { from, to, value } = e.args as { from: Address; to: Address; value: bigint }
        if (to.toLowerCase() === intent.from.toLowerCase()) net += value
        if (from.toLowerCase() === intent.from.toLowerCase()) net -= value
      }
      if (net === 0n) continue
      let decimals = 18
      try {
        decimals = await pub.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: 'decimals',
        })
      } catch {
        // Non-standard token. Assume 18 rather than reading any metadata.
      }
      balanceDeltas.push({ asset: token, delta: net, decimals })
    }

    // ---- approvals --------------------------------------------------------
    const currentBlock = Number(await pub.getBlockNumber())
    const approvals: SimResult['approvals'] = []
    for (const e of events) {
      if (e.eventName !== 'Approval') continue
      const { owner, spender, value } = e.args as {
        owner: Address
        spender: Address
        value: bigint
      }
      if (owner.toLowerCase() !== intent.from.toLowerCase()) continue
      const code = await pub.getCode({ address: spender })
      const hasCode = !!code && code !== '0x'
      approvals.push({
        token: e.address.toLowerCase() as Address,
        spender: spender.toLowerCase() as Address,
        amount: value,
        spenderHasCode: hasCode,
        spenderDeployBlock: hasCode
          ? await this.findDeployBlock(spender, currentBlock)
          : null,
        currentBlock,
      })
    }

    // ---- sell replay: the honeypot check ---------------------------------
    const sell = await this.replaySell(intent, ctx, balanceDeltas)

    await test.revert({ id: snapshot })
    await test.stopImpersonatingAccount({ address: intent.from })

    return {
      chainId: intent.chainId,
      executionReverted,
      gasUsed,
      balanceDeltas,
      approvals,
      sell,
      rawLogs: logs,
    }
  }

  /**
   * Tries to sell back everything the intent acquired, through the same venue.
   *
   * This is ground truth: a token can lie in its name, its symbol, its verified
   * source and its comments, but it cannot lie about refusing the transfer.
   */
  private async replaySell(
    intent: Intent,
    ctx: SimulationContext,
    deltas: SimResult['balanceDeltas'],
  ): Promise<SimResult['sell']> {
    const { pub, test } = this.clients()
    const venue = ctx.sellVia ?? intent.to

    const acquired = deltas.find((d) => d.asset !== zeroAddress && d.delta > 0n)
    if (!acquired) return { outcome: 'not_applicable', taxBps: -1 }

    // Does the venue even look like something we can sell through?
    try {
      const poolToken = await pub.readContract({
        address: venue,
        abi: POOL_ABI,
        functionName: 'token',
      })
      if (poolToken.toLowerCase() !== acquired.asset.toLowerCase()) {
        return { outcome: 'not_applicable', taxBps: -1 }
      }
    } catch {
      return { outcome: 'not_applicable', taxBps: -1 }
    }

    const inner = await test.snapshot()
    try {
      // Approve the venue to pull the tokens back.
      await test.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: intent.from,
            to: acquired.asset,
            data: encodeFunctionData({
              abi: ERC20_ABI,
              functionName: 'approve',
              args: [venue, acquired.delta],
            }),
          },
        ],
      } as never)

      const poolBefore = await pub.readContract({
        address: acquired.asset,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [venue],
      })

      const hash = await test.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: intent.from,
            to: venue,
            data: encodeFunctionData({
              abi: POOL_ABI,
              functionName: 'sell',
              args: [acquired.delta, 0n],
            }),
          },
        ],
      } as never)
      const receipt = await pub.waitForTransactionReceipt({ hash: hash as Hex })

      if (receipt.status === 'reverted') {
        return { outcome: 'reverted', taxBps: -1 }
      }

      // How much actually arrived at the pool versus how much we sent?
      const poolAfter = await pub.readContract({
        address: acquired.asset,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [venue],
      })
      const received = poolAfter - poolBefore
      const shortfall = acquired.delta - received
      const taxBps = Number((shortfall * 10000n) / acquired.delta)

      // A basis point of rounding is not a finding; a real skim is.
      return taxBps > 1
        ? { outcome: 'returned_less', taxBps }
        : { outcome: 'ok', taxBps: Math.max(taxBps, 0) }
    } catch {
      return { outcome: 'reverted', taxBps: -1 }
    } finally {
      await test.revert({ id: inner })
    }
  }

  /**
   * Binary-searches for the block a contract's code first appeared in.
   * Cheap on a short throwaway chain; on a mainnet fork this is bounded by
   * log2(blockNumber) `eth_getCode` calls.
   */
  private async findDeployBlock(address: Address, latest: number): Promise<number | null> {
    const { pub } = this.clients()
    const hasCodeAt = async (block: number) => {
      const code = await pub.getCode({ address, blockNumber: BigInt(block) })
      return !!code && code !== '0x'
    }
    if (!(await hasCodeAt(latest))) return null

    let lo = 0
    let hi = latest
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (await hasCodeAt(mid)) hi = mid
      else lo = mid + 1
    }
    return lo
  }
}
