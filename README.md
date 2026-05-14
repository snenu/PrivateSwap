# PrivateSwap

**PrivateSwap** is a live-chain decentralized exchange prototype on **Ethereum Sepolia** that uses **Fhenix CoFHE** (fully homomorphic encryption) to maintain an encrypted AMM mirror inside the smart contract. The UI walks through **submit → FHE compute → decrypt for view** using deployed contracts, live Sepolia transactions, and the CoFHE threshold network.


Production app: https://private-swap-ochre.vercel.app

Make sure the hosted environment variables match the current addresses below before using the production app.


## What this app is

- A **single liquidity pool** between two Sepolia tokens (**PSA** and **PSB**, 6 decimals) implemented as mintable ERC20s with a guarded public testnet faucet that can be hidden in production UI builds.
- A **PrivateSwapPool** contract that:
  - Settles trades using normal **uint256** reserves and ERC20 `transfer` / `transferFrom` (so swaps work like a familiar AMM on testnet).
  - In parallel, maintains **encrypted reserves** and computes an **encrypted amount out** using **FHE** (`euint64`) so CoFHE can prove the full **FHE compute → decrypt for view** loop. The encrypted mirror is derived in-contract from settled public amounts, which prevents callers from submitting mismatched public and encrypted swap inputs. Swap bounds guard the mirrored encrypted multiplication so scaled token math stays inside the live Sepolia verifier path, and encrypted outputs are stored per user to avoid cross-wallet races.

## What it does (user flow)

1. Connect a wallet on **Sepolia** (chain ID `11155111`).
2. The app initializes the **CoFHE client** and a **self-permit** (required for decryption APIs).
3. If needed, claim test PSA/PSB from the token faucets.
4. Choose swap direction, amount, and slippage.
5. **Swap and decrypt** runs: exact ERC20 approval if needed, pool `swap`, then **view decryption** of your wallet-scoped encrypted amount out for display.

## Why it exists (use cases)

- **Education and validation:** Show how **CoFHE** fits into a DEX-style flow without hiding that ERC20 movements on Sepolia are still visible where normal transfers are used.
- **Hackathons / judges:** Clear story: **MEV / visibility** problems on public mempools vs **encrypted computation** on-chain; this repo makes the **FHE path** real and testable.
- **Reference architecture:** Documents a working hybrid CoFHE + ERC20 testnet pattern with clear boundaries around what is and is not private today.

## Honest privacy model (important)

- **CoFHE** maintains encrypted pool state and the contract performs **FHE arithmetic** on that encrypted mirror.
- **Standard ERC20** settlement on Sepolia means **transfer amounts** can still be visible in the usual ways. This **hybrid** keeps the stack **working end-to-end** on public testnet without FHERC20 in v1.
- Do **not** treat this as full transactional hiding of size on Ethereum today; treat it as a **real FHE integration** plus transparent ERC20 plumbing.
- The pool intentionally derives encrypted swap inputs from the settled public `amountIn` instead of accepting a separate `InEuint64`; that removes a public/encrypted mismatch attack path.
- This repo is production-grade for supported live testnets.

## Live deployment (Sepolia)

Contracts are deployed to **Ethereum Sepolia**. Addresses are stored in [`packages/contracts/deployments/sepolia.json`](packages/contracts/deployments/sepolia.json) after you run deploy.

**Example deployment (update if you redeploy; see `deployments/sepolia.json`):**

| | Address |
|---|---------|
| **PrivateSwapPool** | `0x813df543cbC212A948934aAEE560243631588F25` |
| **PSA (token0)** | `0xE5fB992b9b58c3f1FEDEE40900B4B762e87457C5` |
| **PSB (token1)** | `0x0980F7b6D6C308f81ACF164c2e3821C1AaB2127E` |

Copy `pool`, `token0`, and `token1` into `apps/web/.env` as `VITE_POOL_ADDRESS`, `VITE_TOKEN0_ADDRESS`, and `VITE_TOKEN1_ADDRESS`. Optionally set `VITE_SEPOLIA_RPC_URL` to your RPC (Alchemy, Infura, etc.) and `VITE_ENABLE_FAUCET=false` to hide faucet actions.

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
- `VITE_ENABLE_FAUCET=false` for a cleaner production-facing preview

After changing any address, redeploy the web app so the hosted preview is not pointing at stale contracts.

## Live verification

```bash
npm run verify:sepolia -w packages/contracts
```

This read-only check confirms deployed bytecode, token metadata, reserves, faucet amount, and a live quote. To run the full live FHE mirror path with a tiny write swap:

```bash
npm run smoke:sepolia -w packages/contracts
```

The write check submits `swap`, reads `lastEncAmountOutOf(deployer)`, decrypts via `decryptForView`, and fails if the decrypted value does not match the AMM quote.

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
- Write smoke verifier that submits a real Sepolia swap, reads `lastEncAmountOutOf`, decrypts with CoFHE, and checks the decrypted output against the AMM quote.
- Hardhat mock FHE test coverage for initialization, swaps, per-user encrypted outputs, reserve mirroring, and faucets.

### Wave 4 — Done: Production Web Release

Delivered:

- Redesigned responsive UI with focused swap flow, wallet state, balance panel, liquidity panel, execution tracker, and production copy.
- App-local ABI definitions so the Vercel web build is self-contained.
- Vercel configuration for the existing `apps/web` project root.
- Vercel production environment variables for the current Sepolia deployment.
- Production deployment at https://private-swap-ochre.vercel.app.
- Browser verification of the deployed app: current pool address, live quote, hidden production faucet, balances/liquidity panels, and no console errors.
- App-local lockfile and clean app-local production audit path.

### Wave 5 — Remaining / Future Work

- Move from public ERC20 settlement to confidential token settlement when production-ready FHERC20 or equivalent primitives are available.
- Add deeper privacy mechanisms such as batched private orders, private routing, or delayed reveals.
- Add external contract audit coverage before any higher-value testnet or production demo.
- Add production monitoring, alerting, analytics, and indexed historical swap views.
- Add multi-pool routing and richer liquidity-management workflows.

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
