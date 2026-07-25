/** Prints the 0G balance of the configured wallet. */
import { ethers } from 'ethers'
import { loadEnv, requireEnv } from './env.js'

loadEnv()

const provider = new ethers.JsonRpcProvider(process.env.ZG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai')
const wallet = new ethers.Wallet(requireEnv('PRIVATE_KEY'), provider)

for (const address of [wallet.address, ...process.argv.slice(2)]) {
  console.log(`${address}  ${ethers.formatEther(await provider.getBalance(address))} 0G`)
}
