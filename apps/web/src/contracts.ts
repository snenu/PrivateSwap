import type { Abi } from 'viem'
import poolArtifact from '../../../packages/contracts/artifacts/contracts/PrivateSwapPool.sol/PrivateSwapPool.json'
import tokenArtifact from '../../../packages/contracts/artifacts/contracts/MintableERC20.sol/MintableERC20.json'

export const poolAbi = poolArtifact.abi as Abi
export const erc20Abi = tokenArtifact.abi as Abi
