import { FactsSchema, computeFactsDigest, type Facts } from './facts.js'
import { intentHash, type Intent } from './intent.js'
import type { SimResult } from './simulate.js'

/** amount >= type(uint256).max / 2 is unbounded in every practical sense. */
const UNLIMITED_THRESHOLD = (2n ** 256n - 1n) / 2n

/**
 * The narrow gate. Everything downstream of this function sees only `Facts`.
 *
 * Note what is NOT copied across: `rawLogs`, contract metadata, token names,
 * symbols, revert strings. Revert *strings* are attacker-controlled too — a
 * honeypot can revert with "SAFE: audited by CertiK". So the sell outcome
 * crosses this boundary as an enum, never as the revert reason.
 */
export function extractFacts(sim: SimResult, intent: Intent): Facts {
  const withoutDigest: Omit<Facts, 'factsDigest'> = {
    schemaVersion: 1,
    intentHash: intentHash(intent).toLowerCase(),
    chainId: sim.chainId,
    executionReverted: sim.executionReverted,
    balanceDeltas: sim.balanceDeltas.map((d) => ({
      asset: d.asset.toLowerCase(),
      delta: d.delta.toString(),
      decimals: d.decimals,
    })),
    approvals: sim.approvals.map((a) => ({
      token: a.token.toLowerCase(),
      spender: a.spender.toLowerCase(),
      amount: a.amount.toString(),
      isUnlimited: a.amount >= UNLIMITED_THRESHOLD,
      spenderAgeBlocks:
        a.spenderDeployBlock === null ? -1 : a.currentBlock - a.spenderDeployBlock,
      spenderHasCode: a.spenderHasCode,
    })),
    sellOutcome: sim.sell.outcome,
    transferTaxBps: sim.sell.taxBps,
    gasUsed: Number(sim.gasUsed),
  }

  // Parse, do not merely validate: zod's .strict() drops nothing silently, it
  // throws. If a field ever appears that the schema does not know about, this
  // is where the build breaks — which is the intent.
  return FactsSchema.parse({
    ...withoutDigest,
    factsDigest: computeFactsDigest(withoutDigest),
  })
}
