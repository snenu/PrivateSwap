/**
 * Verify the deployed PrivateSwap contracts on Sepolia.
 *
 * Default mode is read-only. Set LIVE_WRITE_SWAP=true to run a tiny swap
 * through the live CoFHE mirror path and decrypt the caller-scoped result.
 */
import * as fs from 'fs'
import * as path from 'path'
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/node'
import { chains } from '@cofhe/sdk/chains'
import { FheTypes } from '@cofhe/sdk'
import hre from 'hardhat'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

type Deployment = {
  chainId: number
  token0: string
  token1: string
  pool: string
}

function normalizePrivateKey(value: string): `0x${string}` {
  return value.startsWith('0x') ? (value as `0x${string}`) : `0x${value}`
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function requireCode(address: string, label: string) {
  const code = await hre.ethers.provider.getCode(address)
  if (code === '0x') throw new Error(`${label} has no contract code at ${address}`)
}

async function decryptWithRetry(
  client: ReturnType<typeof createCofheClient>,
  handle: bigint,
  attempts = 6,
) {
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return BigInt(await client.decryptForView(handle, FheTypes.Uint64).withPermit().execute())
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      const waitMs = attempt * 10_000
      console.warn(`decryptForView attempt ${attempt} failed; retrying in ${waitMs / 1000}s`)
      await sleep(waitMs)
    }
  }

  throw lastError
}

async function main() {
  const depPath = path.join(__dirname, '..', 'deployments', 'sepolia.json')
  const deployment = JSON.parse(fs.readFileSync(depPath, 'utf8')) as Deployment
  const net = await hre.ethers.provider.getNetwork()

  if (net.chainId !== 11155111n || deployment.chainId !== 11155111) {
    throw new Error(`Expected Sepolia chain 11155111, got provider=${net.chainId} deployment=${deployment.chainId}`)
  }

  await requireCode(deployment.token0, 'token0')
  await requireCode(deployment.token1, 'token1')
  await requireCode(deployment.pool, 'pool')

  const token0 = await hre.ethers.getContractAt('MintableERC20', deployment.token0)
  const token1 = await hre.ethers.getContractAt('MintableERC20', deployment.token1)
  const pool = await hre.ethers.getContractAt('PrivateSwapPool', deployment.pool)

  const [reserve0, reserve1] = await pool.getReserves()
  const quote = await pool.getAmountOut(10n * 10n ** 6n, true)
  const summary = {
    network: hre.network.name,
    pool: deployment.pool,
    token0: {
      address: deployment.token0,
      symbol: await token0.symbol(),
      decimals: Number(await token0.decimals()),
    },
    token1: {
      address: deployment.token1,
      symbol: await token1.symbol(),
      decimals: Number(await token1.decimals()),
    },
    reserves: {
      token0: reserve0.toString(),
      token1: reserve1.toString(),
    },
    quote10Token0ToToken1: quote.toString(),
    faucetAmount: (await token0.faucetAmount()).toString(),
  }

  console.log(JSON.stringify(summary, null, 2))

  if (process.env.LIVE_WRITE_SWAP !== 'true') return

  if (!process.env.PRIVATE_KEY) {
    throw new Error('LIVE_WRITE_SWAP=true requires PRIVATE_KEY in the environment.')
  }

  const [signer] = await hre.ethers.getSigners()
  const amountIn = BigInt(process.env.LIVE_SWAP_AMOUNT || '1000')
  const expectedOut = await pool.getAmountOut(amountIn, true)
  if (expectedOut <= 0n) throw new Error('Live swap quote returned zero.')

  const allowance = await token0.allowance(signer.address, deployment.pool)
  if (allowance < amountIn) {
    await (await token0.approve(deployment.pool, amountIn)).wait()
  }

  const rpcUrl = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'
  const account = privateKeyToAccount(normalizePrivateKey(process.env.PRIVATE_KEY))
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) })
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) })
  const cofheClient = createCofheClient(createCofheConfig({ supportedChains: [chains.sepolia] }))

  await cofheClient.connect(publicClient, walletClient)
  await cofheClient.permits.getOrCreateSelfPermit()

  const tx = await pool.swap(amountIn, 0n, true)
  const receipt = await tx.wait()
  console.log(
    JSON.stringify(
      {
        liveWriteSubmitted: true,
        txHash: receipt?.hash,
        amountIn: amountIn.toString(),
        expectedOut: expectedOut.toString(),
      },
      null,
      2,
    ),
  )

  const handle = await pool.lastEncAmountOutOf(signer.address)
  const decrypted = await decryptWithRetry(cofheClient, handle)

  console.log(
    JSON.stringify(
      {
        liveWrite: true,
        txHash: receipt?.hash,
        amountIn: amountIn.toString(),
        expectedOut: expectedOut.toString(),
        decryptedOut: decrypted.toString(),
        matched: decrypted === expectedOut,
      },
      null,
      2,
    ),
  )

  if (decrypted !== expectedOut) {
    throw new Error(`Decrypted amount ${decrypted} did not match expected amount ${expectedOut}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
