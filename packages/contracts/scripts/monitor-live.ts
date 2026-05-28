/**
 * Production monitor for the Sepolia PrivateSwap deployment.
 *
 * The script is intentionally read-only. It checks contract code, reserve/accounting
 * consistency, AMM quote health, and recent indexed swaps.
 */
import * as fs from 'fs'
import * as path from 'path'
import hre from 'hardhat'

type Deployment = {
  chainId: number
  token0: string
  token1: string
  pool: string
}

type Alert = {
  level: 'warn' | 'critical'
  message: string
}

async function requireCode(address: string, label: string, alerts: Alert[]) {
  const code = await hre.ethers.provider.getCode(address)
  if (code === '0x') alerts.push({ level: 'critical', message: `${label} has no bytecode at ${address}` })
}

function asBigIntEnv(name: string, fallback: bigint) {
  const value = process.env[name]
  if (!value) return fallback

  try {
    return BigInt(value)
  } catch {
    throw new Error(`${name} must be an integer bigint string, got "${value}"`)
  }
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

async function main() {
  const depPath = path.join(__dirname, '..', 'deployments', 'sepolia.json')
  const deployment = JSON.parse(fs.readFileSync(depPath, 'utf8')) as Deployment
  const net = await hre.ethers.provider.getNetwork()
  const alerts: Alert[] = []

  if (net.chainId !== BigInt(deployment.chainId)) {
    alerts.push({
      level: 'critical',
      message: `Provider chain ${net.chainId.toString()} does not match deployment chain ${deployment.chainId}`,
    })
  }

  await requireCode(deployment.token0, 'token0', alerts)
  await requireCode(deployment.token1, 'token1', alerts)
  await requireCode(deployment.pool, 'pool', alerts)

  const token0 = await hre.ethers.getContractAt('MintableERC20', deployment.token0)
  const token1 = await hre.ethers.getContractAt('MintableERC20', deployment.token1)
  const pool = await hre.ethers.getContractAt('PrivateSwapPool', deployment.pool)

  const [reserve0, reserve1] = await pool.getReserves()
  const poolBalance0 = await token0.balanceOf(deployment.pool)
  const poolBalance1 = await token1.balanceOf(deployment.pool)
  const currentBlock = await hre.ethers.provider.getBlockNumber()
  const historyBlocks = asIntegerEnv('SWAP_HISTORY_BLOCKS', 50000)
  const fromBlock = Math.max(0, currentBlock - historyBlocks)
  const swaps = await pool.queryFilter(pool.filters.Swap(), fromBlock, currentBlock)
  const quoteAmount = asBigIntEnv('MONITOR_QUOTE_AMOUNT', 10n * 10n ** 6n)
  const quote0To1 = await pool.getAmountOut(quoteAmount, true)
  const quote1To0 = await pool.getAmountOut(quoteAmount, false)
  const swapFeeBps = await pool.SWAP_FEE_BPS()
  const minReserve = asBigIntEnv('MONITOR_MIN_RESERVE', 1n)
  const requireRecentSwap = process.env.MONITOR_REQUIRE_RECENT_SWAP === 'true'

  if (reserve0 < minReserve || reserve1 < minReserve) {
    alerts.push({ level: 'critical', message: 'Pool reserve is below MONITOR_MIN_RESERVE.' })
  }

  if (poolBalance0 !== reserve0 || poolBalance1 !== reserve1) {
    alerts.push({ level: 'critical', message: 'Pool token balances do not match recorded reserves.' })
  }

  if (quote0To1 === 0n || quote1To0 === 0n) {
    alerts.push({ level: 'critical', message: 'One or more live AMM quotes returned zero.' })
  }

  if (requireRecentSwap && swaps.length === 0) {
    alerts.push({ level: 'warn', message: `No swaps found in the last ${historyBlocks} blocks.` })
  }

  const criticalCount = alerts.filter((alert) => alert.level === 'critical').length
  const report = {
    ok: criticalCount === 0,
    network: hre.network.name,
    chainId: Number(net.chainId),
    block: currentBlock,
    pool: deployment.pool,
    reserves: {
      token0: reserve0.toString(),
      token1: reserve1.toString(),
    },
    poolBalances: {
      token0: poolBalance0.toString(),
      token1: poolBalance1.toString(),
    },
    quotes: {
      swapFeeBps: swapFeeBps.toString(),
      amountIn: quoteAmount.toString(),
      token0ToToken1: quote0To1.toString(),
      token1ToToken0: quote1To0.toString(),
    },
    swaps: {
      fromBlock,
      count: swaps.length,
      lastTxHash: swaps.length > 0 ? swaps[swaps.length - 1].transactionHash : null,
    },
    alerts,
  }

  console.log(JSON.stringify(report, null, 2))

  if (criticalCount > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
