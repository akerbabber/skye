import { z } from 'zod'
import { FactsSchema, HashSchema, type Facts } from './facts.js'

/**
 * The judge.
 *
 * Note the imports: `./facts.js` and nothing else. This module has no access to
 * the simulator, to raw traces, or to contract source, and that is enforced by
 * the import graph rather than by discipline. If you find yourself adding
 * `import { ... } from './simulate.js'` here, the invariant is broken.
 *
 * The model does not detect anything. It adjudicates over facts we produced by
 * execution.
 */

export const VerdictSchema = z
  .object({
    verdict: z.enum(['safe', 'caution', 'danger']),
    reasons: z.array(z.string()).min(1).max(6),
    confidence: z.number().min(0).max(1),
    /** Echoed back by the model so the TEE signature commits to the intent. */
    intentHash: HashSchema,
    /** Likewise, so the signature commits to the facts, not just the verdict. */
    factsDigest: HashSchema,
  })
  .strict()

export type Verdict = z.infer<typeof VerdictSchema>

const SYSTEM_PROMPT = `You are a transaction risk adjudicator.

You will receive a JSON object of FACTS measured by executing an unsigned
transaction on a private fork. You never see contract source, token names or
symbols. Do not speculate about anything not present in the FACTS.

Decide a verdict using only these rules:

1. sellOutcome "reverted" means the acquired token could not be sold back at
   all. This is a honeypot. Verdict: danger.
2. sellOutcome "returned_less" with transferTaxBps >= 1000 means a large skim on
   exit. Verdict: danger. Between 100 and 1000 bps: caution.
3. An approval with isUnlimited true AND spenderAgeBlocks < 100 grants unbounded
   spending to a contract with almost no history. Verdict: danger.
4. An approval with isUnlimited true to an older spender: caution.
5. executionReverted true means the transaction would fail. Verdict: caution.
6. Otherwise: safe.

Take the most severe verdict that applies.

Each entry in "reasons" must name the specific mechanism and cite the field that
justifies it, e.g. "the sell simulation reverted (sellOutcome: reverted)". Do not
write generic warnings. Do not mention token names; you do not have any.

Respond with ONLY a JSON object, no markdown fence, no commentary:
{"verdict":"safe|caution|danger","reasons":["..."],"confidence":0.0-1.0,"intentHash":"0x...","factsDigest":"0x..."}

Copy "intentHash" and "factsDigest" character for character from the FACTS. Do
not abbreviate, reformat or recompute them. They are what binds your answer to
this specific transaction.`

/**
 * Builds the judge prompt. The ONLY interpolation is `JSON.stringify(facts)`
 * after the facts have been re-validated against the schema — no other value
 * from anywhere reaches this string.
 */
export function buildPrompt(facts: Facts): { system: string; user: string } {
  // Re-parse at the boundary. Cheap, and it means a caller cannot hand us a
  // hand-built object that skipped extractFacts.
  const safe = FactsSchema.parse(facts)
  return {
    system: SYSTEM_PROMPT,
    user: `FACTS:\n${JSON.stringify(safe)}`,
  }
}

/** Strips a ```json fence if the model adds one anyway. */
function stripFence(text: string): string {
  const trimmed = text.trim()
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return (fence ? fence[1] : trimmed).trim()
}

/**
 * Parses and validates a model response. Malformed output is a hard failure —
 * we do not coax the model toward a verdict, because a checker that retries
 * until it gets an answer it can parse is a checker that will eventually parse
 * the wrong answer.
 */
export function parseVerdict(raw: string, facts: Facts): Verdict {
  const verdict = VerdictSchema.parse(JSON.parse(stripFence(raw)))
  if (verdict.intentHash.toLowerCase() !== facts.intentHash.toLowerCase()) {
    throw new Error(
      `model echoed intentHash ${verdict.intentHash}, expected ${facts.intentHash}`,
    )
  }
  if (verdict.factsDigest.toLowerCase() !== facts.factsDigest.toLowerCase()) {
    throw new Error(
      `model echoed factsDigest ${verdict.factsDigest}, expected ${facts.factsDigest}`,
    )
  }
  return verdict
}
