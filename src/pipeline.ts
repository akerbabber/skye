import { Simulator } from './simulate.js'
import { extractFacts } from './extract.js'
import { buildPrompt, parseVerdict, type Verdict } from './judge.js'
import { ZgClient } from './zg.js'
import { buildRecord, verify, type VerdictRecord, type VerificationOutcome } from './attest.js'
import type { Intent } from './intent.js'
import type { Facts } from './facts.js'
import type { Address } from 'viem'

export type Stage = 'simulated' | 'facts_extracted' | 'sealed_inference' | 'verdict_bound'

export interface CheckResult {
  facts: Facts
  verdict: Verdict
  record: VerdictRecord
  verification: VerificationOutcome
}

export interface CheckOptions {
  intent: Intent
  /** Venue to attempt the sell-back through. Defaults to `intent.to`. */
  sellVia?: Address
  zg: ZgClient
  /** Reuse a started simulator; otherwise one is started and stopped here. */
  simulator?: Simulator
  onStage?: (stage: Stage) => void
}

/**
 * The whole pipeline: simulate → facts → sealed inference → bound verdict.
 */
export async function check(options: CheckOptions): Promise<CheckResult> {
  const { intent, zg, onStage } = options
  const sim = options.simulator ?? new Simulator()
  const ownsSimulator = !options.simulator

  try {
    if (ownsSimulator) await sim.start()

    const simResult = await sim.simulate(intent, { sellVia: options.sellVia })
    onStage?.('simulated')

    const facts = extractFacts(simResult, intent)
    onStage?.('facts_extracted')

    // From here on, `simResult` is out of scope by convention and `facts` is
    // the only thing that travels. Nothing below reads a trace or a log.
    const { system, user } = buildPrompt(facts)

    let sealed = await zg.infer(system, user)
    let verdict: Verdict
    try {
      verdict = parseVerdict(sealed.content, facts)
    } catch (first) {
      // Exactly one retry, then fail loudly. We do not coax the model toward
      // an answer we can parse — that road ends in parsing the wrong answer.
      sealed = await zg.infer(system, user)
      try {
        verdict = parseVerdict(sealed.content, facts)
      } catch (second) {
        throw new Error(
          `judge returned unusable output twice.\n` +
            `first:  ${(first as Error).message}\n` +
            `second: ${(second as Error).message}\n` +
            `raw:    ${sealed.content.slice(0, 500)}`,
        )
      }
    }
    onStage?.('sealed_inference')

    const record = buildRecord({
      facts,
      verdict,
      signedText: sealed.signedText,
      responseJson: sealed.responseJson,
      teeSignature: sealed.teeSignature,
      teeSignerAddress: sealed.teeSignerAddress,
      attestationReportHash: sealed.attestationReportHash,
      providerAddress: sealed.providerAddress,
      model: sealed.model,
      chatId: sealed.chatId,
    })
    const verification = verify(record, intent)
    onStage?.('verdict_bound')

    return { facts, verdict, record, verification }
  } finally {
    if (ownsSimulator) await sim.stop()
  }
}
