// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title PrivateSwapPool
/// @notice Hybrid AMM: plaintext reserves drive ERC20 settlement; FHE state is derived in-contract from settled values.
/// @dev The live Sepolia verifier supports the uint64 encrypted path reliably, so swaps guard the mirrored math bounds.
contract PrivateSwapPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SWAP_FEE_BPS = 30;

    IERC20 public immutable token0;
    IERC20 public immutable token1;

    address public owner;

    uint256 public reserve0;
    uint256 public reserve1;

    euint64 public encReserve0;
    euint64 public encReserve1;

    /// @notice Encrypted amount out from the most recent swap, kept for indexers and simple dashboards.
    euint64 public lastEncAmountOut;

    bool public lastZeroForOne;

    uint256 public totalLiquidity;

    /// @notice Caller-scoped encrypted amount out. Frontends should read this after a swap to avoid cross-user races.
    mapping(address account => euint64 amountOut) public lastEncAmountOutOf;
    mapping(address account => bool zeroForOne) public lastZeroForOneOf;
    mapping(address account => uint256 liquidity) public liquidityOf;
    mapping(address account => bytes32 commitment) public swapCommitments;

    event Initialized(uint256 reserve0, uint256 reserve1);
    event Swap(address indexed user, bool zeroForOne, uint256 amountIn, uint256 amountOut);
    event SwapCommitted(address indexed user, bytes32 indexed commitment);
    event SwapCommitmentCancelled(address indexed user, bytes32 indexed commitment);
    event LiquidityAdded(
        address indexed provider,
        uint256 amount0,
        uint256 amount1,
        uint256 liquidity,
        uint256 reserve0,
        uint256 reserve1
    );
    event LiquidityRemoved(
        address indexed provider,
        uint256 amount0,
        uint256 amount1,
        uint256 liquidity,
        uint256 reserve0,
        uint256 reserve1
    );

    error NotOwner();
    error AlreadyInitialized();
    error NotInitialized();
    error ZeroAmount();
    error ZeroOutput();
    error Slippage();
    error AmountTooLarge();
    error EncryptedMathOverflow();
    error InsufficientLiquidity();
    error InvalidCommitment();
    error InvalidToken();
    error Expired();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _token0, address _token1) {
        if (_token0 == address(0) || _token1 == address(0) || _token0 == _token1) revert InvalidToken();
        token0 = IERC20(_token0);
        token1 = IERC20(_token1);
        owner = msg.sender;
    }

    function initialize(uint256 amount0, uint256 amount1) external onlyOwner {
        _initialize(amount0, amount1);
        uint256 liquidity = _sqrt(amount0 * amount1);
        if (liquidity == 0) revert ZeroAmount();
        totalLiquidity = liquidity;
        liquidityOf[msg.sender] = liquidity;

        encReserve0 = FHE.asEuint64(amount0);
        encReserve1 = FHE.asEuint64(amount1);
        _allowEnc(encReserve0);
        _allowEnc(encReserve1);

        emit Initialized(reserve0, reserve1);
        emit LiquidityAdded(msg.sender, amount0, amount1, liquidity, reserve0, reserve1);
    }

    function _initialize(uint256 amount0, uint256 amount1) internal {
        if (reserve0 != 0 || reserve1 != 0) revert AlreadyInitialized();
        if (amount0 == 0 || amount1 == 0) revert ZeroAmount();
        if (amount0 > type(uint64).max || amount1 > type(uint64).max) revert AmountTooLarge();

        token0.safeTransferFrom(msg.sender, address(this), amount0);
        token1.safeTransferFrom(msg.sender, address(this), amount1);

        reserve0 = amount0;
        reserve1 = amount1;
    }

    function swap(
        uint256 amountIn,
        uint256 minAmountOut,
        bool zeroForOne,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountOut) {
        _checkDeadline(deadline);
        amountOut = _swap(msg.sender, amountIn, minAmountOut, zeroForOne);
    }

    function commitSwap(bytes32 commitment) external {
        if (commitment == bytes32(0)) revert InvalidCommitment();
        swapCommitments[msg.sender] = commitment;
        emit SwapCommitted(msg.sender, commitment);
    }

    function cancelCommitment() external {
        bytes32 commitment = swapCommitments[msg.sender];
        if (commitment == bytes32(0)) revert InvalidCommitment();
        delete swapCommitments[msg.sender];
        emit SwapCommitmentCancelled(msg.sender, commitment);
    }

    function swapWithCommitment(
        uint256 amountIn,
        uint256 minAmountOut,
        bool zeroForOne,
        bytes32 salt,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountOut) {
        _checkDeadline(deadline);
        bytes32 expected = keccak256(
            abi.encode(msg.sender, amountIn, minAmountOut, zeroForOne, salt, address(this), block.chainid, deadline)
        );
        if (swapCommitments[msg.sender] != expected) revert InvalidCommitment();
        delete swapCommitments[msg.sender];

        amountOut = _swap(msg.sender, amountIn, minAmountOut, zeroForOne);
    }

    function addLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 minLiquidity,
        uint256 deadline
    ) external nonReentrant returns (uint256 amount0, uint256 amount1, uint256 liquidity) {
        _checkDeadline(deadline);
        (amount0, amount1, liquidity) = quoteAddLiquidity(amount0Desired, amount1Desired);
        if (liquidity == 0) revert ZeroAmount();
        if (liquidity < minLiquidity) revert Slippage();
        if (reserve0 + amount0 > type(uint64).max || reserve1 + amount1 > type(uint64).max) revert AmountTooLarge();

        token0.safeTransferFrom(msg.sender, address(this), amount0);
        token1.safeTransferFrom(msg.sender, address(this), amount1);

        reserve0 = reserve0 + amount0;
        reserve1 = reserve1 + amount1;
        totalLiquidity = totalLiquidity + liquidity;
        liquidityOf[msg.sender] = liquidityOf[msg.sender] + liquidity;

        encReserve0 = FHE.add(encReserve0, FHE.asEuint64(amount0));
        encReserve1 = FHE.add(encReserve1, FHE.asEuint64(amount1));
        _allowEnc(encReserve0);
        _allowEnc(encReserve1);

        emit LiquidityAdded(msg.sender, amount0, amount1, liquidity, reserve0, reserve1);
    }

    function removeLiquidity(
        uint256 liquidity,
        uint256 minAmount0,
        uint256 minAmount1,
        uint256 deadline
    ) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        _checkDeadline(deadline);
        if (liquidity == 0) revert ZeroAmount();
        if (liquidity > liquidityOf[msg.sender] || liquidity > totalLiquidity) revert InsufficientLiquidity();

        (amount0, amount1) = quoteRemoveLiquidity(liquidity);
        if (amount0 == 0 || amount1 == 0) revert ZeroAmount();
        if (amount0 < minAmount0 || amount1 < minAmount1) revert Slippage();

        liquidityOf[msg.sender] = liquidityOf[msg.sender] - liquidity;
        totalLiquidity = totalLiquidity - liquidity;
        reserve0 = reserve0 - amount0;
        reserve1 = reserve1 - amount1;

        encReserve0 = FHE.sub(encReserve0, FHE.asEuint64(amount0));
        encReserve1 = FHE.sub(encReserve1, FHE.asEuint64(amount1));
        _allowEnc(encReserve0);
        _allowEnc(encReserve1);

        token0.safeTransfer(msg.sender, amount0);
        token1.safeTransfer(msg.sender, amount1);

        emit LiquidityRemoved(msg.sender, amount0, amount1, liquidity, reserve0, reserve1);
    }

    function _swap(
        address user,
        uint256 amountIn,
        uint256 minAmountOut,
        bool zeroForOne
    ) internal returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        if (reserve0 == 0 || reserve1 == 0) revert NotInitialized();
        if (amountIn > type(uint64).max) revert AmountTooLarge();

        IERC20 tokenIn = zeroForOne ? token0 : token1;
        IERC20 tokenOut = zeroForOne ? token1 : token0;

        amountOut = _executableAmountOut(amountIn, zeroForOne);
        uint256 effectiveAmountIn = _amountInAfterFee(amountIn);
        if (amountOut == 0) revert ZeroOutput();
        if (amountOut < minAmountOut) revert Slippage();

        tokenIn.safeTransferFrom(user, address(this), amountIn);

        if (zeroForOne) {
            reserve0 = reserve0 + amountIn;
            reserve1 = reserve1 - amountOut;
        } else {
            reserve1 = reserve1 + amountIn;
            reserve0 = reserve0 - amountOut;
        }

        euint64 encIn = FHE.asEuint64(amountIn);
        euint64 encEffectiveIn = FHE.asEuint64(effectiveAmountIn);
        euint64 rIn = zeroForOne ? encReserve0 : encReserve1;
        euint64 rOut = zeroForOne ? encReserve1 : encReserve0;

        euint64 num = FHE.mul(encEffectiveIn, rOut);
        euint64 den = FHE.add(rIn, encEffectiveIn);
        euint64 encOut = FHE.div(num, den);

        euint64 newRIn = FHE.add(rIn, encIn);
        euint64 newROut = FHE.sub(rOut, encOut);

        if (zeroForOne) {
            encReserve0 = newRIn;
            encReserve1 = newROut;
        } else {
            encReserve1 = newRIn;
            encReserve0 = newROut;
        }

        _allowEnc(encReserve0);
        _allowEnc(encReserve1);

        lastEncAmountOutOf[user] = encOut;
        lastZeroForOneOf[user] = zeroForOne;
        lastEncAmountOut = encOut;
        lastZeroForOne = zeroForOne;

        _allowEncFor(lastEncAmountOutOf[user], user);
        _allowEncFor(lastEncAmountOut, user);

        tokenOut.safeTransfer(user, amountOut);

        emit Swap(user, zeroForOne, amountIn, amountOut);
    }

    function getAmountOut(uint256 amountIn, bool zeroForOne) external view returns (uint256) {
        if (reserve0 == 0 || reserve1 == 0 || amountIn == 0) return 0;
        return _executableAmountOut(amountIn, zeroForOne);
    }

    function _executableAmountOut(uint256 amountIn, bool zeroForOne) internal view returns (uint256) {
        if (amountIn > type(uint64).max) revert AmountTooLarge();
        uint256 effectiveAmountIn = _amountInAfterFee(amountIn);
        uint256 reserveIn = zeroForOne ? reserve0 : reserve1;
        uint256 reserveOut = zeroForOne ? reserve1 : reserve0;
        if (
            reserveIn + amountIn > type(uint64).max ||
            reserveIn + effectiveAmountIn > type(uint64).max ||
            reserveOut > type(uint64).max
        ) revert AmountTooLarge();
        if (effectiveAmountIn * reserveOut > type(uint64).max) revert EncryptedMathOverflow();

        return (effectiveAmountIn * reserveOut) / (reserveIn + effectiveAmountIn);
    }

    function getReserves() external view returns (uint256, uint256) {
        return (reserve0, reserve1);
    }

    function quoteAddLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired
    ) public view returns (uint256 amount0, uint256 amount1, uint256 liquidity) {
        if (reserve0 == 0 || reserve1 == 0 || totalLiquidity == 0) revert NotInitialized();
        if (amount0Desired == 0 || amount1Desired == 0) revert ZeroAmount();

        uint256 amount1Optimal = (amount0Desired * reserve1) / reserve0;
        if (amount1Optimal <= amount1Desired) {
            amount0 = amount0Desired;
            amount1 = amount1Optimal;
        } else {
            uint256 amount0Optimal = (amount1Desired * reserve0) / reserve1;
            amount0 = amount0Optimal;
            amount1 = amount1Desired;
        }

        liquidity = _min((amount0 * totalLiquidity) / reserve0, (amount1 * totalLiquidity) / reserve1);
    }

    function quoteRemoveLiquidity(uint256 liquidity) public view returns (uint256 amount0, uint256 amount1) {
        if (reserve0 == 0 || reserve1 == 0 || totalLiquidity == 0) revert NotInitialized();
        if (liquidity == 0) revert ZeroAmount();

        amount0 = (liquidity * reserve0) / totalLiquidity;
        amount1 = (liquidity * reserve1) / totalLiquidity;
    }

    function _allowEnc(euint64 v) internal {
        FHE.allowThis(v);
    }

    function _allowEncFor(euint64 v, address account) internal {
        FHE.allowThis(v);
        FHE.allow(v, account);
    }

    function _amountInAfterFee(uint256 amountIn) internal pure returns (uint256) {
        return amountIn - ((amountIn * SWAP_FEE_BPS) / BPS_DENOMINATOR);
    }

    function _checkDeadline(uint256 deadline) internal view {
        if (block.timestamp > deadline) revert Expired();
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;

        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
