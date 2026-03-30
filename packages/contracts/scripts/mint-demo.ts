/**
 * Mint demo PSA/PSB to the deployer wallet (owner-only). Run after deploy if you need test balances.
 */
import * as fs from 'fs'
import * as path from 'path'
import hre from 'hardhat'

async function main() {
  const [signer] = await hre.ethers.getSigners()
  const depPath = path.join(__dirname, '..', 'deployments', 'sepolia.json')
  const dep = JSON.parse(fs.readFileSync(depPath, 'utf8')) as {
    token0: string
    token1: string
  }

  const tokenA = await hre.ethers.getContractAt('MintableERC20', dep.token0)
  const tokenB = await hre.ethers.getContractAt('MintableERC20', dep.token1)
  const amt = 500_000n
  await (await tokenA.mint(signer.address, amt)).wait()
  await (await tokenB.mint(signer.address, amt)).wait()
  console.log('Minted', amt.toString(), 'PSA + PSB to', signer.address)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
