import { http, createConfig } from 'wagmi'
import { sepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

const rpc = import.meta.env.VITE_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia.publicnode.com'

/** Injected only (no MetaMask SDK bundle) — fewer extension messaging edge cases. */
export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [sepolia.id]: http(rpc),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
