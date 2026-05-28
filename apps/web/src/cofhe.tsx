import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/web'
import { chains } from '@cofhe/sdk/chains'
import type { CofheClient } from '@cofhe/sdk'
import { useAccount, useChainId, usePublicClient, useWalletClient } from 'wagmi'
import { sepolia } from 'wagmi/chains'
import { CofheContext } from './cofhe-context'

export function CofheProvider({ children }: { children: ReactNode }) {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const publicClient = usePublicClient({ chainId: sepolia.id })
  const { data: walletClient } = useWalletClient({ account: address })

  const [client, setClient] = useState<CofheClient | null>(null)
  const [ready, setReady] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeClient = useRef<CofheClient | null>(null)
  const connectionRun = useRef(0)
  const sessionKey =
    isConnected && address && chainId === sepolia.id ? `${chainId}:${address.toLowerCase()}` : 'disconnected'
  const latestSessionKey = useRef(sessionKey)
  latestSessionKey.current = sessionKey

  const config = useMemo(
    () =>
      createCofheConfig({
        supportedChains: [chains.sepolia],
      }),
    [],
  )

  const disconnectActiveClient = useCallback(() => {
    try {
      activeClient.current?.disconnect()
    } catch {
      /* noop */
    }
    activeClient.current = null
    setClient(null)
    setReady(false)
  }, [])

  const connect = useCallback(async () => {
    const run = connectionRun.current + 1
    connectionRun.current = run
    const runSessionKey = sessionKey

    setError(null)

    if (!isConnected || !address || chainId !== sepolia.id) {
      disconnectActiveClient()
      setConnecting(false)
      return
    }

    if (!publicClient || !walletClient) {
      disconnectActiveClient()
      setConnecting(true)
      return
    }

    setConnecting(true)
    const nextClient = createCofheClient(config)

    try {
      await nextClient.connect(
        publicClient as Parameters<CofheClient['connect']>[0],
        walletClient as Parameters<CofheClient['connect']>[1],
      )
      await nextClient.permits.getOrCreateSelfPermit()

      if (connectionRun.current !== run || latestSessionKey.current !== runSessionKey) {
        nextClient.disconnect()
        return
      }

      disconnectActiveClient()
      activeClient.current = nextClient
      setClient(nextClient)
      setReady(true)
      setError(null)
    } catch (e) {
      if (connectionRun.current !== run || latestSessionKey.current !== runSessionKey) {
        try {
          nextClient.disconnect()
        } catch {
          /* noop */
        }
        return
      }

      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      disconnectActiveClient()
    } finally {
      if (connectionRun.current === run && latestSessionKey.current === runSessionKey) {
        setConnecting(false)
      }
    }
  }, [address, chainId, config, disconnectActiveClient, isConnected, publicClient, sessionKey, walletClient])

  useEffect(() => {
    void connect()
  }, [connect])

  useEffect(
    () => () => {
      connectionRun.current += 1
      try {
        activeClient.current?.disconnect()
      } catch {
        /* noop */
      }
      activeClient.current = null
    },
    [],
  )

  const retry = useCallback(() => {
    void connect()
  }, [connect])

  const value = useMemo(
    () => ({ client, ready, connecting, error, retry }),
    [client, ready, connecting, error, retry],
  )

  return <CofheContext.Provider value={value}>{children}</CofheContext.Provider>
}
