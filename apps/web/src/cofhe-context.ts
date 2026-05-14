import { createContext } from 'react'
import type { CofheClient } from '@cofhe/sdk'

export type CofheCtx = {
  client: CofheClient | null
  ready: boolean
  connecting: boolean
  error: string | null
  retry: () => void
}

export const CofheContext = createContext<CofheCtx>({
  client: null,
  ready: false,
  connecting: false,
  error: null,
  retry: () => {},
})
