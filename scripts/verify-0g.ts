/**
 * Block 0 de-risk: prove we can run sealed inference on 0G and verify that the
 * response was signed by the provider's TEE signer.
 *
 * Prints a real model response, the TEE signature, and SIGNATURE OK / FAILED.
 */
import { createHash } from 'node:crypto'
import { ethers } from 'ethers'
import { createZGComputeNetworkBroker } from '@0gfoundation/0g-compute-ts-sdk'
import { loadEnv, requireEnv } from './env.js'

loadEnv()

const RPC_URL = process.env.ZG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai'
/**
 * Initial ledger deposit, in 0G. The SDK enforces
 * `LedgerProcessor.MIN_LEDGER_BALANCE_OG = 3` — anything less is rejected
 * client-side before a transaction is sent. The docs do not mention this.
 */
const LEDGER_DEPOSIT = Number(process.env.ZG_LEDGER_DEPOSIT ?? '3')
/** Amount moved into the provider sub-account, in 0G. SDK minimum is 1. */
const SUBACCOUNT_FUND = Number(process.env.ZG_SUBACCOUNT_FUND ?? '1')

const PROMPT =
  'Reply with exactly this JSON and nothing else: {"ok":true,"note":"sealed-check block 0"}'

function log(step: string, detail = '') {
  console.log(`\n── ${step} ${detail}`)
}

const wallet = new ethers.Wallet(
  requireEnv('PRIVATE_KEY'),
  new ethers.JsonRpcProvider(RPC_URL),
)

log('wallet', wallet.address)
const network = await wallet.provider!.getNetwork()
const balance = await wallet.provider!.getBalance(wallet.address)
console.log(`chainId  ${network.chainId}`)
console.log(`balance  ${ethers.formatEther(balance)} 0G`)
if (balance === 0n) {
  throw new Error(`wallet ${wallet.address} has no 0G — fund it at https://faucet.0g.ai`)
}

log('broker')
const broker = await createZGComputeNetworkBroker(wallet)

// ---------------------------------------------------------------- ledger ---
log('ledger')
let ledgerBalance = 0n
try {
  const ledger = await broker.ledger.getLedger()
  ledgerBalance = ledger.totalBalance ?? 0n
  console.log(`existing ledger, totalBalance ${ethers.formatEther(ledgerBalance)} 0G`)
} catch {
  // Only now does the 3 0G minimum matter. Checking it up front would block
  // re-runs, because by then the funds are sitting in the ledger, not the wallet.
  if (balance < ethers.parseEther('3.05')) {
    throw new Error(
      `no ledger yet, and wallet ${wallet.address} holds only ` +
        `${ethers.formatEther(balance)} 0G. Creating one needs 3.05 (the SDK enforces a ` +
        `3 0G minimum, plus gas). Top up at https://faucet.0g.ai`,
    )
  }
  console.log(`no ledger — creating with ${LEDGER_DEPOSIT} 0G`)
  await broker.ledger.addLedger(LEDGER_DEPOSIT)
  const ledger = await broker.ledger.getLedger()
  ledgerBalance = ledger.totalBalance ?? 0n
  console.log(`created, totalBalance ${ethers.formatEther(ledgerBalance)} 0G`)
}

// -------------------------------------------------------------- provider ---
log('provider')
const services = await broker.inference.listService()
const chatbots = services.filter((s) => s.serviceType === 'chatbot')
const pinned = process.env.ZG_PROVIDER_ADDRESS
const service = pinned
  ? chatbots.find((s) => s.provider.toLowerCase() === pinned.toLowerCase())
  : chatbots[0]
if (!service) {
  throw new Error(
    `no chatbot service found${pinned ? ` for pinned provider ${pinned}` : ''} — ` +
      `available: ${services.map((s) => `${s.provider}(${s.serviceType})`).join(', ')}`,
  )
}
const providerAddress = service.provider
console.log(`provider      ${providerAddress}`)
console.log(`model         ${service.model}`)
console.log(`url           ${service.url}`)
console.log(`verifiability ${service.verifiability}`)

// ---------------------------------------------------------- sub-account ----
log('sub-account')
let subAccountBalance = 0n
try {
  const account = await broker.inference.getAccount(providerAddress)
  subAccountBalance = account.balance ?? 0n
  console.log(`balance ${ethers.formatEther(subAccountBalance)} 0G`)
} catch {
  console.log('no sub-account yet')
}
if (subAccountBalance === 0n) {
  const amount = ethers.parseEther(String(SUBACCOUNT_FUND))
  console.log(`transferring ${SUBACCOUNT_FUND} 0G to provider sub-account`)
  await broker.ledger.transferFund(providerAddress, 'inference', amount)
  const account = await broker.inference.getAccount(providerAddress)
  console.log(`balance now ${ethers.formatEther(account.balance ?? 0n)} 0G`)
}

// ------------------------------------------------------------- inference ---
log('sealed inference')
const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress)
const headers = await broker.inference.getRequestHeaders(providerAddress, PROMPT)

const res = await fetch(`${endpoint}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(headers as unknown as Record<string, string>) },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT }] }),
})
if (!res.ok) {
  throw new Error(`inference HTTP ${res.status}: ${await res.text()}`)
}
const data: any = await res.json()
const answer: string = data.choices?.[0]?.message?.content ?? ''
const chatID: string =
  res.headers.get('ZG-Res-Key') ?? res.headers.get('zg-res-key') ?? data.id ?? ''

console.log(`endpoint ${endpoint}`)
console.log(`model    ${model}`)
console.log(`chatID   ${chatID}`)
console.log(`usage    ${JSON.stringify(data.usage ?? {})}`)
console.log(`\nRESPONSE:\n${answer}`)

// ---------------------------------------------------------- verification ---
log('signature verification')
if (!chatID) throw new Error('no chatID returned — cannot verify signature')

// (1) SDK-internal check.
let sdkValid: boolean | null = null
try {
  sdkValid = await broker.inference.processResponse(
    providerAddress,
    chatID,
    JSON.stringify(data.usage ?? {}),
  )
  console.log(`broker.inference.processResponse -> ${sdkValid}`)
} catch (err) {
  console.log(`broker.inference.processResponse threw: ${(err as Error).message}`)
}

// (2) Independent check: fetch the signed payload and recover the signer
//     ourselves, then compare against the TEE signer address the contract
//     holds for this provider. This is the load-bearing one — it does not
//     trust the SDK's own verdict.
const { teeSignerAddress, isAcknowledged } =
  await broker.inference.checkProviderSignerStatus(providerAddress)
console.log(`teeSignerAddress ${teeSignerAddress} (acknowledged: ${isAcknowledged})`)

const sigLink = await broker.inference.getChatSignatureDownloadLink(providerAddress, chatID)
const sigRes = await fetch(sigLink)
if (!sigRes.ok) throw new Error(`signature fetch HTTP ${sigRes.status}: ${await sigRes.text()}`)
const signed: { text: string; signature: string } = await sigRes.json()

const recovered = ethers.verifyMessage(signed.text, signed.signature)
const manualValid = recovered.toLowerCase() === teeSignerAddress.toLowerCase()

console.log(`signature    ${signed.signature.slice(0, 42)}…`)
console.log(`signed text  ${JSON.stringify(signed.text.slice(0, 120))}…`)
console.log(`recovered    ${recovered}`)

// -------------------------------------------------------- attestation RA ---
log('remote attestation (best effort)')
let attestationReportHash: string | null = null
try {
  const raLink = await broker.inference.getSignerRaDownloadLink(providerAddress)
  const raRes = await fetch(raLink)
  const raBody = Buffer.from(await raRes.arrayBuffer())
  attestationReportHash = '0x' + createHash('sha256').update(raBody).digest('hex')
  console.log(`RA link  ${raLink}`)
  console.log(`RA bytes ${raBody.length}`)
  console.log(`RA sha256 ${attestationReportHash}`)
  try {
    const parsed = JSON.parse(raBody.toString('utf8'))
    console.log(`RA parsed, top-level keys: ${Object.keys(parsed).join(', ')}`)
    const addr = parsed.signing_address ?? parsed.signingAddress
    if (addr) {
      console.log(
        `RA signing_address ${addr} — matches TEE signer: ` +
          `${String(addr).toLowerCase() === teeSignerAddress.toLowerCase()}`,
      )
    }
  } catch {
    console.log('RA body is not JSON — hash recorded, parsing skipped (per brief)')
  }
} catch (err) {
  console.log(`RA unavailable: ${(err as Error).message} — skipping (per brief)`)
}

// ------------------------------------------------------------------ gate ---
console.log('\n' + '='.repeat(60))
console.log(manualValid ? 'SIGNATURE OK' : 'SIGNATURE FAILED')
console.log('='.repeat(60))
console.log(
  JSON.stringify(
    {
      providerAddress,
      endpoint,
      model,
      chatID,
      teeSignerAddress,
      sdkProcessResponse: sdkValid,
      manualVerification: manualValid,
      attestationReportHash,
    },
    null,
    2,
  ),
)
process.exit(manualValid ? 0 : 1)
