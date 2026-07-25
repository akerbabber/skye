import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AnvilHandle {
  url: string
  stop: () => void
}

function anvilBinary(): string {
  if (process.env.ANVIL_PATH) return process.env.ANVIL_PATH
  const local = join(homedir(), '.foundry', 'bin', 'anvil')
  return existsSync(local) ? local : 'anvil'
}

/**
 * Starts a throwaway anvil chain.
 *
 * By default this is a bare chain with no fork: both fixtures are contracts we
 * deploy ourselves, so no upstream RPC is needed and every run is byte-for-byte
 * deterministic. Set MAINNET_RPC_URL to fork Ethereum mainnet at a pinned block
 * instead — needed only for demos against real tokens.
 */
export async function startAnvil(options: { port?: number } = {}): Promise<AnvilHandle> {
  const port = options.port ?? 8545 + Math.floor(process.pid % 1000)
  const args = [
    '--port',
    String(port),
    '--chain-id',
    String(CHAIN_ID),
    '--silent',
    // Auto-mine one block per transaction: every run produces the same block
    // numbers, which is what the spender-age fact depends on.
    '--order',
    'fifo',
  ]

  const forkUrl = process.env.MAINNET_RPC_URL
  if (forkUrl) {
    args.push('--fork-url', forkUrl)
    if (process.env.FORK_BLOCK) args.push('--fork-block-number', process.env.FORK_BLOCK)
  }

  const bin = anvilBinary()
  let child: ChildProcess
  try {
    child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    throw new Error(`could not start anvil (${bin}): ${(err as Error).message}`)
  }

  let stderr = ''
  child.stderr?.on('data', (d) => (stderr += String(d)))
  child.on('error', (err) => (stderr += err.message))

  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 20_000
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `anvil exited with code ${child.exitCode}. Is foundry installed?\n${stderr}`.trim(),
      )
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      })
      if (res.ok) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`anvil did not become ready within 20s at ${url}\n${stderr}`.trim())
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  return {
    url,
    stop: () => {
      child.kill('SIGKILL')
    },
  }
}

/** Chain id of the throwaway simulation chain. */
export const CHAIN_ID = 31337
