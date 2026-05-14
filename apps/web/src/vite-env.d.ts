/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_POOL_ADDRESS: string
  readonly VITE_TOKEN0_ADDRESS: string
  readonly VITE_TOKEN1_ADDRESS: string
  readonly VITE_SEPOLIA_RPC_URL?: string
  readonly VITE_ENABLE_FAUCET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
