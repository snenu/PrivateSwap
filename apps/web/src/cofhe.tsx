import {
  createContext,
  useCallback,
  useContext,
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

type CofheCtx = {
  client: CofheClient | null
  ready: boolean
  connecting: boolean
  error: string | null
  retry: () => void
}

const CofheContext = createContext<CofheCtx>({
  client: null,
  ready: false,
  connecting: false,
  error: null,
  retry: () => {},
})

export function CofheProvider({ children }: { children: ReactNode }) {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const publicClient = usePublicClient({ chainId: sepolia.id })
  const { data: walletClient } = useWalletClient({ account: address })

  const [client, setClient] = useState<CofheClient | null>(null)
  const [ready, setReady] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const config = useMemo(
    () =>
      createCofheConfig({
        supportedChains: [chains.sepolia],
      }),
    [],
  )

  const baseClient = useMemo(() => createCofheClient(config), [config])

  const connect = useCallback(async () => {
    setError(null)

    if (!isConnected || !address || chainId !== sepolia.id) {
      try {
        baseClient.disconnect()
      } catch {
        /* noop */
      }
      setClient(null)
      setReady(false)
      setConnecting(false)
      return
    }

    if (!publicClient || !walletClient) {
      setConnecting(true)
      return
    }

    if (inFlight.current) return
    inFlight.current = true
    setConnecting(true)

    try {
      try {
        baseClient.disconnect()
      } catch {
        /* noop */
      }
      await baseClient.connect(
        publicClient as Parameters<CofheClient['connect']>[0],
        walletClient as Parameters<CofheClient['connect']>[1],
      )
      await baseClient.permits.getOrCreateSelfPermit()
      setClient(baseClient)
      setReady(true)
      setError(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      setClient(null)
      setReady(false)
    } finally {
      inFlight.current = false
      setConnecting(false)
    }
  }, [address, baseClient, chainId, isConnected, publicClient, walletClient])

  useEffect(() => {
    void connect()
  }, [connect])

  const retry = useCallback(() => {
    void connect()
  }, [connect])

  const value = useMemo(
    () => ({ client, ready, connecting, error, retry }),
    [client, ready, connecting, error, retry],
  )

  return <CofheContext.Provider value={value}>{children}</CofheContext.Provider>
}

export function useCofhe() {
  return useContext(CofheContext)
}
