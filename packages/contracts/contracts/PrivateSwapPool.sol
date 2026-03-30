// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title PrivateSwapPool
/// @notice Hybrid AMM: plaintext reserves drive ERC20 settlement; parallel FHE path mirrors x*y=k on euint64.
/// @dev Amounts must fit uint64 so encrypted mirrors stay on euint64. Client encrypts the same numeric amount as `amountIn`.
contract PrivateSwapPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token0;
    IERC20 public immutable token1;

    address public owner;

    uint256 public reserve0;
    uint256 public reserve1;

    euint64 public encReserve0;
    euint64 public encReserve1;

    /// @notice Encrypted amount out from the last swap (CoFHE decrypt demo)
    euint64 public lastEncAmountOut;

    bool public lastZeroForOne;

    event Initialized(uint256 reserve0, uint256 reserve1);
    event Swap(address indexed user, bool zeroForOne, uint256 amountIn, uint256 amountOut);

    error NotOwner();
    error AlreadyInitialized();
    error NotInitialized();
    error ZeroAmount();
    error Slippage();
    error AmountTooLarge();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _token0, address _token1) {
        token0 = IERC20(_token0);
        token1 = IERC20(_token1);
        owner = msg.sender;
    }

    function initialize(
        uint256 amount0,
        uint256 amount1,
        InEuint64 calldata encR0,
        InEuint64 calldata encR1
    ) external onlyOwner {
        if (reserve0 != 0 || reserve1 != 0) revert AlreadyInitialized();
        if (amount0 == 0 || amount1 == 0) revert ZeroAmount();
        if (amount0 > type(uint64).max || amount1 > type(uint64).max) revert AmountTooLarge();

        token0.safeTransferFrom(msg.sender, address(this), amount0);
        token1.safeTransferFrom(msg.sender, address(this), amount1);

        reserve0 = amount0;
        reserve1 = amount1;

        encReserve0 = FHE.asEuint64(encR0);
        encReserve1 = FHE.asEuint64(encR1);
        _allowEnc(encReserve0);
        _allowEnc(encReserve1);

        emit Initialized(reserve0, reserve1);
    }

    function swap(
        uint256 amountIn,
        uint256 minAmountOut,
        bool zeroForOne,
        InEuint64 calldata encAmountIn
    ) external nonReentrant returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        if (reserve0 == 0 || reserve1 == 0) revert NotInitialized();
        if (amountIn > type(uint64).max) revert AmountTooLarge();

        IERC20 tokenIn = zeroForOne ? token0 : token1;
        IERC20 tokenOut = zeroForOne ? token1 : token0;

        uint256 reserveIn = zeroForOne ? reserve0 : reserve1;
        uint256 reserveOut = zeroForOne ? reserve1 : reserve0;

        amountOut = (amountIn * reserveOut) / (reserveIn + amountIn);
        if (amountOut < minAmountOut) revert Slippage();

        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);

        if (zeroForOne) {
            reserve0 = reserve0 + amountIn;
            reserve1 = reserve1 - amountOut;
        } else {
            reserve1 = reserve1 + amountIn;
            reserve0 = reserve0 - amountOut;
        }

        euint64 encIn = FHE.asEuint64(encAmountIn);
        euint64 rIn = zeroForOne ? encReserve0 : encReserve1;
        euint64 rOut = zeroForOne ? encReserve1 : encReserve0;

        euint64 num = FHE.mul(encIn, rOut);
        euint64 den = FHE.add(rIn, encIn);
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

        lastEncAmountOut = encOut;
        _allowEnc(lastEncAmountOut);
        lastZeroForOne = zeroForOne;

        tokenOut.safeTransfer(msg.sender, amountOut);

        emit Swap(msg.sender, zeroForOne, amountIn, amountOut);
    }

    function getAmountOut(uint256 amountIn, bool zeroForOne) external view returns (uint256) {
        if (reserve0 == 0 || reserve1 == 0 || amountIn == 0) return 0;
        uint256 reserveIn = zeroForOne ? reserve0 : reserve1;
        uint256 reserveOut = zeroForOne ? reserve1 : reserve0;
        return (amountIn * reserveOut) / (reserveIn + amountIn);
    }

    function _allowEnc(euint64 v) internal {
        FHE.allowThis(v);
        FHE.allowSender(v);
    }
}
