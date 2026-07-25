import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem'

/** An unsigned transaction intent — what the user is about to sign. */
export interface Intent {
  chainId: number
  from: Address
  to: Address
  value: bigint
  data: Hex
  nonce: number
}

/**
 * The verdict is bound to this hash. Changing any field of the intent changes
 * the hash, so a verdict cannot be replayed against a different transaction.
 */
export function intentHash(intent: Intent): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'uint256', name: 'chainId' },
        { type: 'address', name: 'from' },
        { type: 'address', name: 'to' },
        { type: 'uint256', name: 'value' },
        { type: 'bytes', name: 'data' },
        { type: 'uint256', name: 'nonce' },
      ],
      [
        BigInt(intent.chainId),
        intent.from,
        intent.to,
        intent.value,
        intent.data,
        BigInt(intent.nonce),
      ],
    ),
  )
}
