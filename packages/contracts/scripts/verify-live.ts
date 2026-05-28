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

async function maybeRead<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read()
  } catch {
    return fallback
  }
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

function asIntegerEnv(name: string, fallback: number) {
  const value = process.env[name]
  if (!value) return fallback

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer, got "${value}"`)
  }

  return parsed
}

function swapAmountOutFromLogs(
  poolInterface: { parseLog: (log: { data: string; topics: string[] }) => unknown },
  poolAddress: string,
  logs: readonly { address: string; data: string; topics: readonly string[] }[],
) {
  for (const log of logs) {
    if (log.address.toLowerCase() !== poolAddress.toLowerCase()) continue

    try {
      const parsed = poolInterface.parseLog({ data: log.data, topics: [...log.topics] }) as {
        name?: string
        args?: { amountOut?: bigint }
      } | null

      if (parsed?.name === 'Swap' && typeof parsed.args?.amountOut === 'bigint') {
        return parsed.args.amountOut
      }
    } catch {
      /* Ignore token logs in the same transaction receipt. */
    }
  }

  return undefined
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
  const currentBlock = await hre.ethers.provider.getBlockNumber()
  const fromBlock = Math.max(0, currentBlock - asIntegerEnv('SWAP_HISTORY_BLOCKS', 50000))
  const swaps = await maybeRead(() => pool.queryFilter(pool.filters.Swap(), fromBlock, currentBlock), [])
  const totalLiquidity = await maybeRead(() => pool.totalLiquidity(), 0n)
  const poolToken0Balance = await token0.balanceOf(deployment.pool)
  const poolToken1Balance = await token1.balanceOf(deployment.pool)
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
    poolBalances: {
      token0: poolToken0Balance.toString(),
      token1: poolToken1Balance.toString(),
      matchReserves: poolToken0Balance === reserve0 && poolToken1Balance === reserve1,
    },
    totalLiquidity: totalLiquidity.toString(),
    swapFeeBps: (await pool.SWAP_FEE_BPS()).toString(),
    quote10Token0ToToken1: quote.toString(),
    faucetAmount: (await token0.faucetAmount()).toString(),
    recentSwaps: {
      fromBlock,
      toBlock: currentBlock,
      count: swaps.length,
      lastTxHash: swaps.length > 0 ? swaps[swaps.length - 1].transactionHash : null,
    },
  }

  console.log(JSON.stringify(summary, null, 2))

  if (poolToken0Balance !== reserve0 || poolToken1Balance !== reserve1) {
    throw new Error('Pool ERC20 balances do not match recorded reserves.')
  }

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
  if (account.address.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`PRIVATE_KEY account ${account.address} does not match Hardhat signer ${signer.address}`)
  }

  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) })
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) })
  const cofheClient = createCofheClient(createCofheConfig({ supportedChains: [chains.sepolia] }))

  await cofheClient.connect(publicClient, walletClient)
  await cofheClient.permits.getOrCreateSelfPermit()

  const latest = await hre.ethers.provider.getBlock('latest')
  const deadline = BigInt((latest?.timestamp ?? Math.floor(Date.now() / 1000)) + 1200)
  const tx = await pool.swap(amountIn, 0n, true, deadline)
  const receipt = await tx.wait()
  const settledOut = swapAmountOutFromLogs(pool.interface, deployment.pool, receipt?.logs ?? [])
  if (settledOut === undefined) throw new Error('Swap event was not found in the live write receipt.')

  console.log(
    JSON.stringify(
      {
        liveWriteSubmitted: true,
        txHash: receipt?.hash,
        amountIn: amountIn.toString(),
        expectedOutBeforeSubmit: expectedOut.toString(),
        settledOut: settledOut.toString(),
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
        expectedOutBeforeSubmit: expectedOut.toString(),
        settledOut: settledOut.toString(),
        decryptedOut: decrypted.toString(),
        matched: decrypted === settledOut,
      },
      null,
      2,
    ),
  )

  if (decrypted !== settledOut) {
    throw new Error(`Decrypted amount ${decrypted} did not match settled amount ${settledOut}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
