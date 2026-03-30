# PrivateSwap

**PrivateSwap** is a demonstration decentralized exchange on **Ethereum Sepolia** that uses **Fhenix CoFHE** (fully homomorphic encryption) so swap logic can run on **encrypted values** in the smart contract. The UI walks you through **encrypt → submit → decrypt**, aligned with a privacy-forward, MEV-aware story.

https://private-swap-ochre.vercel.app


## What this app is

- A **single liquidity pool** between two test tokens (**PSA** and **PSB**, 6 decimals) implemented as mintable ERC20s.
- A **PrivateSwapPool** contract that:
  - Settles trades using normal **uint256** reserves and ERC20 `transfer` / `transferFrom` (so swaps work like a familiar AMM on testnet).
  - In parallel, maintains **encrypted reserves** and computes an **encrypted amount out** using **FHE** (`euint64`) so CoFHE can prove the full **encrypt → FHE compute → decrypt** loop.

## What it does (user flow)

1. Connect a wallet on **Sepolia** (chain ID `11155111`).
2. The app initializes the **CoFHE client** and a **self-permit** (required for decryption APIs).
3. You choose swap direction (PSA → PSB or the reverse), amount, and slippage (in basis points).
4. **Encrypt & swap** runs: client-side encryption of the amount, optional ERC20 approval, pool `swap`, then **view decryption** of the last encrypted amount out for display.

## Why it exists (use cases)

- **Education & demos:** Show how **CoFHE** fits into a DEX-style flow without hiding that ERC20 movements on Sepolia are still visible where normal transfers are used.
- **Hackathons / judges:** Clear story: **MEV / visibility** problems on public mempools vs **encrypted computation** on-chain; this repo makes the **FHE path** real and testable.
- **Foundation for more:** Same patterns extend toward **FHERC20**, batched private orders, or stricter privacy models later.

## Honest privacy model (important)

- **CoFHE** encrypts inputs and the contract performs **FHE arithmetic** on encrypted pool state.
- **Standard ERC20** settlement on Sepolia means **transfer amounts** can still be visible in the usual ways. This **hybrid** keeps the stack **working end-to-end** on public testnet without FHERC20 in v1.
- Do **not** treat this as full transactional hiding of size on Ethereum today; treat it as a **real FHE integration** plus transparent ERC20 plumbing.

## Live deployment (Sepolia)

Contracts are deployed to **Ethereum Sepolia**. Addresses are stored in [`packages/contracts/deployments/sepolia.json`](packages/contracts/deployments/sepolia.json) after you run deploy.

**Example deployment (update if you redeploy — see `deployments/sepolia.json`):**

| | Address |
|---|---------|
| **PrivateSwapPool** | `0x05e3E59d1f02F3C24Dd889b90cf01c20e63E338C` |
| **PSA (token0)** | `0xccd90F4A166f26568AAB390E299845928F9E702a` |
| **PSB (token1)** | `0xA8fba68aD76aa5f2215B5f41d77723605c6f2f92` |

Copy `pool`, `token0`, and `token1` into `apps/web/.env` as `VITE_POOL_ADDRESS`, `VITE_TOKEN0_ADDRESS`, and `VITE_TOKEN1_ADDRESS`. Optionally set `VITE_SEPOLIA_RPC_URL` to your RPC (Alchemy, Infura, etc.).

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

   - `PRIVATE_KEY` — **test wallet only**; never reuse a mainnet key.
   - `SEPOLIA_RPC_URL` — HTTPS RPC URL for Sepolia.

2. Deploy:

   ```bash
   npm run deploy:sepolia -w packages/contracts
   ```

3. Optional — mint extra demo PSA/PSB to the deployer (owner):

   ```bash
   npm run mint:demo -w packages/contracts
   ```

4. Copy addresses from `packages/contracts/deployments/sepolia.json` into `apps/web/.env`.

## Run the web app

```bash
npm run dev -w apps/web
```

Open the printed local URL, connect the **same network (Sepolia)**, and use an account that holds **PSA** or **PSB** (e.g. owner-minted demo tokens).

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
- [End-to-end encrypt / decrypt](https://cofhe-docs.fhenix.zone/client-sdk/examples/end-to-end)

## Security reminders

- **Rotate any private key** that has been pasted into chat, tickets, or shared screens.
- Use a **dedicated throwaway wallet** for testnet and **never** fund it from mainnet identities you care about.

## License

MIT (see package metadata).
