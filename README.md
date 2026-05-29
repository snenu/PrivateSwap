# PrivateSwap

**PrivateSwap** is a live-chain decentralized exchange prototype on **Ethereum Sepolia** that uses **Fhenix CoFHE** (fully homomorphic encryption) to maintain an encrypted AMM mirror inside the smart contract. The UI walks through **submit → FHE compute → decrypt for view** using deployed contracts, live Sepolia transactions, and the CoFHE threshold network.


Production app: https://private-swap-ochre.vercel.app

Make sure the hosted environment variables match the current addresses below before using the production app.


## What this app is

- A **single liquidity pool** between two Sepolia tokens (**PSA** and **PSB**, 6 decimals) implemented as mintable ERC20s with a guarded public testnet faucet that can be hidden in production UI builds.
- A **PrivateSwapPool** contract that:
  - Settles trades using normal **uint256** reserves and ERC20 `transfer` / `transferFrom` (so swaps work like a familiar AMM on testnet).
  - In parallel, maintains **encrypted reserves** and computes an **encrypted amount out** using **FHE** (`euint64`) so CoFHE can prove the full **FHE compute → decrypt for view** loop. The encrypted mirror is derived in-contract from settled public amounts, which prevents callers from submitting mismatched public and encrypted swap inputs. Swap bounds guard the mirrored encrypted multiplication so scaled token math stays inside the live Sepolia verifier path, and encrypted outputs are stored per user to avoid cross-wallet races.
  - Tracks LP shares on-chain, supports proportional add/remove liquidity, and keeps the encrypted reserve mirror synchronized through each liquidity mutation.
  - Supports optional committed swap intents through `commitSwap` + `swapWithCommitment`, giving the app a delayed-reveal order path while keeping normal one-transaction swaps available.

## What it does (user flow)

1. Connect a wallet on **Sepolia** (chain ID `11155111`).
2. The app initializes the **CoFHE client** and a **self-permit** (required for decryption APIs).
3. If needed, claim test PSA/PSB from the token faucets.
4. Choose swap direction, amount, and slippage.
5. Optional: enable the committed-intent path, which submits a commitment transaction before the reveal/swap transaction.
6. **Swap and decrypt** runs: exact ERC20 approval if needed, pool `swap` or `swapWithCommitment`, then **view decryption** of your wallet-scoped encrypted amount out for display.
7. Add or remove pool liquidity from the Liquidity view, with exact ERC20 approvals and on-chain LP share accounting.

## Why it exists (use cases)

- **Education and validation:** Show how **CoFHE** fits into a DEX-style flow without hiding that ERC20 movements on Sepolia are still visible where normal transfers are used.
- **Hackathons / judges:** Clear story: **MEV / visibility** problems on public mempools vs **encrypted computation** on-chain; this repo makes the **FHE path** real and testable.
- **Reference architecture:** Documents a working hybrid CoFHE + ERC20 testnet pattern with clear boundaries around what is and is not private today.

## Honest privacy model (important)

- **CoFHE** maintains encrypted pool state and the contract performs **FHE arithmetic** on that encrypted mirror.
- **Standard ERC20** settlement on Sepolia means **transfer amounts** can still be visible in the usual ways. This **hybrid** keeps the stack **working end-to-end** on public testnet without FHERC20 in v1.
- Do **not** treat this as full transactional hiding of size on Ethereum today; treat it as a **real FHE integration** plus transparent ERC20 plumbing.
- The pool intentionally derives encrypted swap inputs from the settled public `amountIn` instead of accepting a separate `InEuint64`; that removes a public/encrypted mismatch attack path.
- This repo is hardened for a live Sepolia demo, but it is not mainnet-ready until the contracts, dependencies, and CoFHE trust assumptions have gone through an external production audit.

## Live deployment (Sepolia)

Contracts are deployed to **Ethereum Sepolia**. Addresses are stored in [`packages/contracts/deployments/sepolia.json`](packages/contracts/deployments/sepolia.json) after you run deploy.

**Example deployment (update if you redeploy; see `deployments/sepolia.json`):**

| | Address |
|---|---------|
| **PrivateSwapPool** | `0xB94437725b64a614b574d626022307a1AFF5608b` |
| **PSA (token0)** | `0xaa55B3eedaa0d947D24a1736530287639469A0C5` |
| **PSB (token1)** | `0x04519E636b0B0Eb0822307a2E15F0fCD434e4d6A` |
| **Swap fee** | `30` bps (0.30%) |
| **Transaction deadline** | `1200` seconds |

The current Sepolia deployment includes the Wave 5 pool entrypoints for committed swaps, commitment cancellation, LP accounting, add/remove liquidity, a 30 bps LP fee, transaction deadline protection, indexed swap history, and the encrypted CoFHE reserve mirror.

Copy `pool`, `token0`, and `token1` into `apps/web/.env` as `VITE_POOL_ADDRESS`, `VITE_TOKEN0_ADDRESS`, and `VITE_TOKEN1_ADDRESS`. Optionally set `VITE_SEPOLIA_RPC_URL` to your RPC (Alchemy, Infura, etc.). Set `VITE_ENABLE_FAUCET=true` for judged demos so users can claim PSA/PSB; leave it unset or set it to `false` when you intentionally want to hide test-token actions.

For multiple deployed pools, set `VITE_POOLS_JSON` instead of the single-pool variables:

```json
[{"id":"psa-psb","label":"PSA / PSB","pool":"0x...","token0":"0x...","token1":"0x...","token0Symbol":"PSA","token1Symbol":"PSB"}]
```

**Never commit** `.env` files or **private keys** to git. The repository ignores `.env` by default.

## Requirements

- Node.js 20+
- npm
- MetaMask (or another injected wallet) on **Sepolia**
- Sepolia ETH from a [testnet faucet](https://ethereum.org/en/developers/docs/networks/#ethereum-testnets)

## Install & build

```bash
npm install
npm run compile -w packages/contracts
npm run test -w packages/contracts
npm run build -w apps/web
```

## Deploy contracts (Sepolia)

1. Create `packages/contracts/.env` (see `.env.example`):

   - `PRIVATE_KEY` — **test wallet only**; never reuse a personal or funded wallet key.
   - `SEPOLIA_RPC_URL` — HTTPS RPC URL for Sepolia.

2. Deploy:

   ```bash
   npm run deploy:sepolia -w packages/contracts
   ```

   Deployment seeds initial liquidity with `initialize`, which creates the initial encrypted reserve handles on-chain from the settled liquidity amounts.

3. Optional — mint extra test PSA/PSB to the deployer (owner). The token contracts also expose `claimFaucet()` for public testnet balances:

   ```bash
   npm run mint:test -w packages/contracts
   ```

4. Copy addresses from `packages/contracts/deployments/sepolia.json` into `apps/web/.env`.

## Run the web app

```bash
npm run dev -w apps/web
```

Open the printed local URL, connect on **Sepolia**, and claim PSA/PSB from the app if your wallet does not already hold tokens.

## Deploy web (Vercel)

The repository includes both a root `vercel.json` for monorepo deployments and `apps/web/vercel.json` for the existing `private-swap` Vercel project, whose root directory is `apps/web`. In Vercel, set these environment variables to the current Sepolia deployment:

- `VITE_POOL_ADDRESS`
- `VITE_TOKEN0_ADDRESS`
- `VITE_TOKEN1_ADDRESS`
- `VITE_SEPOLIA_RPC_URL`
- `VITE_ENABLE_FAUCET=true` for hackathon judging and demos, or omit/set `false` for a cleaner production-facing preview

After changing any address, redeploy the web app so the hosted preview is not pointing at stale contracts.

## Live verification

```bash
npm run verify:sepolia -w packages/contracts
```

This read-only check confirms deployed bytecode, token metadata, reserves, faucet amount, and a live quote. To run the full live FHE mirror path with a tiny write swap:

```bash
npm run smoke:sepolia -w packages/contracts
```

The write check submits `swap`, reads the mined `Swap` event amount, reads `lastEncAmountOutOf(deployer)`, decrypts via `decryptForView`, and fails if the decrypted value does not match the settled on-chain output.

For production monitoring and indexed activity checks:

```bash
npm run monitor:sepolia -w packages/contracts
```

The monitor is read-only. It checks bytecode, reserve/token-balance accounting, live quotes in both directions, and recent indexed `Swap` events. Set `MONITOR_REQUIRE_RECENT_SWAP=true` if your deployment should alert when no swap appears inside the lookback window.

## Roadmap

Waves 1 through 4 are complete for the hybrid live-testnet app. All remaining and future work is tracked only in Wave 5.

### Wave 1 — Done: Core Contracts And FHE Mirror

Delivered:

- Mintable Sepolia PSA/PSB ERC20 test tokens with owner minting.
- `PrivateSwapPool` AMM with public ERC20 settlement and encrypted `euint64` reserve mirrors.
- In-contract derivation of encrypted swap inputs from settled public `amountIn`, removing the public/encrypted mismatch path.
- Per-wallet encrypted swap outputs through `lastEncAmountOutOf(account)`.
- Bounds checks for the live Sepolia `uint64` encrypted math path.

### Wave 2 — Done: Wallet, CoFHE, And Swap UX

Delivered:

- React/Vite swap app with Sepolia network gating and injected-wallet connection.
- CoFHE client lifecycle with wallet-scoped client setup, self-permit creation, retry handling, and decrypt-for-view support.
- Quote, slippage, minimum-out, price-impact, balance, reserve, and transaction-state UI.
- Exact ERC20 approval flow instead of unlimited approvals.
- Optional faucet UI controlled by `VITE_ENABLE_FAUCET`.

### Wave 3 — Done: Sepolia Deployment And Live Verification

Delivered:

- Fresh Sepolia deployment for PSA, PSB, and `PrivateSwapPool`.
- Deployment metadata stored in `packages/contracts/deployments/sepolia.json`.
- Read-only live verifier for deployed bytecode, metadata, reserves, faucet amount, and quotes.
- Write smoke verifier that submits a real Sepolia swap, reads the mined `Swap` event, reads `lastEncAmountOutOf`, decrypts with CoFHE, and checks the decrypted output against the settled on-chain output.
- Hardhat mock FHE test coverage for initialization, swaps, per-user encrypted outputs, reserve mirroring, and faucets.

### Wave 4 — Done: Production Web Release

Delivered:

- Redesigned responsive UI with focused swap flow, wallet state, balance panel, liquidity panel, execution tracker, and production copy.
- App-local ABI definitions so the Vercel web build is self-contained.
- Vercel configuration for the existing `apps/web` project root.
- Vercel production environment variables for the current Sepolia deployment.
- Production deployment at https://private-swap-ochre.vercel.app.
- Browser verification of the deployed app: current pool address, live quote, faucet controls, balances/liquidity panels, and no console errors.
- App-local lockfile retained for the existing Vercel project root; dependency audit caveats are documented below.

### Wave 5 — Done: Production Hardening And Operational UX

Delivered:

- On-chain LP shares with `addLiquidity`, `removeLiquidity`, `quoteAddLiquidity`, and `quoteRemoveLiquidity`.
- Optional committed swap intents with `commitSwap` and `swapWithCommitment`.
- Commitment cancellation for abandoned delayed-reveal swap intents.
- A 30 bps LP fee and a 20 minute deadline on swaps and liquidity mutations.
- Indexed swap history in the web app using live Sepolia `Swap` events.
- Pool health checks in the web app, including reserve-vs-token-balance accounting.
- Multi-pool-ready web configuration through `VITE_POOLS_JSON`, while keeping the existing single-pool env variables supported.
- Production monitor script for bytecode, reserves, quotes, accounting, and recent indexed activity.
- Frontend CoFHE session handling hardened against wallet/network switches while a permit setup is still in flight.
- Public quote API now enforces the same live encrypted math bounds as swap execution, so integrations cannot receive an executable-looking quote for a swap that the FHE mirror will reject.
- Swap execution now rejects dust trades that round down to zero output, so direct contract callers cannot accidentally donate input tokens for no return.
- Frontend users can cancel stale committed swap intents, see faucet cooldown state, and get mode-specific execution steps for swaps, liquidity, and faucet claims.
- CoFHE SDK code is lazy-loaded after a wallet session needs it, reducing the initial app bundle.
- GitHub Actions CI verifies compile, contract tests, frontend lint, and frontend build on pushes and pull requests.
- Live write smoke checks compare decrypted CoFHE output against the mined `Swap` event output, avoiding stale pre-submit quote false failures.
- Expanded Hardhat mock tests for committed swaps, LP reserve synchronization, and encrypted math quote bounds.

Still intentionally not claimed:

- Full confidential token settlement is not enabled in production mode. Fhenix has FHERC20 primitives, but the currently published package warns that those contracts are in active development and unaudited. PrivateSwap therefore keeps the honest hybrid settlement model until FHERC20 or equivalent primitives are audited and production-ready for this use case.
- An external audit has not been performed. The repo now has stronger tests and an audit handoff checklist in [`docs/security-audit-checklist.md`](docs/security-audit-checklist.md), but a third-party review is still required before higher-value demos.
- A clean dependency-security audit is not claimed. The current Fhenix, Hardhat, wagmi, and wallet stacks still bring transitive advisories that should be tracked with upstream package updates before a real-money launch.

## Troubleshooting

### CoFHE stuck on “initializing” or never “ready”

- You must be on **Ethereum Sepolia** (chain ID `11155111`). Use **Switch to Sepolia** in the app if needed.
- Approve the wallet connection and any **sign** requests from CoFHE (permits use typed data).
- If it fails once, use **Retry CoFHE** on the swap card after fixing the network.
- The CoFHE client binds to `useWalletClient({ account })` and `usePublicClient({ chainId: sepolia })` so it only initializes when the wallet is actually on Sepolia with a resolved account.

### Console: `chrome.runtime.sendMessage` / “must specify an Extension ID”

That stack trace comes from the **wallet extension’s** `inpage.js` (e.g. MetaMask) talking to Chrome, not from PrivateSwap source. It often appears when multiple extensions inject `window.ethereum` or when MetaMask handles RPC internally. **If the app connects and swaps work, you can ignore it.** Mitigations:

- Use **one** wallet extension for the site (temporarily disable others).
- **Update MetaMask** (or your wallet) to the latest version.
- Hard-refresh the page after unlocking the wallet.

### Development note

`React.StrictMode` is **not** enabled around the app so CoFHE / TFHE initialization is not mounted twice in dev (which could leave the client in a bad state).

## Stack

| Layer | Technology |
|-------|------------|
| Contracts | Solidity, `@fhenixprotocol/cofhe-contracts` (`FHE.sol`), OpenZeppelin |
| Tooling | Hardhat **2.22.19**, `cofhe-hardhat-plugin` (mocks for local tests) |
| Frontend | Vite, React, wagmi, viem, `@cofhe/sdk/web` |
| Testnet | Ethereum Sepolia (`11155111`) |

## References

- [CoFHE quick start](https://cofhe-docs.fhenix.zone/fhe-library/introduction/quick-start)
- [Client setup (viem / wagmi)](https://cofhe-docs.fhenix.zone/client-sdk/guides/client-setup)
- [Encrypting inputs](https://cofhe-docs.fhenix.zone/client-sdk/guides/encrypting-inputs)
- [Decrypt to view](https://cofhe-docs.fhenix.zone/client-sdk/guides/decrypt-to-view)

## Security reminders

- **Rotate any private key** that has been pasted into chat, tickets, or shared screens.
- Use a **dedicated throwaway wallet** for testnet and **never** fund it from wallets you care about.

## License

MIT (see package metadata).
