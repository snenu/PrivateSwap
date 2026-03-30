import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { cofhejs, Encryptable, FheTypes } from 'cofhejs/node'

describe('PrivateSwapPool', function () {
  async function deployFixture() {
    const [deployer, alice] = await hre.ethers.getSigners()

    const Token = await hre.ethers.getContractFactory('MintableERC20')
    const tokenA = await Token.deploy('Private A', 'PSA', 6)
    const tokenB = await Token.deploy('Private B', 'PSB', 6)
    await tokenA.waitForDeployment()
    await tokenB.waitForDeployment()

    const Pool = await hre.ethers.getContractFactory('PrivateSwapPool')
    const pool = await Pool.deploy(await tokenA.getAddress(), await tokenB.getAddress())
    await pool.waitForDeployment()

    const supply = 1_000_000n // 1e6 units (6 decimals)
    await tokenA.mint(deployer.address, supply)
    await tokenB.mint(deployer.address, supply)
    await tokenA.mint(alice.address, 100_000n)
    await tokenB.mint(alice.address, 100_000n)

    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(deployer))

    const [encR0, encR1] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint64(supply), Encryptable.uint64(supply)] as const),
    )

    await tokenA.approve(await pool.getAddress(), supply)
    await tokenB.approve(await pool.getAddress(), supply)
    await pool.initialize(supply, supply, encR0, encR1)

    return { deployer, alice, tokenA, tokenB, pool, supply }
  }

  beforeEach(function () {
    if (!hre.cofhe.isPermittedEnvironment('MOCK')) this.skip()
  })

  it('initializes with matching plaintext and FHE reserves', async function () {
    const { pool, supply } = await loadFixture(deployFixture)
    expect(await pool.reserve0()).to.equal(supply)
    expect(await pool.reserve1()).to.equal(supply)

    const e0 = await pool.encReserve0()
    const e1 = await pool.encReserve1()
    await hre.cofhe.mocks.expectPlaintext(e0, supply)
    await hre.cofhe.mocks.expectPlaintext(e1, supply)
  })

  it('swaps with parallel FHE amountOut', async function () {
    const { pool, tokenA, tokenB, alice } = await loadFixture(deployFixture)

    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(alice))

    const amountIn = 10_000n
    const [encIn] = await hre.cofhe.expectResultSuccess(
      cofhejs.encrypt([Encryptable.uint64(amountIn)] as const),
    )

    const expectedOut = await pool.getAmountOut(amountIn, true)
    expect(expectedOut).to.be.gt(0n)

    await tokenA.connect(alice).approve(await pool.getAddress(), amountIn)
    await pool.connect(alice).swap(amountIn, 0n, true, encIn)

    const lastOut = await pool.lastEncAmountOut()
    const unsealed = await cofhejs.unseal(lastOut, FheTypes.Uint64)
    await hre.cofhe.expectResultValue(unsealed, expectedOut)
  })
})
