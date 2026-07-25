import { createHash } from 'node:crypto'
import { verifyMessage } from 'ethers'
import { responseDigestFromSignedText } from './zg.js'
import { FactsSchema, computeFactsDigest, type Facts } from './facts.js'
import { VerdictSchema, type Verdict } from './judge.js'
import { intentHash, type Intent } from './intent.js'
import { z } from 'zod'

/**
 * The artefact a user walks away with: a verdict, the facts it was reached
 * over, and a TEE signature binding both to one specific transaction.
 */
export const VerdictRecordSchema = z
  .object({
    intentHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    facts: FactsSchema,
    verdict: VerdictSchema,
    /**
     * The exact bytes the enclave signed:
     * `<requestDigest>:<responseDigest>:<providerType>:<vendor>:<...>`.
     */
    signedText: z.string(),
    /** The provider's response body. sha256 of this appears in `signedText`. */
    responseJson: z.string(),
    teeSignature: z.string().regex(/^0x[0-9a-fA-F]+$/),
    teeSignerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    attestationReportHash: z.string().nullable(),
    providerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    model: z.string(),
    chatId: z.string(),
  })
  .strict()

export type VerdictRecord = z.infer<typeof VerdictRecordSchema>

export interface VerificationOutcome {
  ok: boolean
  checks: {
    /** The record is structurally a VerdictRecord. */
    schema: boolean
    /** facts.intentHash agrees with record.intentHash. */
    factsBound: boolean
    /** The signature recovers to the provider's registered TEE signer. */
    signature: boolean
    /** sha256(responseJson) is the response digest inside the signed text. */
    responseDigest: boolean
    /** The response body really does contain this verdict. */
    verdictMatchesSignedText: boolean
    /** The signed verdict names this intent. */
    intentBound: boolean
    /** The signed verdict commits to a digest of exactly these facts. */
    factsBoundToSignature: boolean
    /** Only when the caller supplies the original intent. */
    intentHashRecomputed: boolean | null
  }
  recoveredSigner: string | null
  errors: string[]
}

/**
 * Verifies a record end to end.
 *
 * The chain of custody is: the enclave signs the model's response bytes; those
 * bytes contain the verdict AND the intent hash; the intent hash is recomputed
 * from the transaction itself. Break any link and this returns ok: false.
 *
 * What this does NOT establish: that the verdict is correct. See the README.
 */
export function verify(record: unknown, intent?: Intent): VerificationOutcome {
  const errors: string[] = []
  const checks: VerificationOutcome['checks'] = {
    schema: false,
    factsBound: false,
    signature: false,
    responseDigest: false,
    verdictMatchesSignedText: false,
    intentBound: false,
    factsBoundToSignature: false,
    intentHashRecomputed: null,
  }
  let recoveredSigner: string | null = null

  const parsed = VerdictRecordSchema.safeParse(record)
  if (!parsed.success) {
    errors.push(`schema: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`)
    return { ok: false, checks, recoveredSigner, errors }
  }
  checks.schema = true
  const r = parsed.data

  // 1. The facts must claim the same intent as the record, and their digest
  //    must actually be the digest of these facts.
  const digestOk = computeFactsDigest(r.facts) === r.facts.factsDigest.toLowerCase()
  if (!digestOk) errors.push('facts.factsDigest is not the digest of facts')
  checks.factsBound =
    digestOk && r.facts.intentHash.toLowerCase() === r.intentHash.toLowerCase()
  if (digestOk && !checks.factsBound) {
    errors.push('facts.intentHash does not match record.intentHash')
  }

  // 2. The signature must come from the provider's registered TEE signer.
  try {
    recoveredSigner = verifyMessage(r.signedText, r.teeSignature)
    checks.signature = recoveredSigner.toLowerCase() === r.teeSignerAddress.toLowerCase()
    if (!checks.signature) {
      errors.push(`signature recovers to ${recoveredSigner}, not ${r.teeSignerAddress}`)
    }
  } catch (err) {
    errors.push(`signature malformed: ${(err as Error).message}`)
  }

  // 3. The signed text commits to a digest of the response body. Recompute it.
  //    This is the link between the signature and the model's actual words:
  //    without it, an attacker keeps a valid signature and swaps the response.
  const claimedDigest = responseDigestFromSignedText(r.signedText)
  if (!claimedDigest) {
    errors.push(`signed text has no response digest: ${r.signedText.slice(0, 80)}`)
  } else {
    const actual = createHash('sha256').update(r.responseJson).digest('hex')
    checks.responseDigest = actual === claimedDigest
    if (!checks.responseDigest) {
      errors.push(`sha256(responseJson) = ${actual}, signed text claims ${claimedDigest}`)
    }
  }

  // 4. The response body must actually contain the verdict in the record.
  try {
    const body = JSON.parse(r.responseJson)
    const content: string = body.choices?.[0]?.message?.content ?? ''
    const fence = content.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
    const signedVerdict = VerdictSchema.parse(JSON.parse((fence ? fence[1] : content).trim()))
    checks.verdictMatchesSignedText =
      signedVerdict.verdict === r.verdict.verdict &&
      Math.abs(signedVerdict.confidence - r.verdict.confidence) < 1e-9 &&
      JSON.stringify(signedVerdict.reasons) === JSON.stringify(r.verdict.reasons)
    if (!checks.verdictMatchesSignedText) {
      errors.push('verdict in record differs from the verdict inside the signed text')
    }
    // 5. And the signed verdict must name this intent...
    checks.intentBound = signedVerdict.intentHash.toLowerCase() === r.intentHash.toLowerCase()
    if (!checks.intentBound) errors.push('signed verdict names a different intentHash')

    // 6. ...and commit to these exact facts. The enclave's own request digest
    //    (field 0 of the signed text) also covers the prompt, but we cannot
    //    reproduce its serialisation, so the model echoing the digest is what
    //    we actually verify.
    checks.factsBoundToSignature =
      signedVerdict.factsDigest.toLowerCase() === r.facts.factsDigest.toLowerCase()
    if (!checks.factsBoundToSignature) {
      errors.push('signed verdict commits to a different factsDigest')
    }
  } catch (err) {
    errors.push(`response body does not contain a valid verdict: ${(err as Error).message}`)
  }

  // 7. If we were given the original transaction, recompute the hash from it.
  if (intent) {
    const recomputed = intentHash(intent).toLowerCase()
    checks.intentHashRecomputed = recomputed === r.intentHash.toLowerCase()
    if (!checks.intentHashRecomputed) {
      errors.push(`recomputed intentHash ${recomputed} does not match record`)
    }
  }

  const ok =
    checks.schema &&
    checks.factsBound &&
    checks.signature &&
    checks.responseDigest &&
    checks.verdictMatchesSignedText &&
    checks.intentBound &&
    checks.factsBoundToSignature &&
    checks.intentHashRecomputed !== false

  return { ok, checks, recoveredSigner, errors }
}

/** Assembles a record from its parts. */
export function buildRecord(args: {
  facts: Facts
  verdict: Verdict
  signedText: string
  responseJson: string
  teeSignature: string
  teeSignerAddress: string
  attestationReportHash: string | null
  providerAddress: string
  model: string
  chatId: string
}): VerdictRecord {
  return VerdictRecordSchema.parse({
    intentHash: args.facts.intentHash,
    facts: args.facts,
    verdict: args.verdict,
    signedText: args.signedText,
    responseJson: args.responseJson,
    teeSignature: args.teeSignature,
    teeSignerAddress: args.teeSignerAddress,
    attestationReportHash: args.attestationReportHash,
    providerAddress: args.providerAddress,
    model: args.model,
    chatId: args.chatId,
  })
}
