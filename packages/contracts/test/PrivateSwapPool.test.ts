import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { cofhejs, FheTypes } from 'cofhejs/node'

describe('PrivateSwapPool', function () {
  async function futureDeadline() {
    const block = await hre.ethers.provider.getBlock('latest')
    return BigInt((block?.timestamp ?? 0) + 3600)
  }

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
    const { deployer, pool, supply } = await loadFixture(deployFixture)
    expect(await pool.reserve0()).to.equal(supply)
    expect(await pool.reserve1()).to.equal(supply)

    const e0 = await pool.encReserve0()
    const e1 = await pool.encReserve1()
    await hre.cofhe.mocks.expectPlaintext(e0, supply)
    await hre.cofhe.mocks.expectPlaintext(e1, supply)
    expect(await pool.totalLiquidity()).to.equal(supply)
    expect(await pool.liquidityOf(deployer.address)).to.equal(supply)
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
    await pool.connect(alice).swap(amountIn, 0n, true, await futureDeadline())

    const lastOut = await pool.lastEncAmountOutOf(alice.address)
    const unsealed = await cofhejs.unseal(lastOut, FheTypes.Uint64)
    await hre.cofhe.expectResultValue(unsealed, expectedOut)
    await hre.cofhe.mocks.expectPlaintext(await pool.encReserve0(), supply + amountIn)
    await hre.cofhe.mocks.expectPlaintext(await pool.encReserve1(), supply - expectedOut)
  })

  it('supports committed swap intents before reveal and settlement', async function () {
    const { pool, tokenA, alice } = await loadFixture(deployFixture)

    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(alice))

    const amountIn = 10n * 10n ** 6n
    const expectedOut = await pool.getAmountOut(amountIn, true)
    const poolAddress = await pool.getAddress()
    const salt = hre.ethers.hexlify(hre.ethers.randomBytes(32))
    const chain = await hre.ethers.provider.getNetwork()
    const deadline = await futureDeadline()
    const commitment = hre.ethers.keccak256(
      hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'uint256', 'uint256', 'bool', 'bytes32', 'address', 'uint256', 'uint256'],
        [alice.address, amountIn, 0n, true, salt, poolAddress, chain.chainId, deadline],
      ),
    )

    await expect(
      pool.connect(alice).swapWithCommitment(amountIn, 0n, true, salt, deadline),
    ).to.be.revertedWithCustomError(pool, 'InvalidCommitment')

    await expect(pool.connect(alice).commitSwap(commitment))
      .to.emit(pool, 'SwapCommitted')
      .withArgs(alice.address, commitment)

    await tokenA.connect(alice).approve(poolAddress, amountIn)
    await pool.connect(alice).swapWithCommitment(amountIn, 0n, true, salt, deadline)

    const lastOut = await pool.lastEncAmountOutOf(alice.address)
    await hre.cofhe.expectResultValue(await cofhejs.unseal(lastOut, FheTypes.Uint64), expectedOut)
    expect(await pool.swapCommitments(alice.address)).to.equal(hre.ethers.ZeroHash)
  })

  it('applies live encrypted math bounds to quotes and swaps', async function () {
    const { pool, alice, supply } = await loadFixture(deployFixture)

    const uint64Max = (1n << 64n) - 1n
    const amountTooLarge = uint64Max + 1n
    const feeBps = await pool.SWAP_FEE_BPS()
    const denominator = await pool.BPS_DENOMINATOR()
    const multiplicationOverflowAmount = (uint64Max * denominator) / (supply * (denominator - feeBps)) + 1n

    await expect(pool.getAmountOut(amountTooLarge, true)).to.be.revertedWithCustomError(pool, 'AmountTooLarge')
    await expect(pool.getAmountOut(multiplicationOverflowAmount, true)).to.be.revertedWithCustomError(
      pool,
      'EncryptedMathOverflow',
    )
    await expect(
      pool.connect(alice).swap(multiplicationOverflowAmount, 0n, true, await futureDeadline()),
    ).to.be.revertedWithCustomError(pool, 'EncryptedMathOverflow')
  })

  it('adds and removes liquidity while keeping encrypted reserves synchronized', async function () {
    const { pool, tokenA, tokenB, alice, supply } = await loadFixture(deployFixture)

    const poolAddress = await pool.getAddress()
    const addAmount = 100n * 10n ** 6n
    const [quoted0, quoted1, quotedLiquidity] = await pool.quoteAddLiquidity(addAmount, addAmount)
    expect(quoted0).to.equal(addAmount)
    expect(quoted1).to.equal(addAmount)
    expect(quotedLiquidity).to.equal(addAmount)

    await tokenA.connect(alice).approve(poolAddress, addAmount)
    await tokenB.connect(alice).approve(poolAddress, addAmount)
    await expect(pool.connect(alice).addLiquidity(addAmount, addAmount, addAmount, await futureDeadline()))
      .to.emit(pool, 'LiquidityAdded')
      .withArgs(alice.address, addAmount, addAmount, addAmount, supply + addAmount, supply + addAmount)

    expect(await pool.reserve0()).to.equal(supply + addAmount)
    expect(await pool.reserve1()).to.equal(supply + addAmount)
    expect(await pool.totalLiquidity()).to.equal(supply + addAmount)
    expect(await pool.liquidityOf(alice.address)).to.equal(addAmount)
    await hre.cofhe.mocks.expectPlaintext(await pool.encReserve0(), supply + addAmount)
    await hre.cofhe.mocks.expectPlaintext(await pool.encReserve1(), supply + addAmount)

    const removeLiquidity = 50n * 10n ** 6n
    const [amount0, amount1] = await pool.quoteRemoveLiquidity(removeLiquidity)
    expect(amount0).to.equal(removeLiquidity)
    expect(amount1).to.equal(removeLiquidity)

    await expect(pool.connect(alice).removeLiquidity(removeLiquidity, amount0, amount1, await futureDeadline()))
      .to.emit(pool, 'LiquidityRemoved')
      .withArgs(
        alice.address,
        removeLiquidity,
        removeLiquidity,
        removeLiquidity,
        supply + addAmount - removeLiquidity,
        supply + addAmount - removeLiquidity,
      )

    expect(await pool.reserve0()).to.equal(supply + addAmount - removeLiquidity)
    expect(await pool.reserve1()).to.equal(supply + addAmount - removeLiquidity)
    expect(await pool.totalLiquidity()).to.equal(supply + addAmount - removeLiquidity)
    expect(await pool.liquidityOf(alice.address)).to.equal(addAmount - removeLiquidity)
    await hre.cofhe.mocks.expectPlaintext(await pool.encReserve0(), supply + addAmount - removeLiquidity)
    await hre.cofhe.mocks.expectPlaintext(await pool.encReserve1(), supply + addAmount - removeLiquidity)
  })

  it('keeps encrypted swap outputs scoped per user', async function () {
    const { pool, tokenA, alice, bob } = await loadFixture(deployFixture)

    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(alice))
    const aliceAmount = 10n * 10n ** 6n
    const expectedAliceOut = await pool.getAmountOut(aliceAmount, true)
    await tokenA.connect(alice).approve(await pool.getAddress(), aliceAmount)
    await pool.connect(alice).swap(aliceAmount, 0n, true, await futureDeadline())

    await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(bob))
    const bobAmount = 5n * 10n ** 6n
    const aliceHandleBeforeBob = await pool.lastEncAmountOutOf(alice.address)
    const expectedBobOut = await pool.getAmountOut(bobAmount, true)
    await tokenA.connect(bob).approve(await pool.getAddress(), bobAmount)
    await pool.connect(bob).swap(bobAmount, 0n, true, await futureDeadline())

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

  it('charges the configured LP fee in the executable quote', async function () {
    const { pool } = await loadFixture(deployFixture)

    const amountIn = 10n * 10n ** 6n
    const reserve = 1_000n * 10n ** 6n
    const feeBps = await pool.SWAP_FEE_BPS()
    const denominator = await pool.BPS_DENOMINATOR()
    const effectiveIn = amountIn - ((amountIn * feeBps) / denominator)
    const expectedOut = (effectiveIn * reserve) / (reserve + effectiveIn)

    expect(await pool.getAmountOut(amountIn, true)).to.equal(expectedOut)
    expect(expectedOut).to.be.lt((amountIn * reserve) / (reserve + amountIn))
  })

  it('rejects expired swaps and liquidity operations', async function () {
    const { pool, tokenA, tokenB, alice } = await loadFixture(deployFixture)

    const expired = 1n
    const amountIn = 10n * 10n ** 6n
    await tokenA.connect(alice).approve(await pool.getAddress(), amountIn)

    await expect(pool.connect(alice).swap(amountIn, 0n, true, expired)).to.be.revertedWithCustomError(pool, 'Expired')
    await expect(pool.connect(alice).addLiquidity(amountIn, amountIn, 0n, expired)).to.be.revertedWithCustomError(
      pool,
      'Expired',
    )
    await tokenB.connect(alice).approve(await pool.getAddress(), amountIn)
    await expect(pool.connect(alice).removeLiquidity(1n, 0n, 0n, expired)).to.be.revertedWithCustomError(
      pool,
      'Expired',
    )
  })

  it('lets users cancel stale committed swap intents', async function () {
    const { pool, alice } = await loadFixture(deployFixture)

    const commitment = hre.ethers.keccak256(hre.ethers.toUtf8Bytes('stale intent'))
    await expect(pool.connect(alice).commitSwap(commitment))
      .to.emit(pool, 'SwapCommitted')
      .withArgs(alice.address, commitment)
    await expect(pool.connect(alice).cancelCommitment())
      .to.emit(pool, 'SwapCommitmentCancelled')
      .withArgs(alice.address, commitment)
    expect(await pool.swapCommitments(alice.address)).to.equal(hre.ethers.ZeroHash)
  })
})
