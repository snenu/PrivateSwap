/**
 * Deploy MintableERC20 (PSA, PSB) + PrivateSwapPool to eth-sepolia.
 * Requires PRIVATE_KEY and SEPOLIA_RPC_URL in .env
 */
import * as fs from 'fs'
import * as path from 'path'
import hre from 'hardhat'

async function main() {
  const [deployer] = await hre.ethers.getSigners()
  console.log('Deployer:', deployer.address)

  const net = await hre.ethers.provider.getNetwork()
  if (net.chainId !== 11155111n) {
    throw new Error(`Expected eth-sepolia (11155111), got chain ${net.chainId}`)
  }

  const Token = await hre.ethers.getContractFactory('MintableERC20')
  const tokenA = await Token.deploy('Private A', 'PSA', 6)
  await tokenA.waitForDeployment()
  const tokenB = await Token.deploy('Private B', 'PSB', 6)
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

  const tokenUnit = 10n ** 6n
  const init = 1_000n * tokenUnit
  await (await tokenA.mint(deployer.address, init)).wait()
  await (await tokenB.mint(deployer.address, init)).wait()

  await (await tokenA.approve(poolAddr, init)).wait()
  await (await tokenB.approve(poolAddr, init)).wait()
  await (await pool.initialize(init, init)).wait()
  console.log('Pool initialized with', init.toString(), 'each side')

  const testMint = 10_000n * tokenUnit
  await (await tokenA.mint(deployer.address, testMint)).wait()
  await (await tokenB.mint(deployer.address, testMint)).wait()
  console.log('Minted', testMint.toString(), 'PSA + PSB to deployer for test swaps')

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
    initializedLiquidityTokens: '1000',
    faucetAmountTokens: '100',
  }
  fs.writeFileSync(path.join(outDir, 'sepolia.json'), JSON.stringify(deployment, null, 2))
  console.log('Wrote deployments/sepolia.json')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
