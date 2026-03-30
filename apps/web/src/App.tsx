import { useCallback, useMemo, useState } from 'react'
import {
  useAccount,
  useChainId,
  useReadContract,
  useSwitchChain,
  useWriteContract,
  usePublicClient,
  useConnect,
  useDisconnect,
} from 'wagmi'
import { waitForTransactionReceipt } from '@wagmi/core'
import { formatUnits, parseUnits, maxUint256 } from 'viem'
import { sepolia } from 'wagmi/chains'
import { Encryptable, FheTypes } from '@cofhe/sdk'
import { erc20Abi, poolAbi } from './contracts'
import { useCofhe } from './cofhe'
import { wagmiConfig } from './wagmi'
import { AnimatedBackground } from './components/AnimatedBackground'

const ZERO = '0x0000000000000000000000000000000000000000' as const

type TxPhase = 'idle' | 'encrypt' | 'approve' | 'swap' | 'decrypt' | 'done' | 'error'

export default function App() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { connect, connectors } = useConnect()
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
  const token0 = (import.meta.env.VITE_TOKEN0_ADDRESS || ZERO) as `0x${string}`
  const token1 = (import.meta.env.VITE_TOKEN1_ADDRESS || ZERO) as `0x${string}`

  const configured = poolAddress !== ZERO && token0 !== ZERO && token1 !== ZERO

  const { data: dec0 } = useReadContract({
    address: token0,
    abi: erc20Abi,
    functionName: 'decimals',
    query: { enabled: configured },
  })
  const { data: dec1 } = useReadContract({
    address: token1,
    abi: erc20Abi,
    functionName: 'decimals',
    query: { enabled: configured },
  })
  const decimals = typeof dec0 === 'number' ? dec0 : 6

  const [amountStr, setAmountStr] = useState('1000')
  const [zeroForOne, setZeroForOne] = useState(true)
  const [slippageBps, setSlippageBps] = useState(100)
  const [phase, setPhase] = useState<TxPhase>('idle')
  const [statusMsg, setStatusMsg] = useState('')
  const [lastOutPlain, setLastOutPlain] = useState<string | null>(null)
  const [lastEncPlain, setLastEncPlain] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const { writeContractAsync } = useWriteContract()
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>()

  const tokenIn = zeroForOne ? token0 : token1

  const amountIn = useMemo(() => {
    try {
      if (!amountStr.trim()) return 0n
      return parseUnits(amountStr, decimals)
    } catch {
      return 0n
    }
  }, [amountStr, decimals])

  const { data: expectedOutRaw } = useReadContract({
    address: poolAddress,
    abi: poolAbi,
    functionName: 'getAmountOut',
    args: [amountIn, zeroForOne],
    query: { enabled: configured && amountIn > 0n },
  })
  const expectedOut = expectedOutRaw as bigint | undefined

  const { data: allowanceRaw } = useReadContract({
    address: tokenIn,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address && poolAddress ? [address, poolAddress] : undefined,
    query: { enabled: configured && !!address },
  })
  const allowance = allowanceRaw as bigint | undefined

  const { data: bal0Raw } = useReadContract({
    address: token0,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: configured && !!address },
  })
  const { data: bal1Raw } = useReadContract({
    address: token1,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: configured && !!address },
  })
  const bal0 = bal0Raw as bigint | undefined
  const bal1 = bal1Raw as bigint | undefined

  const minOut = useMemo(() => {
    if (!expectedOut || expectedOut === 0n) return 0n
    const b = BigInt(slippageBps)
    return (expectedOut * (10000n - b)) / 10000n
  }, [expectedOut, slippageBps])

  const runSwap = useCallback(async () => {
    setErr(null)
    setLastOutPlain(null)
    setLastEncPlain(null)
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
    if (amountIn > BigInt('18446744073709551615')) {
      setErr('Amount too large for uint64 encrypted path (demo limit).')
      return
    }
    if (expectedOut === undefined || minOut === undefined) {
      setErr('Could not estimate output.')
      return
    }

    try {
      setPhase('encrypt')
      setStatusMsg('Encrypting amount with CoFHE…')
      const encResult = await cofheClient
        .encryptInputs([Encryptable.uint64(amountIn)])
        .execute()
      const encrypted = encResult[0]
      if (!encrypted) throw new Error('Encrypt failed')

      const needsApprove = !allowance || allowance < amountIn
      if (needsApprove) {
        setPhase('approve')
        setStatusMsg('Approving pool to spend tokens…')
        const approveHash = await writeContractAsync({
          address: tokenIn,
          abi: erc20Abi,
          functionName: 'approve',
          args: [poolAddress, maxUint256],
        })
        setTxHash(approveHash)
        await waitForTransactionReceipt(wagmiConfig, { hash: approveHash })
      }

      setPhase('swap')
      setStatusMsg('Submitting private swap…')
      const swapHash = await writeContractAsync({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'swap',
        args: [amountIn, minOut, zeroForOne, encrypted],
      })
      setTxHash(swapHash)
      await waitForTransactionReceipt(wagmiConfig, { hash: swapHash })
      setStatusMsg(`Swap confirmed: ${swapHash.slice(0, 10)}…`)

      setPhase('decrypt')
      setStatusMsg('Decrypting FHE amountOut (view)…')
      if (!publicClient) throw new Error('No public client')
      const handle = await publicClient.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'lastEncAmountOut',
      })
      const dec = await cofheClient
        .decryptForView(BigInt(handle as bigint | string), FheTypes.Uint64)
        .withPermit()
        .execute()
      setLastEncPlain(dec?.toString() ?? '—')

      setPhase('done')
      setStatusMsg('Swap complete.')
      setLastOutPlain(expectedOut !== undefined ? formatUnits(expectedOut, decimals) : '—')
    } catch (e) {
      setPhase('error')
      const msg = e instanceof Error ? e.message : String(e)
      setErr(msg)
      setStatusMsg('')
    }
  }, [
    address,
    allowance,
    amountIn,
    chainId,
    cofheClient,
    cofheReady,
    cofheConnecting,
    configured,
    expectedOut,
    minOut,
    poolAddress,
    publicClient,
    tokenIn,
    writeContractAsync,
    zeroForOne,
    decimals,
  ])

  const wrongChain = isConnected && chainId !== sepolia.id

  return (
    <>
      <AnimatedBackground />
      <div className="layout">
        <header className="hero">
          <div className="badge">Ethereum Sepolia · CoFHE</div>
          <h1>PrivateSwap</h1>
          <p>
            Swap with Fhenix CoFHE: encrypted inputs and on-chain FHE math mirror your trade. ERC20 settlement
            on Sepolia is public—this hybrid demo keeps the full encrypt → FHE → decrypt flow working end to end.
          </p>
        </header>

        <div className="grid grid-2">
          <div className="card">
            <h2>Swap</h2>
            {!configured && (
              <p className="muted">
                Set <span className="mono">VITE_POOL_ADDRESS</span>, <span className="mono">VITE_TOKEN0_ADDRESS</span>
                , and <span className="mono">VITE_TOKEN1_ADDRESS</span> in <span className="mono">apps/web/.env</span>{' '}
                after deployment.
              </p>
            )}
            <div style={{ marginBottom: '1rem' }}>
              <label className="label">Direction</label>
              <select
                value={zeroForOne ? 'zfo' : 'ofz'}
                onChange={(e) => setZeroForOne(e.target.value === 'zfo')}
              >
                <option value="zfo">PSA → PSB (token0 → token1)</option>
                <option value="ofz">PSB → PSA (token1 → token0)</option>
              </select>
            </div>
            <div style={{ marginBottom: '1rem' }}>
              <label className="label">Amount in ({zeroForOne ? 'PSA' : 'PSB'})</label>
              <input
                type="text"
                inputMode="decimal"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
              />
            </div>
            <div style={{ marginBottom: '1rem' }}>
              <label className="label">Slippage (bps)</label>
              <input
                type="number"
                min={0}
                max={500}
                value={slippageBps}
                onChange={(e) => setSlippageBps(Number(e.target.value))}
              />
            </div>
            {expectedOut !== undefined && amountIn > 0n && (
              <p className="muted" style={{ marginBottom: '1rem' }}>
                Est. out:{' '}
                <strong style={{ color: 'var(--text)' }}>{formatUnits(expectedOut, decimals)}</strong>{' '}
                {zeroForOne ? 'PSB' : 'PSA'} · Min (after slip): {formatUnits(minOut, decimals)}
              </p>
            )}
            {isConnected && configured && address && (
              <p className="muted" style={{ marginBottom: '1rem', fontSize: '0.9rem' }}>
                <span className="mono">PSA</span>: {bal0 !== undefined ? formatUnits(bal0, decimals) : '…'} ·{' '}
                <span className="mono">PSB</span>: {bal1 !== undefined ? formatUnits(bal1, decimals) : '…'}
              </p>
            )}
            {isConnected && chainId === sepolia.id && (
              <div style={{ marginBottom: '1rem' }}>
                <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
                  CoFHE:{' '}
                  {cofheErr ? (
                    <span style={{ color: 'var(--danger)' }}>error</span>
                  ) : cofheReady ? (
                    <span style={{ color: 'var(--accent-mid)' }}>ready · permits OK</span>
                  ) : cofheConnecting ? (
                    <span>initializing keys &amp; permit…</span>
                  ) : (
                    <span>waiting for wallet…</span>
                  )}
                </p>
                {cofheErr && (
                  <div className="row" style={{ marginTop: '0.5rem' }}>
                    <button type="button" className="btn btn-ghost" onClick={() => retryCofhe()}>
                      Retry CoFHE
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="row" style={{ marginBottom: '1rem' }}>
              {!isConnected ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    const c = connectors[0]
                    if (c) connect({ connector: c, chainId: sepolia.id })
                  }}
                >
                  Connect wallet
                </button>
              ) : (
                <>
                  <span className="mono muted">{address?.slice(0, 6)}…{address?.slice(-4)}</span>
                  <button type="button" className="btn btn-ghost" onClick={() => disconnect()}>
                    Disconnect
                  </button>
                </>
              )}
            </div>
            {wrongChain && (
              <button
                type="button"
                className="btn btn-primary"
                style={{ width: '100%', marginBottom: '1rem' }}
                onClick={() => switchChain?.({ chainId: sepolia.id })}
              >
                Switch to Sepolia
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary"
              style={{ width: '100%' }}
              disabled={
                !configured ||
                !isConnected ||
                wrongChain ||
                !cofheReady ||
                cofheConnecting ||
                amountIn === 0n ||
                phase === 'encrypt' ||
                phase === 'approve' ||
                phase === 'swap' ||
                phase === 'decrypt'
              }
              onClick={() => void runSwap()}
            >
              {phase === 'idle' || phase === 'done' || phase === 'error' ? 'Encrypt & swap' : 'Working…'}
            </button>
            {cofheErr && <p className="tx-status err" style={{ marginTop: '0.75rem' }}>{cofheErr}</p>}
            {err && <p className="tx-status err" style={{ marginTop: '0.75rem' }}>{err}</p>}
            {statusMsg && (
              <p className={`tx-status ${phase === 'done' ? 'ok' : ''}`} style={{ marginTop: '0.75rem' }}>
                {statusMsg}
              </p>
            )}
            {txHash && (
              <p className="mono muted" style={{ marginTop: '0.5rem' }}>
                Last tx:{' '}
                <a
                  href={`https://sepolia.etherscan.io/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Etherscan
                </a>
              </p>
            )}
            {(lastOutPlain || lastEncPlain) && (
              <div style={{ marginTop: '1rem' }}>
                <p className="label">Plain AMM amountOut</p>
                <p className="mono">{lastOutPlain}</p>
                <p className="label" style={{ marginTop: '0.75rem' }}>
                  Decrypted FHE lastEncAmountOut (uint64)
                </p>
                <p className="mono">{lastEncPlain}</p>
              </div>
            )}
          </div>

          <div className="card">
            <h2>Pool</h2>
            <PoolStats poolAddress={poolAddress} configured={configured} decimals={decimals} />
            <p className="muted" style={{ marginTop: '1rem' }}>
              Token decimals: PSA {dec0?.toString() ?? '—'}, PSB {dec1?.toString() ?? '—'}
            </p>
          </div>
        </div>

        <section className="section">
          <h2>Why PrivateSwap</h2>
          <p className="muted">
            Public mempools expose your size and route to searchers. PrivateSwap uses Fhenix CoFHE so encrypted
            inputs are computed in the coprocessor—demonstrating encrypted swap math alongside standard ERC20
            delivery on testnet.
          </p>
        </section>

        <section className="section">
          <h2>How it works</h2>
          <div className="steps">
            <div className="step">
              <strong>1 · Encrypt</strong>
              <p className="muted" style={{ margin: '0.35rem 0 0' }}>
                The client encrypts your size with @cofhe/sdk before anything hits the chain.
              </p>
            </div>
            <div className="step">
              <strong>2 · FHE pool</strong>
              <p className="muted" style={{ margin: '0.35rem 0 0' }}>
                The pool updates encrypted reserves and computes encrypted amountOut in-contract.
              </p>
            </div>
            <div className="step">
              <strong>3 · Decrypt</strong>
              <p className="muted" style={{ margin: '0.35rem 0 0' }}>
                You decrypt handles for display; permits gate confidential results.
              </p>
            </div>
          </div>
        </section>

        <section className="section">
          <h2>Classic DEX vs PrivateSwap</h2>
          <div className="compare">
            <div className="compare-col bad">
              <strong>Classic AMM</strong>
              <p className="muted" style={{ margin: '0.5rem 0 0' }}>
                Swap size and pool impact are visible in calldata and trace analysis.
              </p>
            </div>
            <div className="compare-col good">
              <strong>PrivateSwap (demo)</strong>
              <p className="muted" style={{ margin: '0.5rem 0 0' }}>
                Encrypted inputs and FHE reserve path; decrypt for your own view. ERC20 transfers remain visible on
                Sepolia (hybrid model).
              </p>
            </div>
          </div>
        </section>

        <section className="section faq">
          <h2>FAQ</h2>
          <details>
            <summary>Is my trade amount private on Sepolia?</summary>
            <p>
              The encrypted input and FHE state are real CoFHE features. Standard ERC20 approvals and transfers still
              reveal amounts in the usual way—this deployment is a working hybrid for hackathon demos.
            </p>
          </details>
          <details>
            <summary>Why uint64 limits?</summary>
            <p>
              Encrypted paths use euint64 in the contract so values must fit 64 bits. Use modest trade sizes for the
              demo.
            </p>
          </details>
          <details>
            <summary>Where do I get Sepolia ETH?</summary>
            <p>
              Use a public Sepolia faucet (e.g. via{' '}
              <a href="https://ethereum.org/en/developers/docs/networks/#ethereum-testnets" target="_blank" rel="noreferrer">
                Ethereum testnet resources
              </a>
              ).
            </p>
          </details>
        </section>
      </div>

      <footer className="footer">
        <p className="footer-brand">PrivateSwap</p>
        <p className="footer-sub">MEV-aware story · Fhenix CoFHE · Built for Sepolia testnet</p>
      </footer>
    </>
  )
}

function PoolStats({
  poolAddress,
  configured,
  decimals,
}: {
  poolAddress: `0x${string}`
  configured: boolean
  decimals: number
}) {
  const { data: r0raw } = useReadContract({
    address: poolAddress,
    abi: poolAbi,
    functionName: 'reserve0',
    query: { enabled: configured },
  })
  const { data: r1raw } = useReadContract({
    address: poolAddress,
    abi: poolAbi,
    functionName: 'reserve1',
    query: { enabled: configured },
  })
  const r0 = r0raw as bigint | undefined
  const r1 = r1raw as bigint | undefined
  if (!configured) return <p className="muted">Deploy contracts to see reserves.</p>
  return (
    <>
      <p className="muted">Reserve PSA: {r0 !== undefined ? formatUnits(r0, decimals) : '…'}</p>
      <p className="muted">Reserve PSB: {r1 !== undefined ? formatUnits(r1, decimals) : '…'}</p>
    </>
  )
}
