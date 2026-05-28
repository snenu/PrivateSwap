# PrivateSwap Security Audit Checklist

## Scope

- `packages/contracts/contracts/PrivateSwapPool.sol`
- `packages/contracts/contracts/MintableERC20.sol`
- Deployment scripts and live verification scripts under `packages/contracts/scripts`
- Web transaction paths in `apps/web/src/App.tsx`

## Invariants To Review

- Recorded reserves must match the ERC20 balances held by `PrivateSwapPool`.
- `encReserve0` and `encReserve1` must stay synchronized with plaintext reserves after initialize, swap, add liquidity, and remove liquidity.
- `lastEncAmountOutOf(account)` must be scoped per caller and must not be overwritten by another account's swap.
- `amountIn * reserveOut` must stay inside the supported live `euint64` multiplication path.
- LP shares must be minted and burned proportionally and must not allow reserve extraction beyond the holder's share.
- Committed swaps must bind user, amounts, direction, salt, pool address, and chain ID.

## Tests Already Covered

- Initialization mirrors plaintext reserves into FHE reserves.
- Public test liquidity initializes directly on-chain.
- Swaps settle ERC20 transfers and decrypt the FHE amount-out mirror.
- Committed swaps reject missing or mismatched commitments and clear valid commitments after reveal.
- Public quotes reject inputs that would overflow the live encrypted `euint64` mirror path.
- Add/remove liquidity updates plaintext reserves, LP shares, and encrypted reserves.
- Encrypted swap outputs remain wallet scoped.
- The web CoFHE client discards stale wallet/network sessions before exposing decrypt readiness.
- Faucet cooldown minting works for test tokens.

## Open Audit Items

- External review of the hybrid privacy model and user-facing claims.
- External review of FHE access-control permissions and ciphertext handle exposure.
- Economic review of the constant-product approximation and no-fee AMM behavior.
- Browser-wallet compatibility review across common injected wallet extensions.
- Deployment review after every Sepolia redeploy, including bytecode verification and monitor output.

## FHERC20 Boundary

PrivateSwap does not enable FHERC20 settlement in production mode yet. The current public package for Fhenix confidential contracts is still marked unaudited by its own README, so settlement remains standard ERC20 while the contract proves the CoFHE compute/decrypt loop through the encrypted AMM mirror.
