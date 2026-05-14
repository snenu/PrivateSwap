import { useCallback, useMemo, useState } from 'react'
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
import { formatUnits, parseUnits } from 'viem'
import { sepolia } from 'wagmi/chains'
import { FheTypes } from '@cofhe/sdk'
import { erc20Abi, poolAbi } from './contracts'
import { useCofhe } from './useCofhe'
import { wagmiConfig } from './wagmi'
import { AnimatedBackground } from './components/AnimatedBackground'
import heroMark from './assets/hero.png'

const ZERO = '0x0000000000000000000000000000000000000000' as const
const UINT64_MAX = (1n << 64n) - 1n

type TxPhase = 'idle' | 'approve' | 'swap' | 'decrypt' | 'faucet' | 'done' | 'error'

type TokenSummary = {
  symbol: 'PSA' | 'PSB'
  address: `0x${string}`
  decimals: number
  balance?: bigint
  reserve?: bigint
}

const phaseLabels: Record<TxPhase, string> = {
  idle: 'Ready',
  approve: 'Approving',
  swap: 'Swapping',
  decrypt: 'Decrypting',
  faucet: 'Claiming',
  done: 'Complete',
  error: 'Needs attention',
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

export default function App() {
  const queryClient = useQueryClient()
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { connect, connectors, isPending: walletPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const publicClient = usePublicClient()
  const {
    client: cofheClient,
    ready: cofheReady,
    connecting: cofheConnecting,
    error: cofheErr,
    retry: retryCofhe,
  } = useCofhe()

  const poolAddress = (import.meta.env.VITE_POOL_ADDRESS || ZERO) as `0x${string}`
  const token0Address = (import.meta.env.VITE_TOKEN0_ADDRESS || ZERO) as `0x${string}`
  const token1Address = (import.meta.env.VITE_TOKEN1_ADDRESS || ZERO) as `0x${string}`
  const configured = poolAddress !== ZERO && token0Address !== ZERO && token1Address !== ZERO
  const faucetEnabled = import.meta.env.VITE_ENABLE_FAUCET !== 'false'

  const [amountStr, setAmountStr] = useState('10')
  const [zeroForOne, setZeroForOne] = useState(true)
  const [slippageBps, setSlippageBps] = useState(100)
  const [phase, setPhase] = useState<TxPhase>('idle')
  const [statusMsg, setStatusMsg] = useState('')
  const [lastOutPlain, setLastOutPlain] = useState<string | null>(null)
  const [lastEncPlain, setLastEncPlain] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>()
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

  const token0 = useMemo<TokenSummary>(
    () => ({
      symbol: 'PSA',
      address: token0Address,
      decimals: decimals0,
      balance: bal0Raw as bigint | undefined,
      reserve: reserve0Raw as bigint | undefined,
    }),
    [bal0Raw, decimals0, reserve0Raw, token0Address],
  )
  const token1 = useMemo<TokenSummary>(
    () => ({
      symbol: 'PSB',
      address: token1Address,
      decimals: decimals1,
      balance: bal1Raw as bigint | undefined,
      reserve: reserve1Raw as bigint | undefined,
    }),
    [bal1Raw, decimals1, reserve1Raw, token1Address],
  )

  const tokenIn = zeroForOne ? token0 : token1
  const tokenOut = zeroForOne ? token1 : token0
  const wrongChain = isConnected && chainId !== sepolia.id
  const busy = phase === 'approve' || phase === 'swap' || phase === 'decrypt' || phase === 'faucet'

  const amountIn = useMemo(() => {
    try {
      if (!amountStr.trim()) return 0n
      return parseUnits(amountStr, tokenIn.decimals)
    } catch {
      return 0n
    }
  }, [amountStr, tokenIn.decimals])

  const { data: allowanceRaw } = useReadContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address && poolAddress ? [address, poolAddress] : undefined,
    query: { enabled: configured && !!address },
  })
  const allowance = allowanceRaw as bigint | undefined

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

  const minOut = useMemo(() => {
    if (!expectedOut || expectedOut === 0n) return 0n
    return (expectedOut * (10_000n - BigInt(slippageBps))) / 10_000n
  }, [expectedOut, slippageBps])

  const priceImpactBps = useMemo(() => {
    if (!tokenIn.reserve || !tokenOut.reserve || !expectedOut || amountIn === 0n) return undefined
    const spotOut = (amountIn * tokenOut.reserve) / tokenIn.reserve
    if (spotOut === 0n || spotOut <= expectedOut) return 0
    return Number(((spotOut - expectedOut) * 10_000n) / spotOut)
  }, [amountIn, expectedOut, tokenIn.reserve, tokenOut.reserve])

  const needsApprove = amountIn > 0n && (!allowance || allowance < amountIn)
  const canSubmit =
    configured &&
    isConnected &&
    !wrongChain &&
    cofheReady &&
    !cofheConnecting &&
    amountIn > 0n &&
    !encryptedMathTooLarge &&
    !balanceTooLow &&
    !busy

  const invalidateReads = useCallback(async () => {
    await queryClient.invalidateQueries()
  }, [queryClient])

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

    try {
      setPhase('faucet')
      setStatusMsg('Claiming PSA...')
      const hash0 = await writeContractAsync({
        address: token0.address,
        abi: erc20Abi,
        functionName: 'claimFaucet',
      })
      setTxHash(hash0)
      await waitForTransactionReceipt(wagmiConfig, { hash: hash0 })

      setStatusMsg('Claiming PSB...')
      const hash1 = await writeContractAsync({
        address: token1.address,
        abi: erc20Abi,
        functionName: 'claimFaucet',
      })
      setTxHash(hash1)
      await waitForTransactionReceipt(wagmiConfig, { hash: hash1 })

      await invalidateReads()
      setPhase('done')
      setStatusMsg('Test tokens claimed.')
    } catch (error) {
      setPhase('error')
      setErr(compactError(error))
      setStatusMsg('')
    }
  }, [
    address,
    chainId,
    configured,
    faucetEnabled,
    invalidateReads,
    resetResult,
    token0.address,
    token1.address,
    writeContractAsync,
  ])

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
    if (expectedOut === undefined) {
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

      setPhase('swap')
      setStatusMsg('Submitting swap...')
      const swapHash = await writeContractAsync({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'swap',
        args: [amountIn, minOut, zeroForOne],
      })
      setTxHash(swapHash)
      await waitForTransactionReceipt(wagmiConfig, { hash: swapHash })
      await invalidateReads()

      setPhase('decrypt')
      setStatusMsg('Decrypting encrypted amount out...')
      if (!publicClient) throw new Error('Public client is not ready.')
      const handle = await publicClient.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'lastEncAmountOutOf',
        args: [address],
      })
      const decrypted = await cofheClient
        .decryptForView(BigInt(handle as bigint | string), FheTypes.Uint64)
        .withPermit()
        .execute()
      const decryptedRaw = BigInt(decrypted ?? 0n)

      setLastOutPlain(formatToken(expectedOut, tokenOut.decimals))
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
    resetResult,
    tokenIn.address,
    tokenIn.symbol,
    tokenOut.decimals,
    writeContractAsync,
    zeroForOne,
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
                <p className="eyebrow">Trade</p>
                <h2>{tokenIn.symbol} to {tokenOut.symbol}</h2>
              </div>
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
            </div>

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
              <Metric label="Price impact" value={priceImpactBps === undefined ? '--' : `${(priceImpactBps / 100).toFixed(2)}%`} />
            </div>

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

            {wrongChain && (
              <button type="button" className="btn btn-primary full-width" onClick={() => switchChain({ chainId: sepolia.id })}>
                Switch to Sepolia
              </button>
            )}

            <button type="button" className="btn btn-primary full-width" disabled={!canSubmit} onClick={() => void runSwap()}>
              {busy && phase !== 'faucet' ? phaseLabels[phase] : needsApprove ? 'Approve and swap' : 'Swap and decrypt'}
            </button>

            {balanceTooLow && <p className="form-hint danger-text">Insufficient {tokenIn.symbol} balance.</p>}
            {encryptedMathTooLarge && <p className="form-hint danger-text">Amount exceeds the encrypted AMM safety bound.</p>}
          </section>

          <aside className="side-stack">
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Wallet</p>
                  <h2>Balances</h2>
                </div>
                {faucetEnabled && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={!configured || !isConnected || wrongChain || busy}
                    onClick={() => void runFaucet()}
                  >
                    Claim test tokens
                  </button>
                )}
              </div>
              <TokenBalance token={token0} />
              <TokenBalance token={token1} />
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Pool</p>
                  <h2>Liquidity</h2>
                </div>
                <span className="address-chip">{shortAddress(poolAddress)}</span>
              </div>
              <TokenReserve token={token0} />
              <TokenReserve token={token1} />
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
              {(['approve', 'swap', 'decrypt'] as TxPhase[]).map((step) => (
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
          <span>Live Sepolia: encrypted CoFHE math with standard ERC20 settlement.</span>
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
