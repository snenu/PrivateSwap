import { useContext } from 'react'
import { CofheContext } from './cofhe-context'

export function useCofhe() {
  return useContext(CofheContext)
}
