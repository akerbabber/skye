/**
 * What exactly does the 0G TEE signer sign?
 *
 * The signed text is `<hex>:<hex>`, not the response body. This script runs one
 * inference with distinctive content and brute-forces which digest of which
 * part of the exchange reproduces each half. The answer decides whether the
 * attestation binds our facts directly, or only via the model echoing them.
 */
import { createHash } from 'node:crypto'
import { ethers } from 'ethers'
import { keccak256, toHex } from 'viem'
import { createZGComputeNetworkBroker } from '@0gfoundation/0g-compute-ts-sdk'
import { loadEnv, requireEnv } from './env.js'

loadEnv()

const RPC = process.env.ZG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai'
const wallet = new ethers.Wallet(requireEnv('PRIVATE_KEY'), new ethers.JsonRpcProvider(RPC))
const broker = await createZGComputeNetworkBroker(wallet)

const services = await broker.inference.listService()
const service = services.filter((s) => s.serviceType === 'chatbot')[0]
const provider = service.provider
const { endpoint, model } = await broker.inference.getServiceMetadata(provider)

const SYSTEM = 'You are terse. Reply with one word.'
const USER = 'MARKER-9f3a2b: reply with the single word BANANA and nothing else.'

const headers = await broker.inference.getRequestHeaders(provider, USER)
const body = {
  model,
  messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: USER },
  ],
  temperature: 0,
}
const bodyString = JSON.stringify(body)

const res = await fetch(`${endpoint}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(headers as unknown as Record<string, string>) },
  body: bodyString,
})
const data: any = await res.json()
const content: string = data.choices?.[0]?.message?.content ?? ''
const chatId: string =
  res.headers.get('ZG-Res-Key') ?? res.headers.get('zg-res-key') ?? data.id ?? ''

console.log(`chatId   ${chatId}`)
console.log(`response ${JSON.stringify(content)}`)

const link = await broker.inference.getChatSignatureDownloadLink(provider, chatId)
const signed: { text: string; signature: string } = await (await fetch(link)).json()

console.log(`\nFULL SIGNED TEXT:\n${signed.text}`)
console.log(`length ${signed.text.length}`)
const parts = signed.text.split(':')
console.log(`parts: ${parts.length}, lengths ${parts.map((p) => p.length).join(', ')}`)

// ---- brute force ------------------------------------------------------------
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const sha256b = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const kec = (s: string) => keccak256(toHex(s)).slice(2)

const candidates: Record<string, string> = {
  USER: USER,
  SYSTEM: SYSTEM,
  content: content,
  bodyString: bodyString,
  chatId: chatId,
  'system+user': SYSTEM + USER,
  'user+content': USER + content,
  messagesJson: JSON.stringify(body.messages),
  dataJson: JSON.stringify(data),
  choicesJson: JSON.stringify(data.choices),
  message0Json: JSON.stringify(data.choices?.[0]?.message ?? {}),
  usageJson: JSON.stringify(data.usage ?? {}),
}

console.log('\n--- digest search ---')
for (const [name, value] of Object.entries(candidates)) {
  for (const [algo, fn] of [
    ['sha256', sha256],
    ['sha256utf8', sha256b],
    ['keccak', kec],
  ] as const) {
    const digest = fn(value)
    for (let i = 0; i < parts.length; i++) {
      if (digest === parts[i] || digest.startsWith(parts[i]) || parts[i].startsWith(digest)) {
        console.log(`MATCH part[${i}] = ${algo}(${name})`)
      }
    }
  }
}
console.log('(no MATCH lines above means none of the candidates reproduce either half)')
