# PrivateSwap Web

React/Vite frontend for the PrivateSwap live Sepolia app.

## Environment

Create `apps/web/.env`:

```bash
VITE_POOL_ADDRESS=0x...
VITE_TOKEN0_ADDRESS=0x...
VITE_TOKEN1_ADDRESS=0x...
VITE_SEPOLIA_RPC_URL=https://ethereum-sepolia.publicnode.com
VITE_ENABLE_FAUCET=true
```

The three contract addresses should match `packages/contracts/deployments/sepolia.json`. Set `VITE_ENABLE_FAUCET=false` when the deployment should not expose the test-token faucet button.

## Production preview

This app includes `apps/web/vercel.json` for Vercel projects whose root directory is `apps/web`. It builds with `npm run build` and publishes `dist`. Keep the Vercel environment variables in sync with the current `packages/contracts/deployments/sepolia.json` addresses before deploying.

## Commands

```bash
npm run dev -w apps/web
npm run build -w apps/web
npm run lint -w apps/web
```

The app expects Sepolia (`11155111`) and an injected wallet such as MetaMask.
