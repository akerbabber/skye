import { createHash } from 'node:crypto'
import { ethers } from 'ethers'
import { createZGComputeNetworkBroker } from '@0gfoundation/0g-compute-ts-sdk'

/** A model response together with everything needed to prove the TEE produced it. */
export interface SealedResponse {
  content: string
  /**
   * The provider's response body, re-serialised canonically. The TEE signature
   * commits to `sha256` of exactly this string — see `signedText` below.
   */
  responseJson: string
  chatId: string
  providerAddress: string
  model: string
  endpoint: string
  /**
   * The exact bytes the TEE signed. Empirically (see `scripts/probe-signature.ts`)
   * this is five colon-separated fields:
   *
   *   <requestDigest>:<responseDigest>:<providerType>:<vendor>:<unknown>
   *
   * `responseDigest` is `sha256(responseJson)`. That is the link we verify —
   * it means the enclave commits to the entire response body, so a verdict
   * cannot be edited after the fact while keeping the signature.
   */
  signedText: string
  teeSignature: string
  teeSignerAddress: string
  attestationReportHash: string | null
  /** The SDK's own verdict on the signature, for cross-checking ours. */
  sdkVerified: boolean | null
}

/**
 * Canonical serialisation of a provider response, matching whatever the TEE
 * hashed. Determined experimentally: `JSON.stringify` of the parsed body
 * reproduces the digest in the signed text.
 */
export function canonicalResponseJson(raw: string): string {
  return JSON.stringify(JSON.parse(raw))
}

/** Pulls the response digest out of the signed text. */
export function responseDigestFromSignedText(signedText: string): string | null {
  const parts = signedText.split(':')
  return parts.length >= 2 && /^[0-9a-f]{64}$/.test(parts[1]) ? parts[1] : null
}

export interface ZgClientOptions {
  privateKey: string
  rpcUrl?: string
  providerAddress?: string
  /** Ledger balance to create if none exists, in 0G. SDK minimum is 3. */
  ledgerDeposit?: number
  /** Sub-account funding, in 0G. SDK minimum is 1. */
  subAccountFund?: number
}

/**
 * Thin wrapper over the 0G compute broker.
 *
 * Everything here is about getting a signed answer out of the enclave. It does
 * not know what a transaction is and never sees one.
 */
export class ZgClient {
  private broker: Awaited<ReturnType<typeof createZGComputeNetworkBroker>> | null = null
  private providerAddress: string | null = null
  private meta: { endpoint: string; model: string } | null = null

  constructor(private readonly options: ZgClientOptions) {}

  async connect(): Promise<{ providerAddress: string; model: string; endpoint: string }> {
    const rpcUrl = this.options.rpcUrl ?? 'https://evmrpc-testnet.0g.ai'
    const wallet = new ethers.Wallet(this.options.privateKey, new ethers.JsonRpcProvider(rpcUrl))
    this.broker = await createZGComputeNetworkBroker(wallet)

    // Ledger. The SDK enforces a 3 0G minimum client-side; the docs do not say so.
    try {
      await this.broker.ledger.getLedger()
    } catch {
      await this.broker.ledger.addLedger(this.options.ledgerDeposit ?? 3)
    }

    const services = await this.broker.inference.listService()
    const chatbots = services.filter((s) => s.serviceType === 'chatbot')
    const pinned = this.options.providerAddress
    const service = pinned
      ? chatbots.find((s) => s.provider.toLowerCase() === pinned.toLowerCase())
      : chatbots[0]
    if (!service) throw new Error(`no 0G chatbot provider available${pinned ? ` (${pinned})` : ''}`)

    this.providerAddress = service.provider

    // Provider sub-account.
    let balance = 0n
    try {
      balance = (await this.broker.inference.getAccount(this.providerAddress)).balance ?? 0n
    } catch {
      // No sub-account yet.
    }
    if (balance === 0n) {
      await this.broker.ledger.transferFund(
        this.providerAddress,
        'inference',
        ethers.parseEther(String(this.options.subAccountFund ?? 1)),
      )
    }

    this.meta = await this.broker.inference.getServiceMetadata(this.providerAddress)
    return { providerAddress: this.providerAddress, ...this.meta }
  }

  /** Runs a chat completion inside the enclave and collects the TEE signature. */
  async infer(system: string, user: string): Promise<SealedResponse> {
    if (!this.broker || !this.providerAddress || !this.meta) {
      throw new Error('ZgClient.connect() must be called first')
    }
    const { endpoint, model } = this.meta
    const provider = this.providerAddress

    const headers = await this.broker.inference.getRequestHeaders(provider, user)
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(headers as unknown as Record<string, string>),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
      }),
    })
    if (!res.ok) throw new Error(`0G inference HTTP ${res.status}: ${await res.text()}`)

    // Read as text first: the signature commits to a digest of the body, so we
    // must keep the bytes rather than only the parsed object.
    const rawBody = await res.text()
    const data: any = JSON.parse(rawBody)
    const responseJson = canonicalResponseJson(rawBody)
    const content: string = data.choices?.[0]?.message?.content ?? ''
    const chatId: string =
      res.headers.get('ZG-Res-Key') ?? res.headers.get('zg-res-key') ?? data.id ?? ''
    if (!chatId) throw new Error('0G provider returned no chat id — cannot obtain a signature')

    let sdkVerified: boolean | null = null
    try {
      sdkVerified = await this.broker.inference.processResponse(
        provider,
        chatId,
        JSON.stringify(data.usage ?? {}),
      )
    } catch {
      // The SDK check is a cross-check, not the load-bearing one.
    }

    const { teeSignerAddress } = await this.broker.inference.checkProviderSignerStatus(provider)

    const sigLink = await this.broker.inference.getChatSignatureDownloadLink(provider, chatId)
    const sigRes = await fetch(sigLink)
    if (!sigRes.ok) throw new Error(`signature fetch HTTP ${sigRes.status}`)
    const signed: { text: string; signature: string } = await sigRes.json()

    let attestationReportHash: string | null = null
    try {
      const raLink = await this.broker.inference.getSignerRaDownloadLink(provider)
      const raBody = Buffer.from(await (await fetch(raLink)).arrayBuffer())
      attestationReportHash = '0x' + createHash('sha256').update(raBody).digest('hex')
    } catch {
      // Best effort per the brief. The signature is the load-bearing part.
    }

    return {
      content,
      responseJson,
      chatId,
      providerAddress: provider,
      model,
      endpoint,
      signedText: signed.text,
      teeSignature: signed.signature,
      teeSignerAddress,
      attestationReportHash,
      sdkVerified,
    }
  }
}
