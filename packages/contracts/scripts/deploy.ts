/**
 * Deploy MintableERC20 (PSA, PSB) + PrivateSwapPool to eth-sepolia.
 * Requires PRIVATE_KEY and SEPOLIA_RPC_URL in .env
 *
 * On Sepolia, CoFHE uses @cofhe/sdk + Ethers6Adapter (Hardhat's initializeWithHardhatSigner
 * only works on local Hardhat networks).
 */
import * as fs from 'fs'
import * as path from 'path'
import hre from 'hardhat'
import { createCofheConfig, createCofheClient } from '@cofhe/sdk/node'
import { Encryptable } from '@cofhe/sdk'
import { Ethers6Adapter } from '@cofhe/sdk/adapters'
import { chains } from '@cofhe/sdk/chains'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'

async function initCofheClient(signer: HardhatEthersSigner) {
  const provider = signer.provider
  if (!provider) throw new Error('Signer has no provider')
  const { publicClient, walletClient } = await Ethers6Adapter(provider, signer)
  const config = createCofheConfig({ supportedChains: [chains.sepolia] })
  const client = createCofheClient(config)
  await client.connect(publicClient, walletClient)
  await client.permits.getOrCreateSelfPermit()
  return client
}

async function main() {
  const [deployer] = await hre.ethers.getSigners()
  console.log('Deployer:', deployer.address)

  const net = await hre.ethers.provider.getNetwork()
  if (net.chainId !== 11155111n) {
    throw new Error(`Expected eth-sepolia (11155111), got chain ${net.chainId}`)
  }

  const Token = await hre.ethers.getContractFactory('MintableERC20')
  const tokenA = await Token.deploy('Private A', 'PSA', 6)
  const tokenB = await Token.deploy('Private B', 'PSB', 6)
  await tokenA.waitForDeployment()
  await tokenB.waitForDeployment()
  const tokenAAddr = await tokenA.getAddress()
  const tokenBAddr = await tokenB.getAddress()
  console.log('PSA:', tokenAAddr)
  console.log('PSB:', tokenBAddr)

  const Pool = await hre.ethers.getContractFactory('PrivateSwapPool')
  const pool = await Pool.deploy(tokenAAddr, tokenBAddr)
  await pool.waitForDeployment()
  const poolAddr = await pool.getAddress()
  console.log('PrivateSwapPool:', poolAddr)

  const init = 1_000_000n
  await (await tokenA.mint(deployer.address, init)).wait()
  await (await tokenB.mint(deployer.address, init)).wait()

  console.log('Initializing CoFHE client for encryption…')
  const cofheClient = await initCofheClient(deployer)

  const encResult = await cofheClient
    .encryptInputs([Encryptable.uint64(init), Encryptable.uint64(init)])
    .execute()
  const encR0 = encResult[0]
  const encR1 = encResult[1]
  if (!encR0 || !encR1) throw new Error('Encryption failed')

  await (await tokenA.approve(poolAddr, init)).wait()
  await (await tokenB.approve(poolAddr, init)).wait()
  await (await pool.initialize(init, init, encR0, encR1)).wait()
  console.log('Pool initialized with', init.toString(), 'each side')

  const demoMint = 500_000n
  await (await tokenA.mint(deployer.address, demoMint)).wait()
  await (await tokenB.mint(deployer.address, demoMint)).wait()
  console.log('Minted', demoMint.toString(), 'PSA + PSB to deployer for test swaps')

  const outDir = path.join(__dirname, '..', 'deployments')
  fs.mkdirSync(outDir, { recursive: true })
  const deployment = {
    network: 'eth-sepolia',
    chainId: 11155111,
    deployer: deployer.address,
    token0: tokenAAddr,
    token1: tokenBAddr,
    pool: poolAddr,
    decimals: 6,
    initializedLiquidity: init.toString(),
  }
  fs.writeFileSync(path.join(outDir, 'sepolia.json'), JSON.stringify(deployment, null, 2))
  console.log('Wrote deployments/sepolia.json')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
