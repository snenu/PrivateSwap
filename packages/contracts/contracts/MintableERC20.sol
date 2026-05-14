// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Testnet ERC20 with owner-gated mint and a cooldown faucet for PrivateSwap.
contract MintableERC20 is ERC20, Ownable {
    uint8 private immutable _decimals;
    uint256 public immutable faucetAmount;
    uint256 public immutable faucetCooldown;

    mapping(address account => uint256 claimedAt) public lastFaucetClaim;

    event FaucetClaimed(address indexed account, uint256 amount);

    error FaucetCoolingDown(uint256 availableAt);

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) Ownable(msg.sender) {
        _decimals = decimals_;
        faucetAmount = 100 * (10 ** uint256(decimals_));
        faucetCooldown = 12 hours;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function claimFaucet() external {
        uint256 availableAt = lastFaucetClaim[msg.sender] + faucetCooldown;
        if (block.timestamp < availableAt) revert FaucetCoolingDown(availableAt);

        lastFaucetClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, faucetAmount);

        emit FaucetClaimed(msg.sender, faucetAmount);
    }
}
