import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from 'wagmi'
import { waitForTransactionReceipt } from '@wagmi/core'
import {
  encodeAbiParameters,
  decodeEventLog,
  formatUnits,
  keccak256,
  type Log,
  parseAbiItem,
  parseAbiParameters,
  parseUnits,
} from 'viem'
import { sepolia } from 'wagmi/chains'
import type { CofheClient } from '@cofhe/sdk'
import { erc20Abi, poolAbi } from './contracts'
import { useCofhe } from './useCofhe'
import { wagmiConfig } from './wagmi'
import { AnimatedBackground } from './components/AnimatedBackground'
import heroMark from './assets/hero.png'

const ZERO = '0x0000000000000000000000000000000000000000' as const
const ZERO_HASH = `0x${'0'.repeat(64)}` as `0x${string}`
const UINT64_MAX = (1n << 64n) - 1n
const SWAP_LOOKBACK_BLOCKS = 8_000n
const SWAP_LOG_CHUNK_BLOCKS = 2_000n
const TX_DEADLINE_SECONDS = 20 * 60
const swapEvent = parseAbiItem('event Swap(address indexed user, bool zeroForOne, uint256 amountIn, uint256 amountOut)')
const commitmentParams = parseAbiParameters('address,uint256,uint256,bool,bytes32,address,uint256,uint256')

type TxPhase =
  | 'idle'
  | 'commit'
  | 'approve'
  | 'approve0'
  | 'approve1'
  | 'swap'
  | 'decrypt'
  | 'liquidity'
  | 'faucet'
  | 'done'
  | 'error'

type AppMode = 'swap' | 'liquidity'

type TokenSummary = {
  symbol: string
  address: `0x${string}`
  decimals: number
  balance?: bigint
  reserve?: bigint
  poolBalance?: bigint
}

type PoolConfig = {
  id: string
  label: string
  pool: `0x${string}`
  token0: `0x${string}`
  token1: `0x${string}`
  token0Symbol: string
  token1Symbol: string
}

type SwapHistoryItem = {
  txHash: `0x${string}`
  blockNumber: bigint
  user: `0x${string}`
  zeroForOne: boolean
  amountIn: bigint
  amountOut: bigint
}

const phaseLabels: Record<TxPhase, string> = {
  idle: 'Ready',
  commit: 'Committing',
  approve: 'Approving',
  approve0: 'Approving PSA',
  approve1: 'Approving PSB',
  swap: 'Swapping',
  decrypt: 'Decrypting',
  liquidity: 'Updating LP',
  faucet: 'Claiming',
  done: 'Complete',
  error: 'Needs attention',
}

function isAddress(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)
}

function singlePoolConfig(): PoolConfig[] {
  const pool = import.meta.env.VITE_POOL_ADDRESS
  const token0 = import.meta.env.VITE_TOKEN0_ADDRESS
  const token1 = import.meta.env.VITE_TOKEN1_ADDRESS
  if (!isAddress(pool) || !isAddress(token0) || !isAddress(token1)) return []

  return [
    {
      id: 'primary',
      label: 'PSA / PSB',
      pool,
      token0,
      token1,
      token0Symbol: 'PSA',
      token1Symbol: 'PSB',
    },
  ]
}

function loadPoolConfigs(): PoolConfig[] {
  const fromJson = import.meta.env.VITE_POOLS_JSON
  if (!fromJson) return singlePoolConfig()

  try {
    const parsed = JSON.parse(fromJson) as Partial<PoolConfig>[]
    const pools = parsed
      .filter((pool): pool is Partial<PoolConfig> & { pool: `0x${string}`; token0: `0x${string}`; token1: `0x${string}` } =>
        isAddress(pool.pool) && isAddress(pool.token0) && isAddress(pool.token1),
      )
      .map((pool, index) => ({
        id: pool.id || `pool-${index + 1}`,
        label: pool.label || `Pool ${index + 1}`,
        pool: pool.pool,
        token0: pool.token0,
        token1: pool.token1,
        token0Symbol: pool.token0Symbol || 'PSA',
        token1Symbol: pool.token1Symbol || 'PSB',
      }))

    return pools.length > 0 ? pools : singlePoolConfig()
  } catch {
    return singlePoolConfig()
  }
}

function shortAddress(value?: string) {
  if (!value) return ''
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

function compactError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\n/g, ' ')
    .replace(/User rejected the request\./i, 'Request rejected in wallet.')
    .slice(0, 280)
}

function formatToken(value: bigint | undefined, decimals: number) {
  if (value === undefined) return '--'
  const formatted = formatUnits(value, decimals)
  const [whole, fraction = ''] = formatted.split('.')
  const trimmed = fraction.slice(0, 6).replace(/0+$/, '')
  return trimmed ? `${whole}.${trimmed}` : whole
}

function formatBps(value: number | undefined) {
  if (value === undefined) return '--'
  return `${(value / 100).toFixed(2)}%`
}

function formatDuration(seconds: bigint) {
  const totalSeconds = Number(seconds)
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 'now'

  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.ceil((totalSeconds % 3600) / 60)
  if (hours <= 0) return `${minutes}m`
  if (minutes === 0 || minutes === 60) return `${hours + (minutes === 60 ? 1 : 0)}h`
  return `${hours}h ${minutes}m`
}

function parseTokenAmount(value: string, decimals: number) {
  try {
    if (!value.trim()) return 0n
    return parseUnits(value, decimals)
  } catch {
    return 0n
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function decryptUint64WithRetry(client: CofheClient, handle: bigint, attempts = 5) {
  const { FheTypes } = await import('@cofhe/sdk')
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return BigInt(await client.decryptForView(handle, FheTypes.Uint64).withPermit().execute())
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      await sleep(attempt * 4_000)
    }
  }

  throw lastError
}

function randomBytes32() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}` as `0x${string}`
}

function deadlineFromNow() {
  return BigInt(Math.floor(Date.now() / 1000) + TX_DEADLINE_SECONDS)
}

function swapAmountOutFromLogs(logs: readonly Log[], poolAddress: `0x${string}`) {
  for (const log of logs) {
    if (log.address.toLowerCase() !== poolAddress.toLowerCase()) continue

    try {
      const decoded = decodeEventLog({
        abi: poolAbi,
        data: log.data,
        topics: log.topics,
      })

      if (decoded.eventName === 'Swap') {
        return decoded.args.amountOut
      }
    } catch {
      /* Ignore non-Swap logs emitted by token approvals/transfers in the same receipt. */
    }
  }

  return undefined
}

export default function App() {
  const queryClient = useQueryClient()
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { connect, connectors, isPending: walletPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const publicClient = usePublicClient({ chainId: sepolia.id })
  const {
    client: cofheClient,
    ready: cofheReady,
    connecting: cofheConnecting,
    error: cofheErr,
    retry: retryCofhe,
  } = useCofhe()

  const poolConfigs = useMemo(loadPoolConfigs, [])
  const [selectedPoolId, setSelectedPoolId] = useState(poolConfigs[0]?.id ?? 'primary')
  const selectedPool = poolConfigs.find((pool) => pool.id === selectedPoolId) ?? poolConfigs[0]
  const poolAddress = selectedPool?.pool ?? ZERO
  const token0Address = selectedPool?.token0 ?? ZERO
  const token1Address = selectedPool?.token1 ?? ZERO
  const configured = !!selectedPool && poolAddress !== ZERO && token0Address !== ZERO && token1Address !== ZERO
  const faucetEnabled = import.meta.env.VITE_ENABLE_FAUCET === 'true'

  const [mode, setMode] = useState<AppMode>('swap')
  const [amountStr, setAmountStr] = useState('10')
  const [zeroForOne, setZeroForOne] = useState(true)
  const [slippageBps, setSlippageBps] = useState(100)
  const [useCommitment, setUseCommitment] = useState(false)
  const [liq0Str, setLiq0Str] = useState('25')
  const [liq1Str, setLiq1Str] = useState('25')
  const [removeBps, setRemoveBps] = useState(2500)
  const [phase, setPhase] = useState<TxPhase>('idle')
  const [statusMsg, setStatusMsg] = useState('')
  const [lastOutPlain, setLastOutPlain] = useState<string | null>(null)
  const [lastEncPlain, setLastEncPlain] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>()
  const [history, setHistory] = useState<SwapHistoryItem[]>([])
  const [historyErr, setHistoryErr] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  const { writeContractAsync } = useWriteContract()

  const { data: dec0 } = useReadContract({
    address: token0Address,
    abi: erc20Abi,
    functionName: 'decimals',
    query: { enabled: configured },
  })
  const { data: dec1 } = useReadContract({
    address: token1Address,
    abi: erc20Abi,
    functionName: 'decimals',
    query: { enabled: configured },
  })

  const decimals0 = typeof dec0 === 'number' ? dec0 : 6
  const decimals1 = typeof dec1 === 'number' ? dec1 : 6

  const { data: reserve0Raw } = useReadContract({
    address: poolAddress,
    abi: poolAbi,
    functionName: 'reserve0',
    query: { enabled: configured },
  })
  const { data: reserve1Raw } = useReadContract({
    address: poolAddress,
    abi: poolAbi,
    functionName: 'reserve1',
    query: { enabled: configured },
  })
  const { data: totalLiquidityRaw } = useReadContract({
    address: poolAddress,
    abi: poolAbi,
    functionName: 'totalLiquidity',
    query: { enabled: configured },
  })
  const { data: swapFeeBpsRaw } = useReadContract({
    address: poolAddress,
    abi: poolAbi,
    functionName: 'SWAP_FEE_BPS',
    query: { enabled: configured },
  })
  const { data: lpBalanceRaw } = useReadContract({
    address: poolAddress,
    abi: poolAbi,
    functionName: 'liquidityOf',
    args: address ? [address] : undefined,
    query: { enabled: configured && !!address },
  })
  const { data: bal0Raw } = useReadContract({
    address: token0Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: configured && !!address },
  })
  const { data: bal1Raw } = useReadContract({
    address: token1Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: configured && !!address },
  })
  const { data: poolBal0Raw } = useReadContract({
    address: token0Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [poolAddress],
    query: { enabled: configured },
  })
  const { data: poolBal1Raw } = useReadContract({
    address: token1Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [poolAddress],
    query: { enabled: configured },
  })
  const { data: pendingCommitmentRaw } = useReadContract({
    address: poolAddress,
    abi: poolAbi,
    functionName: 'swapCommitments',
    args: address ? [address] : undefined,
    query: { enabled: configured && !!address },
  })
  const { data: faucetCooldown0Raw } = useReadContract({
    address: token0Address,
    abi: erc20Abi,
    functionName: 'faucetCooldown',
    query: { enabled: configured && faucetEnabled },
  })
  const { data: faucetCooldown1Raw } = useReadContract({
    address: token1Address,
    abi: erc20Abi,
    functionName: 'faucetCooldown',
    query: { enabled: configured && faucetEnabled },
  })
  const { data: lastFaucetClaim0Raw } = useReadContract({
    address: token0Address,
    abi: erc20Abi,
    functionName: 'lastFaucetClaim',
    args: address ? [address] : undefined,
    query: { enabled: configured && faucetEnabled && !!address },
  })
  const { data: lastFaucetClaim1Raw } = useReadContract({
    address: token1Address,
    abi: erc20Abi,
    functionName: 'lastFaucetClaim',
    args: address ? [address] : undefined,
    query: { enabled: configured && faucetEnabled && !!address },
  })

  const token0 = useMemo<TokenSummary>(
    () => ({
      symbol: selectedPool?.token0Symbol ?? 'PSA',
      address: token0Address,
      decimals: decimals0,
      balance: bal0Raw as bigint | undefined,
      reserve: reserve0Raw as bigint | undefined,
      poolBalance: poolBal0Raw as bigint | undefined,
    }),
    [bal0Raw, decimals0, poolBal0Raw, reserve0Raw, selectedPool?.token0Symbol, token0Address],
  )
  const token1 = useMemo<TokenSummary>(
    () => ({
      symbol: selectedPool?.token1Symbol ?? 'PSB',
      address: token1Address,
      decimals: decimals1,
      balance: bal1Raw as bigint | undefined,
      reserve: reserve1Raw as bigint | undefined,
      poolBalance: poolBal1Raw as bigint | undefined,
    }),
    [bal1Raw, decimals1, poolBal1Raw, reserve1Raw, selectedPool?.token1Symbol, token1Address],
  )

  const tokenIn = zeroForOne ? token0 : token1
  const tokenOut = zeroForOne ? token1 : token0
  const wrongChain = isConnected && chainId !== sepolia.id
  const busy = ['commit', 'approve', 'approve0', 'approve1', 'swap', 'decrypt', 'liquidity', 'faucet'].includes(phase)

  const amountIn = useMemo(() => parseTokenAmount(amountStr, tokenIn.decimals), [amountStr, tokenIn.decimals])
  const liq0Desired = useMemo(() => parseTokenAmount(liq0Str, token0.decimals), [liq0Str, token0.decimals])
  const liq1Desired = useMemo(() => parseTokenAmount(liq1Str, token1.decimals), [liq1Str, token1.decimals])
  const totalLiquidity = totalLiquidityRaw as bigint | undefined
  const swapFeeBps = typeof swapFeeBpsRaw === 'bigint' ? Number(swapFeeBpsRaw) : 30
  const lpBalance = lpBalanceRaw as bigint | undefined
  const removeLiquidityAmount = lpBalance === undefined ? 0n : (lpBalance * BigInt(removeBps)) / 10_000n

  const { data: allowanceRaw } = useReadContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, poolAddress] : undefined,
    query: { enabled: configured && !!address },
  })
  const { data: allowance0Raw } = useReadContract({
    address: token0.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, poolAddress] : undefined,
    query: { enabled: configured && !!address },
  })
  const { data: allowance1Raw } = useReadContract({
    address: token1.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, poolAddress] : undefined,
    query: { enabled: configured && !!address },
  })
  const allowance = allowanceRaw as bigint | undefined
  const allowance0 = allowance0Raw as bigint | undefined
  const allowance1 = allowance1Raw as bigint | undefined
  const pendingCommitment = pendingCommitmentRaw as `0x${string}` | undefined
  const hasPendingCommitment = pendingCommitment !== undefined && pendingCommitment !== ZERO_HASH
  const faucetCooldown0 = faucetCooldown0Raw as bigint | undefined
  const faucetCooldown1 = faucetCooldown1Raw as bigint | undefined
  const lastFaucetClaim0 = lastFaucetClaim0Raw as bigint | undefined
  const lastFaucetClaim1 = lastFaucetClaim1Raw as bigint | undefined
  const now = BigInt(nowSec)
  const nextFaucet0 =
    faucetCooldown0 !== undefined && lastFaucetClaim0 !== undefined ? lastFaucetClaim0 + faucetCooldown0 : undefined
  const nextFaucet1 =
    faucetCooldown1 !== undefined && lastFaucetClaim1 !== undefined ? lastFaucetClaim1 + faucetCooldown1 : undefined
  const faucetCanClaim0 = faucetEnabled && nextFaucet0 !== undefined && now >= nextFaucet0
  const faucetCanClaim1 = faucetEnabled && nextFaucet1 !== undefined && now >= nextFaucet1
  const faucetCanClaimAny = faucetCanClaim0 || faucetCanClaim1
  const nextFaucetAt =
    nextFaucet0 === undefined
      ? nextFaucet1
      : nextFaucet1 === undefined
        ? nextFaucet0
        : nextFaucet0 < nextFaucet1
          ? nextFaucet0
          : nextFaucet1
  const faucetCooldownRemaining =
    faucetEnabled && !faucetCanClaimAny && nextFaucetAt !== undefined && nextFaucetAt > now ? nextFaucetAt - now : undefined

  const balanceTooLow = tokenIn.balance !== undefined && amountIn > tokenIn.balance
  const encryptedMathTooLarge =
    amountIn > UINT64_MAX ||
    (tokenIn.reserve !== undefined && tokenIn.reserve + amountIn > UINT64_MAX) ||
    (tokenOut.reserve !== undefined && amountIn > 0n && amountIn * tokenOut.reserve > UINT64_MAX)

  const { data: expectedOutRaw } = useReadContract({
    address: poolAddress,
    abi: poolAbi,
    functionName: 'getAmountOut',
    args: [amountIn, zeroForOne],
    query: { enabled: configured && amountIn > 0n && !encryptedMathTooLarge },
  })
  const expectedOut = expectedOutRaw as bigint | undefined

  const { data: addQuoteRaw } = useReadContract({
    address: poolAddress,
    abi: poolAbi,
    functionName: 'quoteAddLiquidity',
    args: [liq0Desired, liq1Desired],
    query: { enabled: configured && liq0Desired > 0n && liq1Desired > 0n },
  })
  const addQuote = addQuoteRaw as readonly [bigint, bigint, bigint] | undefined

  const { data: removeQuoteRaw } = useReadContract({
    address: poolAddress,
    abi: poolAbi,
    functionName: 'quoteRemoveLiquidity',
    args: [removeLiquidityAmount],
    query: { enabled: configured && removeLiquidityAmount > 0n },
  })
  const removeQuote = removeQuoteRaw as readonly [bigint, bigint] | undefined

  const minOut = useMemo(() => {
    if (!expectedOut || expectedOut === 0n) return 0n
    return (expectedOut * (10_000n - BigInt(slippageBps))) / 10_000n
  }, [expectedOut, slippageBps])

  const minLiquidity = useMemo(() => {
    const quoted = addQuote?.[2]
    if (!quoted || quoted === 0n) return 0n
    return (quoted * (10_000n - BigInt(slippageBps))) / 10_000n
  }, [addQuote, slippageBps])

  const minRemove0 = useMemo(() => {
    const quoted = removeQuote?.[0]
    if (!quoted || quoted === 0n) return 0n
    return (quoted * (10_000n - BigInt(slippageBps))) / 10_000n
  }, [removeQuote, slippageBps])
  const minRemove1 = useMemo(() => {
    const quoted = removeQuote?.[1]
    if (!quoted || quoted === 0n) return 0n
    return (quoted * (10_000n - BigInt(slippageBps))) / 10_000n
  }, [removeQuote, slippageBps])

  const priceImpactBps = useMemo(() => {
    if (!tokenIn.reserve || !tokenOut.reserve || !expectedOut || amountIn === 0n) return undefined
    const spotOut = (amountIn * tokenOut.reserve) / tokenIn.reserve
    if (spotOut === 0n || spotOut <= expectedOut) return 0
    return Number(((spotOut - expectedOut) * 10_000n) / spotOut)
  }, [amountIn, expectedOut, tokenIn.reserve, tokenOut.reserve])

  const poolShareBps = useMemo(() => {
    if (!lpBalance || !totalLiquidity || totalLiquidity === 0n) return undefined
    return Number((lpBalance * 10_000n) / totalLiquidity)
  }, [lpBalance, totalLiquidity])

  const liquidityBalanceTooLow =
    (token0.balance !== undefined && addQuote !== undefined && addQuote[0] > token0.balance) ||
    (token1.balance !== undefined && addQuote !== undefined && addQuote[1] > token1.balance)
  const poolHealthReady =
    token0.reserve !== undefined &&
    token1.reserve !== undefined &&
    token0.poolBalance !== undefined &&
    token1.poolBalance !== undefined
  const poolBalancesMatch =
    poolHealthReady &&
    token0.reserve === token0.poolBalance &&
    token1.reserve === token1.poolBalance
  const healthLabel = !configured ? 'Unconfigured' : !poolHealthReady ? 'Loading' : poolBalancesMatch ? 'Ready' : 'Check'
  const healthPillClass = !poolHealthReady || poolBalancesMatch ? 'network-pill' : 'network-pill network-pill--bad'
  const needsApprove = amountIn > 0n && (!allowance || allowance < amountIn)
  const addNeedsApprove0 = addQuote !== undefined && (!allowance0 || allowance0 < addQuote[0])
  const addNeedsApprove1 = addQuote !== undefined && (!allowance1 || allowance1 < addQuote[1])

  const canSubmit =
    configured &&
    isConnected &&
    !wrongChain &&
    cofheReady &&
    !cofheConnecting &&
    amountIn > 0n &&
    expectedOut !== undefined &&
    expectedOut > 0n &&
    !encryptedMathTooLarge &&
    !balanceTooLow &&
    !busy
  const canAddLiquidity =
    configured &&
    isConnected &&
    !wrongChain &&
    addQuote !== undefined &&
    addQuote[2] > 0n &&
    !liquidityBalanceTooLow &&
    !busy
  const canRemoveLiquidity =
    configured &&
    isConnected &&
    !wrongChain &&
    lpBalance !== undefined &&
    removeLiquidityAmount > 0n &&
    removeQuote !== undefined &&
    !busy

  const swapActionLabel = !isConnected
    ? 'Connect wallet'
    : wrongChain
      ? 'Switch to Sepolia'
      : !cofheReady || cofheConnecting
        ? 'Waiting for CoFHE'
        : busy && phase !== 'faucet'
          ? phaseLabels[phase]
          : needsApprove
            ? 'Approve and swap'
            : 'Swap and decrypt'
  const swapActionDisabled = !configured || busy || walletPending || (isConnected && !wrongChain && !canSubmit)
  const addLiquidityLabel = !isConnected
    ? 'Connect wallet'
    : wrongChain
      ? 'Switch to Sepolia'
      : busy
        ? phaseLabels[phase]
        : addNeedsApprove0 || addNeedsApprove1
          ? 'Approve and add'
          : 'Add liquidity'
  const addLiquidityDisabled = !configured || busy || walletPending || (isConnected && !wrongChain && !canAddLiquidity)
  const removeLiquidityLabel = !isConnected
    ? 'Connect wallet'
    : wrongChain
      ? 'Switch to Sepolia'
      : busy
        ? phaseLabels[phase]
        : 'Remove liquidity'
  const removeLiquidityDisabled = !configured || busy || walletPending || (isConnected && !wrongChain && !canRemoveLiquidity)
  const faucetActionLabel = !isConnected
    ? 'Connect for faucet'
    : wrongChain
      ? 'Switch to Sepolia'
      : busy && phase === 'faucet'
        ? phaseLabels[phase]
        : faucetCooldownRemaining !== undefined
          ? `Faucet in ${formatDuration(faucetCooldownRemaining)}`
          : 'Claim test tokens'
  const faucetActionDisabled = !configured || busy || walletPending || (isConnected && !wrongChain && !faucetCanClaimAny)
  const executionSteps: TxPhase[] =
    phase === 'faucet' ? ['faucet'] : mode === 'liquidity' ? ['approve0', 'approve1', 'liquidity'] : ['commit', 'approve', 'swap', 'decrypt']

  const handleSwitchToSepolia = useCallback(() => {
    switchChain({ chainId: sepolia.id })
  }, [switchChain])

  const invalidateReads = useCallback(async () => {
    await queryClient.invalidateQueries()
  }, [queryClient])

  const refreshHistory = useCallback(async () => {
    if (!configured || !publicClient) return
    setHistoryLoading(true)
    setHistoryErr(null)
    try {
      const latest = await publicClient.getBlockNumber()
      const earliest = latest > SWAP_LOOKBACK_BLOCKS ? latest - SWAP_LOOKBACK_BLOCKS : 0n
      let toBlock = latest
      const logs: Awaited<ReturnType<typeof publicClient.getLogs>> = []

      while (toBlock >= earliest && logs.length < 8) {
        const fromBlock =
          toBlock > SWAP_LOG_CHUNK_BLOCKS && toBlock - SWAP_LOG_CHUNK_BLOCKS + 1n > earliest
            ? toBlock - SWAP_LOG_CHUNK_BLOCKS + 1n
            : earliest
        const chunk = await publicClient.getLogs({
          address: poolAddress,
          event: swapEvent,
          fromBlock,
          toBlock,
        })
        logs.unshift(...chunk)
        if (fromBlock === earliest || fromBlock === 0n) break
        toBlock = fromBlock - 1n
      }

      const rows = logs
        .slice(-8)
        .reverse()
        .map((log) => ({
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          user: log.args.user ?? ZERO,
          zeroForOne: Boolean(log.args.zeroForOne),
          amountIn: BigInt(log.args.amountIn ?? 0n),
          amountOut: BigInt(log.args.amountOut ?? 0n),
        }))
      setHistory(rows)
    } catch (error) {
      setHistory([])
      setHistoryErr('Recent activity is temporarily unavailable from the public RPC. Refresh again in a moment.')
    } finally {
      setHistoryLoading(false)
    }
  }, [configured, poolAddress, publicClient])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  useEffect(() => {
    const timer = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const connectWallet = useCallback(() => {
    const connector = connectors[0]
    if (connector) connect({ connector, chainId: sepolia.id })
  }, [connect, connectors])

  const resetResult = useCallback(() => {
    setErr(null)
    setLastOutPlain(null)
    setLastEncPlain(null)
    setStatusMsg('')
  }, [])

  const watchToken = useCallback(async (token: TokenSummary) => {
    resetResult()
    const ethereum = (window as Window & {
      ethereum?: {
        request: (args: {
          method: string
          params?: unknown
        }) => Promise<unknown>
      }
    }).ethereum

    if (!ethereum) {
      setErr('No injected wallet found.')
      return
    }

    try {
      await ethereum.request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC20',
          options: {
            address: token.address,
            symbol: token.symbol,
            decimals: token.decimals,
          },
        },
      })
      setStatusMsg(`${token.symbol} added to wallet.`)
    } catch (error) {
      setErr(compactError(error))
    }
  }, [resetResult])

  const runFaucet = useCallback(async () => {
    resetResult()
    if (!faucetEnabled) {
      setErr('Token claiming is disabled for this deployment.')
      return
    }
    if (!configured || !address) {
      setErr('Connect a wallet before claiming test tokens.')
      return
    }
    if (chainId !== sepolia.id) {
      setErr('Switch to Ethereum Sepolia.')
      return
    }
    if (!faucetCanClaimAny) {
      setErr(
        faucetCooldownRemaining !== undefined
          ? `Token faucet is cooling down. Try again in ${formatDuration(faucetCooldownRemaining)}.`
          : 'Token faucet is not ready yet.',
      )
      return
    }

    try {
      setPhase('faucet')
      let claimed = 0

      if (faucetCanClaim0) {
        setStatusMsg(`Claiming ${token0.symbol}...`)
        const hash0 = await writeContractAsync({
          address: token0.address,
          abi: erc20Abi,
          functionName: 'claimFaucet',
        })
        claimed += 1
        setTxHash(hash0)
        await waitForTransactionReceipt(wagmiConfig, { hash: hash0 })
      }

      if (faucetCanClaim1) {
        setStatusMsg(`Claiming ${token1.symbol}...`)
        const hash1 = await writeContractAsync({
          address: token1.address,
          abi: erc20Abi,
          functionName: 'claimFaucet',
        })
        claimed += 1
        setTxHash(hash1)
        await waitForTransactionReceipt(wagmiConfig, { hash: hash1 })
      }

      await invalidateReads()
      setPhase('done')
      setStatusMsg(claimed === 2 ? 'Test tokens claimed.' : 'Available test token claimed.')
    } catch (error) {
      setPhase('error')
      setErr(compactError(error))
      setStatusMsg('')
    }
  }, [
    address,
    chainId,
    configured,
    faucetCanClaim0,
    faucetCanClaim1,
    faucetCanClaimAny,
    faucetCooldownRemaining,
    faucetEnabled,
    invalidateReads,
    resetResult,
    token0.address,
    token0.symbol,
    token1.address,
    token1.symbol,
    writeContractAsync,
  ])

  const runCancelCommitment = useCallback(async () => {
    resetResult()
    if (!configured || !address || !hasPendingCommitment) {
      setErr('No pending commitment found for this wallet.')
      return
    }
    if (chainId !== sepolia.id) {
      setErr('Switch to Ethereum Sepolia.')
      return
    }

    try {
      setPhase('commit')
      setStatusMsg('Cancelling pending commitment...')
      const hash = await writeContractAsync({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'cancelCommitment',
      })
      setTxHash(hash)
      await waitForTransactionReceipt(wagmiConfig, { hash })
      await invalidateReads()
      setPhase('done')
      setStatusMsg('Pending commitment cancelled.')
    } catch (error) {
      setPhase('error')
      setErr(compactError(error))
      setStatusMsg('')
    }
  }, [address, chainId, configured, hasPendingCommitment, invalidateReads, poolAddress, resetResult, writeContractAsync])

  const runSwap = useCallback(async () => {
    resetResult()
    if (!configured || !address || !cofheClient || !cofheReady) {
      setErr('Connect wallet and CoFHE first.')
      return
    }
    if (chainId !== sepolia.id) {
      setErr('Switch to Ethereum Sepolia.')
      return
    }
    if (amountIn === 0n) {
      setErr('Enter a non-zero amount.')
      return
    }
    if (encryptedMathTooLarge) {
      setErr('Amount is too large for the encrypted uint64 AMM mirror.')
      return
    }
    if (balanceTooLow) {
      setErr(`Insufficient ${tokenIn.symbol} balance.`)
      return
    }
    if (expectedOut === undefined || expectedOut === 0n) {
      setErr('Pool quote is unavailable.')
      return
    }

    try {
      if (needsApprove) {
        setPhase('approve')
        setStatusMsg(`Approving ${tokenIn.symbol}...`)
        const approveHash = await writeContractAsync({
          address: tokenIn.address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [poolAddress, amountIn],
        })
        setTxHash(approveHash)
        await waitForTransactionReceipt(wagmiConfig, { hash: approveHash })
      }

      const deadline = deadlineFromNow()
      let salt = ZERO_HASH
      if (useCommitment) {
        salt = randomBytes32()
        const commitment = keccak256(
          encodeAbiParameters(commitmentParams, [
            address,
            amountIn,
            minOut,
            zeroForOne,
            salt,
            poolAddress,
            BigInt(sepolia.id),
            deadline,
          ]),
        )

        setPhase('commit')
        setStatusMsg('Committing swap intent...')
        const commitHash = await writeContractAsync({
          address: poolAddress,
          abi: poolAbi,
          functionName: 'commitSwap',
          args: [commitment],
        })
        setTxHash(commitHash)
        await waitForTransactionReceipt(wagmiConfig, { hash: commitHash })
      }

      setPhase('swap')
      setStatusMsg('Submitting swap...')
      const swapHash = await writeContractAsync(
        useCommitment
          ? {
              address: poolAddress,
              abi: poolAbi,
              functionName: 'swapWithCommitment',
              args: [amountIn, minOut, zeroForOne, salt, deadline],
            }
          : {
              address: poolAddress,
              abi: poolAbi,
              functionName: 'swap',
              args: [amountIn, minOut, zeroForOne, deadline],
            },
      )
      setTxHash(swapHash)
      const swapReceipt = await waitForTransactionReceipt(wagmiConfig, { hash: swapHash })
      const settledOut = swapAmountOutFromLogs(swapReceipt.logs, poolAddress)
      if (settledOut === undefined) throw new Error('Swap event was not found in the transaction receipt.')
      await invalidateReads()
      await refreshHistory()

      setPhase('decrypt')
      setStatusMsg('Decrypting encrypted amount out...')
      if (!publicClient) throw new Error('Public client is not ready.')
      const handle = await publicClient.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'lastEncAmountOutOf',
        args: [address],
      })
      const decryptedRaw = await decryptUint64WithRetry(cofheClient, BigInt(handle as bigint | string))
      if (decryptedRaw !== settledOut) {
        throw new Error('FHE decrypted output did not match the settled AMM output.')
      }

      setLastOutPlain(formatToken(settledOut, tokenOut.decimals))
      setLastEncPlain(formatToken(decryptedRaw, tokenOut.decimals))
      setPhase('done')
      setStatusMsg('Swap complete.')
    } catch (error) {
      setPhase('error')
      setErr(compactError(error))
      setStatusMsg('')
    }
  }, [
    address,
    amountIn,
    balanceTooLow,
    chainId,
    cofheClient,
    cofheReady,
    configured,
    encryptedMathTooLarge,
    expectedOut,
    invalidateReads,
    minOut,
    needsApprove,
    poolAddress,
    publicClient,
    refreshHistory,
    resetResult,
    tokenIn.address,
    tokenIn.symbol,
    tokenOut.decimals,
    useCommitment,
    writeContractAsync,
    zeroForOne,
  ])

  const runAddLiquidity = useCallback(async () => {
    resetResult()
    if (!configured || !address || !addQuote) {
      setErr('Connect a wallet and enter both liquidity amounts.')
      return
    }
    if (chainId !== sepolia.id) {
      setErr('Switch to Ethereum Sepolia.')
      return
    }
    if (liquidityBalanceTooLow) {
      setErr('Insufficient token balance for the quoted liquidity add.')
      return
    }

    try {
      if (addNeedsApprove0) {
        setPhase('approve0')
        setStatusMsg(`Approving ${token0.symbol}...`)
        const approveHash = await writeContractAsync({
          address: token0.address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [poolAddress, addQuote[0]],
        })
        setTxHash(approveHash)
        await waitForTransactionReceipt(wagmiConfig, { hash: approveHash })
      }

      if (addNeedsApprove1) {
        setPhase('approve1')
        setStatusMsg(`Approving ${token1.symbol}...`)
        const approveHash = await writeContractAsync({
          address: token1.address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [poolAddress, addQuote[1]],
        })
        setTxHash(approveHash)
        await waitForTransactionReceipt(wagmiConfig, { hash: approveHash })
      }

      setPhase('liquidity')
      setStatusMsg('Adding liquidity...')
      const hash = await writeContractAsync({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'addLiquidity',
        args: [liq0Desired, liq1Desired, minLiquidity, deadlineFromNow()],
      })
      setTxHash(hash)
      await waitForTransactionReceipt(wagmiConfig, { hash })
      await invalidateReads()
      setPhase('done')
      setStatusMsg('Liquidity added.')
    } catch (error) {
      setPhase('error')
      setErr(compactError(error))
      setStatusMsg('')
    }
  }, [
    addNeedsApprove0,
    addNeedsApprove1,
    addQuote,
    address,
    chainId,
    configured,
    invalidateReads,
    liq0Desired,
    liq1Desired,
    liquidityBalanceTooLow,
    minLiquidity,
    poolAddress,
    resetResult,
    token0.address,
    token0.symbol,
    token1.address,
    token1.symbol,
    writeContractAsync,
  ])

  const runRemoveLiquidity = useCallback(async () => {
    resetResult()
    if (!configured || !address || !removeQuote || removeLiquidityAmount === 0n) {
      setErr('No LP position selected for removal.')
      return
    }
    if (chainId !== sepolia.id) {
      setErr('Switch to Ethereum Sepolia.')
      return
    }

    try {
      setPhase('liquidity')
      setStatusMsg('Removing liquidity...')
      const hash = await writeContractAsync({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'removeLiquidity',
        args: [removeLiquidityAmount, minRemove0, minRemove1, deadlineFromNow()],
      })
      setTxHash(hash)
      await waitForTransactionReceipt(wagmiConfig, { hash })
      await invalidateReads()
      setPhase('done')
      setStatusMsg('Liquidity removed.')
    } catch (error) {
      setPhase('error')
      setErr(compactError(error))
      setStatusMsg('')
    }
  }, [
    address,
    chainId,
    configured,
    invalidateReads,
    minRemove0,
    minRemove1,
    poolAddress,
    removeLiquidityAmount,
    removeQuote,
    resetResult,
    writeContractAsync,
  ])

  return (
    <>
      <AnimatedBackground />
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <img src={heroMark} alt="" className="brand-mark" />
            <div>
              <p className="eyebrow">Sepolia confidential AMM</p>
              <h1>PrivateSwap</h1>
            </div>
          </div>

          <div className="wallet-bar">
            <span className={wrongChain ? 'network-pill network-pill--bad' : 'network-pill'}>Sepolia</span>
            {!isConnected ? (
              <button type="button" className="btn btn-primary" onClick={connectWallet} disabled={walletPending}>
                {walletPending ? 'Connecting' : 'Connect'}
              </button>
            ) : (
              <>
                <span className="address-chip">{shortAddress(address)}</span>
                <button type="button" className="btn btn-ghost" onClick={() => disconnect()}>
                  Disconnect
                </button>
              </>
            )}
          </div>
        </header>

        {!configured && (
          <section className="notice notice-danger">
            Set VITE_POOL_ADDRESS, VITE_TOKEN0_ADDRESS, and VITE_TOKEN1_ADDRESS in apps/web/.env.
          </section>
        )}

        <main className="main-grid">
          <section className="panel swap-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">{mode === 'swap' ? 'Trade' : 'Liquidity'}</p>
                <h2>{mode === 'swap' ? `${tokenIn.symbol} to ${tokenOut.symbol}` : `${token0.symbol} / ${token1.symbol}`}</h2>
              </div>
              <div className="panel-actions">
                {poolConfigs.length > 1 && (
                  <select
                    className="route-select"
                    value={selectedPoolId}
                    onChange={(event) => {
                      setSelectedPoolId(event.target.value)
                      resetResult()
                    }}
                    aria-label="Pool"
                  >
                    {poolConfigs.map((pool) => (
                      <option key={pool.id} value={pool.id}>
                        {pool.label}
                      </option>
                    ))}
                  </select>
                )}
                {mode === 'swap' && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Flip direction"
                    title="Flip direction"
                    onClick={() => {
                      setZeroForOne((value) => !value)
                      resetResult()
                    }}
                  >
                    <span aria-hidden="true">⇅</span>
                  </button>
                )}
              </div>
            </div>

            <div className="mode-tabs" aria-label="Mode">
              <button
                type="button"
                className={mode === 'swap' ? 'segmented segmented--active' : 'segmented'}
                onClick={() => setMode('swap')}
              >
                Swap
              </button>
              <button
                type="button"
                className={mode === 'liquidity' ? 'segmented segmented--active' : 'segmented'}
                onClick={() => setMode('liquidity')}
              >
                Liquidity
              </button>
            </div>

            {wrongChain && (
              <button type="button" className="btn btn-primary full-width" onClick={handleSwitchToSepolia}>
                Switch to Sepolia
              </button>
            )}

            {mode === 'swap' ? (
              <>
                <div className="token-input">
                  <div className="token-input__meta">
                    <span>Amount in</span>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        if (tokenIn.balance !== undefined) setAmountStr(formatUnits(tokenIn.balance, tokenIn.decimals))
                      }}
                      disabled={!tokenIn.balance || tokenIn.balance === 0n}
                    >
                      Max {formatToken(tokenIn.balance, tokenIn.decimals)}
                    </button>
                  </div>
                  <div className="token-input__row">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={amountStr}
                      onChange={(event) => {
                        setAmountStr(event.target.value)
                        resetResult()
                      }}
                      aria-label={`${tokenIn.symbol} amount`}
                    />
                    <span className="token-badge">{tokenIn.symbol}</span>
                  </div>
                </div>

                <div className="quote-box">
                  <Metric label="Expected out" value={`${formatToken(expectedOut, tokenOut.decimals)} ${tokenOut.symbol}`} />
                  <Metric label="Minimum out" value={`${formatToken(minOut, tokenOut.decimals)} ${tokenOut.symbol}`} />
                  <Metric label="Price impact" value={formatBps(priceImpactBps)} />
                  <Metric label="LP fee" value={formatBps(swapFeeBps)} />
                </div>

                <div className="control-row">
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={useCommitment}
                      onChange={(event) => setUseCommitment(event.target.checked)}
                    />
                    <span>Pre-commit intent</span>
                  </label>
                  {hasPendingCommitment && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy || wrongChain}
                      onClick={() => void runCancelCommitment()}
                    >
                      Cancel pending
                    </button>
                  )}
                </div>
                {hasPendingCommitment && (
                  <p className="form-hint muted">A pending committed intent is stored for this wallet.</p>
                )}

                <button
                  type="button"
                  className="btn btn-primary full-width"
                  disabled={swapActionDisabled}
                  onClick={() => {
                    if (!isConnected) connectWallet()
                    else if (wrongChain) handleSwitchToSepolia()
                    else void runSwap()
                  }}
                >
                  {swapActionLabel}
                </button>

                {balanceTooLow && <p className="form-hint danger-text">Insufficient {tokenIn.symbol} balance.</p>}
                {encryptedMathTooLarge && <p className="form-hint danger-text">Amount exceeds the encrypted AMM safety bound.</p>}
              </>
            ) : (
              <>
                <div className="liquidity-grid">
                  <div className="token-input token-input--compact">
                    <div className="token-input__meta">
                      <span>{token0.symbol}</span>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          if (token0.balance !== undefined) setLiq0Str(formatUnits(token0.balance, token0.decimals))
                        }}
                        disabled={!token0.balance || token0.balance === 0n}
                      >
                        Max
                      </button>
                    </div>
                    <div className="token-input__row">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={liq0Str}
                        onChange={(event) => {
                          setLiq0Str(event.target.value)
                          resetResult()
                        }}
                        aria-label={`${token0.symbol} liquidity amount`}
                      />
                    </div>
                  </div>
                  <div className="token-input token-input--compact">
                    <div className="token-input__meta">
                      <span>{token1.symbol}</span>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          if (token1.balance !== undefined) setLiq1Str(formatUnits(token1.balance, token1.decimals))
                        }}
                        disabled={!token1.balance || token1.balance === 0n}
                      >
                        Max
                      </button>
                    </div>
                    <div className="token-input__row">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={liq1Str}
                        onChange={(event) => {
                          setLiq1Str(event.target.value)
                          resetResult()
                        }}
                        aria-label={`${token1.symbol} liquidity amount`}
                      />
                    </div>
                  </div>
                </div>

                <div className="quote-box">
                  <Metric label={`${token0.symbol} used`} value={formatToken(addQuote?.[0], token0.decimals)} />
                  <Metric label={`${token1.symbol} used`} value={formatToken(addQuote?.[1], token1.decimals)} />
                  <Metric label="LP minted" value={formatToken(addQuote?.[2], 6)} />
                </div>

                <button
                  type="button"
                  className="btn btn-primary full-width"
                  disabled={addLiquidityDisabled}
                  onClick={() => {
                    if (!isConnected) connectWallet()
                    else if (wrongChain) handleSwitchToSepolia()
                    else void runAddLiquidity()
                  }}
                >
                  {addLiquidityLabel}
                </button>

                <div className="remove-box">
                  <div className="token-input__meta">
                    <span>Remove position</span>
                    <strong>{removeBps / 100}%</strong>
                  </div>
                  <input
                    className="range-input"
                    type="range"
                    min="0"
                    max="10000"
                    step="500"
                    value={removeBps}
                    onChange={(event) => setRemoveBps(Number(event.target.value))}
                    aria-label="Remove liquidity percentage"
                  />
                  <div className="result-grid">
                    <Metric label={token0.symbol} value={formatToken(removeQuote?.[0], token0.decimals)} />
                    <Metric label={token1.symbol} value={formatToken(removeQuote?.[1], token1.decimals)} />
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary full-width"
                    disabled={removeLiquidityDisabled}
                    onClick={() => {
                      if (!isConnected) connectWallet()
                      else if (wrongChain) handleSwitchToSepolia()
                      else void runRemoveLiquidity()
                    }}
                  >
                    {removeLiquidityLabel}
                  </button>
                </div>

                {liquidityBalanceTooLow && <p className="form-hint danger-text">Insufficient balance for the quoted deposit.</p>}
              </>
            )}

            <div className="slippage-row" aria-label="Slippage">
              {[50, 100, 250, 500].map((value) => (
                <button
                  key={value}
                  type="button"
                  className={slippageBps === value ? 'segmented segmented--active' : 'segmented'}
                  onClick={() => setSlippageBps(value)}
                >
                  {(value / 100).toFixed(value % 100 === 0 ? 0 : 1)}%
                </button>
              ))}
            </div>
          </section>

          <aside className="side-stack">
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Wallet</p>
                  <h2>Balances</h2>
                </div>
                <div className="wallet-actions">
                  <button type="button" className="text-button" disabled={!configured} onClick={() => void watchToken(token0)}>
                    Add {token0.symbol}
                  </button>
                  <button type="button" className="text-button" disabled={!configured} onClick={() => void watchToken(token1)}>
                    Add {token1.symbol}
                  </button>
                  {faucetEnabled && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={faucetActionDisabled}
                      onClick={() => {
                        if (!isConnected) connectWallet()
                        else if (wrongChain) handleSwitchToSepolia()
                        else void runFaucet()
                      }}
                    >
                      {faucetActionLabel}
                    </button>
                  )}
                </div>
              </div>
              <TokenBalance token={token0} />
              <TokenBalance token={token1} />
              <div className="asset-row">
                <span>LP</span>
                <strong>{formatToken(lpBalance, 6)}</strong>
              </div>
              {faucetEnabled && isConnected && !wrongChain && faucetCooldownRemaining !== undefined && (
                <p className="form-hint muted">Next faucet claim in {formatDuration(faucetCooldownRemaining)}.</p>
              )}
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Pool</p>
                  <h2>Liquidity</h2>
                </div>
                <span className={healthPillClass}>{healthLabel}</span>
              </div>
              <TokenReserve token={token0} />
              <TokenReserve token={token1} />
              <div className="asset-row">
                <span>Total LP</span>
                <strong>{formatToken(totalLiquidity, 6)}</strong>
              </div>
              <div className="asset-row">
                <span>Your share</span>
                <strong>{formatBps(poolShareBps)}</strong>
              </div>
              <div className="asset-row">
                <span>Pool</span>
                <strong>{shortAddress(poolAddress)}</strong>
              </div>
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Activity</p>
                  <h2>Recent swaps</h2>
                </div>
                <button type="button" className="text-button" onClick={() => void refreshHistory()} disabled={historyLoading}>
                  Refresh
                </button>
              </div>
              <div className="history-list">
                {history.length === 0 ? (
                  <p className="muted">{historyLoading ? 'Loading...' : historyErr || 'No recent swaps.'}</p>
                ) : (
                  history.map((item) => (
                    <a
                      className="history-row"
                      key={`${item.txHash}-${item.blockNumber.toString()}`}
                      href={`https://sepolia.etherscan.io/tx/${item.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span>{item.zeroForOne ? `${token0.symbol} -> ${token1.symbol}` : `${token1.symbol} -> ${token0.symbol}`}</span>
                      <strong>
                        {formatToken(item.amountIn, item.zeroForOne ? token0.decimals : token1.decimals)} /{' '}
                        {formatToken(item.amountOut, item.zeroForOne ? token1.decimals : token0.decimals)}
                      </strong>
                      <small>{shortAddress(item.user)}</small>
                    </a>
                  ))
                )}
              </div>
            </section>
          </aside>
        </main>

        <section className="status-panel">
          <div className="status-card">
            <p className="eyebrow">CoFHE</p>
            <h3 className={cofheErr ? 'danger-text' : cofheReady ? 'success-text' : ''}>
              {cofheErr ? 'Error' : cofheReady ? 'Ready' : cofheConnecting ? 'Initializing' : 'Waiting'}
            </h3>
            {cofheErr && (
              <button type="button" className="text-button" onClick={() => retryCofhe()}>
                Retry
              </button>
            )}
          </div>
          <div className="status-card status-card--wide">
            <p className="eyebrow">Execution</p>
            <div className="phase-track">
              {executionSteps.map((step) => (
                <span key={step} className={phase === step ? 'phase-pill phase-pill--active' : 'phase-pill'}>
                  {phaseLabels[step]}
                </span>
              ))}
            </div>
          </div>
          <div className="status-card">
            <p className="eyebrow">Last tx</p>
            {txHash ? (
              <a href={`https://sepolia.etherscan.io/tx/${txHash}`} target="_blank" rel="noreferrer">
                {shortAddress(txHash)}
              </a>
            ) : (
              <span className="muted">--</span>
            )}
          </div>
        </section>

        {(statusMsg || err || cofheErr || lastOutPlain || lastEncPlain) && (
          <section className={err || cofheErr ? 'notice notice-danger' : 'notice'}>
            {statusMsg && <p>{statusMsg}</p>}
            {err && <p>{err}</p>}
            {cofheErr && <p>{cofheErr}</p>}
            {(lastOutPlain || lastEncPlain) && (
              <div className="result-grid">
                <Metric label="AMM output" value={`${lastOutPlain ?? '--'} ${tokenOut.symbol}`} />
                <Metric label="FHE decrypted" value={`${lastEncPlain ?? '--'} ${tokenOut.symbol}`} />
              </div>
            )}
          </section>
        )}

        <footer className="app-footer">
          <span>Live Sepolia: CoFHE math, committed intents, LP management.</span>
          <a href="https://cofhe-docs.fhenix.zone/" target="_blank" rel="noreferrer">
            CoFHE docs
          </a>
        </footer>
      </div>
    </>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function TokenBalance({ token }: { token: TokenSummary }) {
  return (
    <div className="asset-row">
      <span className="token-badge">{token.symbol}</span>
      <strong>{formatToken(token.balance, token.decimals)}</strong>
    </div>
  )
}

function TokenReserve({ token }: { token: TokenSummary }) {
  return (
    <div className="asset-row">
      <span>{token.symbol}</span>
      <strong>{formatToken(token.reserve, token.decimals)}</strong>
    </div>
  )
}
