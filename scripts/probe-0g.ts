/**
 * Read-only probe: lists 0G Compute inference providers without a wallet.
 * Used to de-risk connectivity and pick a provider address before funding.
 */
import { createReadOnlyInferenceBroker } from '@0gfoundation/0g-compute-ts-sdk'

const RPC = process.env.ZG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai'

const broker = await createReadOnlyInferenceBroker(RPC)
const services = await broker.listService()

console.log(`RPC: ${RPC}`)
console.log(`services: ${services.length}`)
for (const s of services) {
  console.log(
    JSON.stringify(
      {
        provider: s.provider,
        serviceType: s.serviceType,
        url: s.url,
        model: s.model,
        verifiability: s.verifiability,
        inputPrice: s.inputPrice?.toString(),
        outputPrice: s.outputPrice?.toString(),
      },
      null,
      2,
    ),
  )
}
