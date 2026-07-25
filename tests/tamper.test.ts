import { createHash } from 'node:crypto'
import { describe, it, expect, beforeAll } from 'vitest'
import { Wallet } from 'ethers'
import { buildRecord, verify, type VerdictRecord } from '../src/attest.js'
import { intentHash, type Intent } from '../src/intent.js'
import { computeFactsDigest, type Facts } from '../src/facts.js'

/**
 * CRITICAL-PATH TEST 2 — the verdict cannot be moved off the intent it was
 * reached over, and nothing in the record can be edited after the fact.
 *
 * The enclave is stood in for by a local key. That is legitimate here: this
 * test is about the binding logic, not about 0G. Whether the signer really is
 * a TEE is established by `pnpm verify:0g` against the live network, and the
 * README is explicit about which is which.
 */

const INTENT: Intent = {
  chainId: 31337,
  from: '0x1111111111111111111111111111111111111111',
  to: '0x2222222222222222222222222222222222222222',
  value: 10n ** 18n,
  data: '0xdeadbeef',
  nonce: 7,
}

const FACTS_BASE: Omit<Facts, 'factsDigest'> = {
  schemaVersion: 1,
  intentHash: intentHash(INTENT).toLowerCase(),
  chainId: 31337,
  executionReverted: false,
  balanceDeltas: [
    { asset: '0x0000000000000000000000000000000000000000', delta: '-1000000000000000000', decimals: 18 },
  ],
  approvals: [],
  sellOutcome: 'reverted',
  transferTaxBps: -1,
  gasUsed: 67349,
}

const FACTS: Facts = { ...FACTS_BASE, factsDigest: computeFactsDigest(FACTS_BASE) }

let record: VerdictRecord
let enclave: Wallet

beforeAll(async () => {
  enclave = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
  const verdict = {
    verdict: 'danger' as const,
    reasons: ['the sell simulation reverted (sellOutcome: reverted)'],
    confidence: 0.95,
    intentHash: FACTS.intentHash,
    factsDigest: FACTS.factsDigest,
  }
  // Mirror the real 0G signed-text shape, established empirically against the
  // live provider by scripts/probe-signature.ts:
  //   <requestDigest>:<responseDigest>:<providerType>:<vendor>:<...>
  // where responseDigest = sha256 of the canonical response body.
  const responseJson = JSON.stringify({
    id: 'chat-123',
    choices: [{ message: { role: 'assistant', content: JSON.stringify(verdict) } }],
    usage: { total_tokens: 45 },
  })
  const responseDigest = createHash('sha256').update(responseJson).digest('hex')
  const signedText = [
    'a'.repeat(64),
    responseDigest,
    'centralized',
    'aliyun',
    'b'.repeat(64),
  ].join(':')

  record = buildRecord({
    facts: FACTS,
    verdict,
    signedText,
    responseJson,
    teeSignature: await enclave.signMessage(signedText),
    teeSignerAddress: enclave.address,
    attestationReportHash: '0x' + 'ab'.repeat(32),
    providerAddress: '0xa48f01287233509FD694a22Bf840225062E67836',
    model: 'qwen/qwen2.5-omni-7b',
    chatId: 'chat-123',
  })
})

/** Deep clone that survives the record's plain-JSON shape. */
const clone = (r: VerdictRecord): VerdictRecord => JSON.parse(JSON.stringify(r))

describe('verdict record binding', () => {
  it('verifies an untampered record, including against the original intent', () => {
    const outcome = verify(record, INTENT)
    expect(outcome.errors).toEqual([])
    expect(outcome.ok).toBe(true)
    expect(outcome.checks.intentHashRecomputed).toBe(true)
    expect(outcome.recoveredSigner?.toLowerCase()).toBe(enclave.address.toLowerCase())
  })

  const tampers: Array<[string, (r: VerdictRecord) => void]> = [
    ['verdict flipped to safe', (r) => void (r.verdict.verdict = 'safe')],
    ['confidence raised', (r) => void (r.verdict.confidence = 0.1)],
    ['reasons rewritten', (r) => void (r.verdict.reasons = ['looks fine to me'])],
    ['intentHash swapped', (r) => void (r.intentHash = '0x' + 'cd'.repeat(32))],
    ['facts.intentHash swapped', (r) => void (r.facts.intentHash = '0x' + 'ef'.repeat(32))],
    // Editing a fact invalidates its digest, and the digest is inside the
    // signed bytes — so the facts are covered by the signature, not merely
    // displayed next to it.
    ['facts.sellOutcome softened', (r) => void (r.facts.sellOutcome = 'ok')],
    ['facts.transferTaxBps lowered', (r) => void (r.facts.transferTaxBps = 0)],
    [
      'facts edited AND digest recomputed to match',
      (r) => {
        r.facts.sellOutcome = 'ok'
        r.facts.factsDigest = computeFactsDigest(r.facts)
      },
    ],
    [
      // Flip a byte inside r, not the trailing recovery byte — v normalizes,
      // so editing it can round-trip back to the same address.
      'signature byte flipped',
      (r) =>
        void (r.teeSignature =
          r.teeSignature.slice(0, 10) +
          (r.teeSignature[10] === 'a' ? 'b' : 'a') +
          r.teeSignature.slice(11)),
    ],
    ['signer address swapped', (r) => void (r.teeSignerAddress = '0x' + '11'.repeat(20))],
    // The enclave commits to a digest of the whole response body, so rewriting
    // the model's words breaks the chain even though the signature is genuine.
    [
      'response body rewritten to say safe',
      (r) => void (r.responseJson = r.responseJson.replace('danger', 'safe')),
    ],
    [
      'response digest in signed text swapped',
      (r) => {
        const parts = r.signedText.split(':')
        parts[1] = 'c'.repeat(64)
        r.signedText = parts.join(':')
      },
    ],
    ['signed text truncated', (r) => void (r.signedText = r.signedText.split(':')[0])],
  ]

  for (const [name, tamper] of tampers) {
    it(`rejects: ${name}`, () => {
      const bad = clone(record)
      tamper(bad)
      const outcome = verify(bad, INTENT)
      expect(outcome.ok, `tampering with ${name} was not detected`).toBe(false)
      expect(outcome.errors.length).toBeGreaterThan(0)
    })
  }

  it('rejects a valid record replayed against a different transaction', () => {
    const other: Intent = { ...INTENT, value: 2n * 10n ** 18n }
    const outcome = verify(record, other)
    expect(outcome.ok).toBe(false)
    expect(outcome.checks.signature).toBe(true) // signature is still genuine…
    expect(outcome.checks.intentHashRecomputed).toBe(false) // …but it is not for this tx
  })
})
