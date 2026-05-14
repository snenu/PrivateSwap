import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { cofhejs, FheTypes } from 'cofhejs/node'

describe('PrivateSwapPool', function () {
  async function deployFixture() {
    const [deployer, alice, bob] = await hre.ethers.getSigners()

    const Token = await hre.ethers.getContractFactory('MintableERC20')
    const tokenA = await Token.deploy('Private A', 'PSA', 6)
    const tokenB = await Token.deploy('Private B', 'PSB', 6)
    await tokenA.waitForDeployment()
    await tokenB.waitForDeployment()

    const Pool = await hre.ethers.getContractFactory('PrivateSwapPool')
    const pool = await Pool.deploy(await tokenA.getAddress(), await tokenB.getAddress())
    await pool.waitForDeployment()

    const unit = 10n ** 6n
    const supply = 1_000n * unit
    await tokenA.mint(deployer.address, supply)
    await tokenB.mint(deployer.address, supply)
    await tokenA.mint(alice.address, 1_000n * unit)
    await tokenB.mint(alice.address, 1_000n * unit)
    await tokenA.mint(bob.address, 1_000n * unit)
    await tokenB.mint(bob.address, 1_000n * unit)

    await tokenA.approve(await pool.getAddress(), supply)
    await tokenB.approve(await pool.getAddress(), supply)
    await pool.initialize(supply, supply)

    return { deployer, alice, bob, tokenA, tokenB, pool, supply }
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

  it('can initialize public test liquidity directly on-chain', async function () {
    const [deployer] = await hre.ethers.getSigners()
    const Token = await hre.ethers.getContractFactory('MintableERC20')
    const tokenA = await Token.deploy('Private A', 'PSA', 6)
    const tokenB = await Token.deploy('Private B', 'PSB', 6)
    const Pool = await hre.ethers.getContractFactory('PrivateSwapPool')
    const pool = await Pool.deploy(await tokenA.getAddress(), await tokenB.getAddress())

    const supply = 1_000n * 10n ** 6n
    await tokenA.mint(deployer.address, supply)
    await tokenB.mint(deployer.address, supply)
    await tokenA.approve(await pool.getAddress(), supply)
    await tokenB.approve(await pool.getAddress(), supply)
    await pool.initialize(supply, supply)

    await hre.cofhe.mocks.expectPlaintext(await pool.encReserve0(), supply)
    await hre.cofhe.mocks.expectPlaintext(await pool.encReserve1(), supply)
  })

  it('swaps with parallel FHE amountOut', async function () {
    const { pool, tokenA, alice, supply } = await loadFixture(deployFixture)

    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(alice))

    const amountIn = 10n * 10n ** 6n
    const expectedOut = await pool.getAmountOut(amountIn, true)
    expect(expectedOut).to.be.gt(0n)

    await tokenA.connect(alice).approve(await pool.getAddress(), amountIn)
    await pool.connect(alice).swap(amountIn, 0n, true)

    const lastOut = await pool.lastEncAmountOutOf(alice.address)
    const unsealed = await cofhejs.unseal(lastOut, FheTypes.Uint64)
    await hre.cofhe.expectResultValue(unsealed, expectedOut)
    await hre.cofhe.mocks.expectPlaintext(await pool.encReserve0(), supply + amountIn)
    await hre.cofhe.mocks.expectPlaintext(await pool.encReserve1(), supply - expectedOut)
  })

  it('keeps encrypted swap outputs scoped per user', async function () {
    const { pool, tokenA, alice, bob } = await loadFixture(deployFixture)

    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(alice))
    const aliceAmount = 10n * 10n ** 6n
    const expectedAliceOut = await pool.getAmountOut(aliceAmount, true)
    await tokenA.connect(alice).approve(await pool.getAddress(), aliceAmount)
    await pool.connect(alice).swap(aliceAmount, 0n, true)

    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(bob))
    const bobAmount = 5n * 10n ** 6n
    const aliceHandleBeforeBob = await pool.lastEncAmountOutOf(alice.address)
    const expectedBobOut = await pool.getAmountOut(bobAmount, true)
    await tokenA.connect(bob).approve(await pool.getAddress(), bobAmount)
    await pool.connect(bob).swap(bobAmount, 0n, true)

    const aliceHandleAfterBob = await pool.lastEncAmountOutOf(alice.address)
    const bobHandle = await pool.lastEncAmountOutOf(bob.address)
    expect(aliceHandleAfterBob).to.equal(aliceHandleBeforeBob)

    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(alice))
    await hre.cofhe.expectResultValue(await cofhejs.unseal(aliceHandleAfterBob, FheTypes.Uint64), expectedAliceOut)
    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(bob))
    await hre.cofhe.expectResultValue(await cofhejs.unseal(bobHandle, FheTypes.Uint64), expectedBobOut)
  })

  it('lets any account claim test tokens from each token faucet', async function () {
    const { tokenA, tokenB, alice } = await loadFixture(deployFixture)

    const beforeA = await tokenA.balanceOf(alice.address)
    const beforeB = await tokenB.balanceOf(alice.address)
    const faucetA = await tokenA.faucetAmount()
    const faucetB = await tokenB.faucetAmount()

    await tokenA.connect(alice).claimFaucet()
    await tokenB.connect(alice).claimFaucet()

    expect(await tokenA.balanceOf(alice.address)).to.equal(beforeA + faucetA)
    expect(await tokenB.balanceOf(alice.address)).to.equal(beforeB + faucetB)
  })
})
