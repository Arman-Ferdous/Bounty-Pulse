# BountyPulse — Checkpoint 4: Feed & Escrow Flow

This bundle extends the working Checkpoint 3 frontend. The Solidity contract is unchanged.

Checkpoint 4 adds:

- Dynamic bounty Registry fetching with `bountyCount()` + `getBounty(id)`
- Dynamic bid Registry fetching with `bidCountByBounty(id)` + `getBid(bountyId, bidId)`
- IPFS metadata rendering inside bounty cards
- Status filtering
- JavaScript sorting, including Highest Budget first
- Freelancer `submitBid(...)` controls
- Client exact-value `fundBounty(...)` controls using `{ value: selectedBid.amount }`
- Work approval/dispute controls to complete the escrow workflow
- Arbiter dispute-resolution controls
- Freelancer/Arbiter Unclaimed Earnings tracker
- `claimFunds()` MetaMask transaction and on-chain zero-balance verification
- Manual `Refresh from chain` button
- No `contract.on(...)` blockchain listeners yet; those belong to Checkpoint 5

## 1. Copy into the existing project

From the existing BountyPulse repository, copy the bundle's `frontend/` and `tools/` files over the current Checkpoint 3 versions. Keep your existing `frontend/BountyPulseABI.json` and `frontend/config.local.js`.

If the ABI is missing, regenerate it after `forge build`:

```bash
jq '.abi' out/BountyPulse.sol/BountyPulse.json > frontend/BountyPulseABI.json
```

No contract redeployment is required when `src/BountyPulse.sol` did not change.

## 2. Recreate local browser configuration when needed

```bash
./tools/generate-frontend-config.sh
```

`frontend/config.local.js` is ignored by Git and should contain the current local contract address and temporary/restricted Pinata JWT.

## 3. Check the environment

```bash
./tools/checkpoint4-check.sh
```

## 4. Start the DApp

```bash
cd frontend
python3 -m http.server 5500
```

Open:

```text
http://127.0.0.1:5500
```

## 5. Recommended live demonstration

Use three imported Anvil accounts:

- Account 0: Arbiter
- Account 1: Client
- Account 2: Freelancer

### A. Feed + sorting

1. Client posts two or three bounties with different maximum budgets.
2. Use `Highest budget first` and show the cards reorder immediately.
3. Explain that sorting happens on the already-fetched JavaScript array; no sorting transaction is sent to Ethereum.

### B. Bid

1. Switch MetaMask to the Freelancer.
2. An Open bounty card shows a quote form.
3. Submit a bid less than or equal to the max budget.
4. The Solidity function is non-payable, so the quote transaction sends no bounty ETH.

### C. Exact escrow

1. Switch MetaMask back to the Client.
2. Find the Client's Open bounty and the submitted bid.
3. Click `Pay exact X ETH`.
4. `app.js` passes the selected bid's on-chain amount as the transaction `value`.
5. After mining, the DApp reads `getBounty(id)` and verifies both:
   - `status == Locked`
   - `escrowAmount == selected bid amount`

### D. Create pull-payment earnings

To demonstrate Claim Funds, complete the normal approval path:

1. Freelancer uploads work for the Locked bounty.
2. Client clicks `Approve work`.
3. The contract allocates 98% to the Freelancer's withdrawable balance and 2% to the Arbiter's withdrawable balance.

### E. Claim Funds

1. Switch to the Freelancer.
2. Show `Unclaimed Earnings`.
3. Click `Claim Funds` and confirm MetaMask.
4. The DApp reads `withdrawableBalances(activeAccount)` again and verifies it is `0` after the claim.
5. Optionally repeat as the Arbiter for the 2% fee.

## 6. Independent Cast verification

```bash
set -a
source .env
set +a
```

Bounty count:

```bash
cast call "$BOUNTYPULSE_ADDRESS" \
  "bountyCount()(uint256)" \
  --rpc-url "$ANVIL_RPC_URL"
```

Bounty record:

```bash
cast call "$BOUNTYPULSE_ADDRESS" \
  "getBounty(uint256)((uint256,address,uint256,uint8,uint256,address,uint256,uint256,uint8,string,string))" \
  1 \
  --rpc-url "$ANVIL_RPC_URL"
```

Bid count for bounty 1:

```bash
cast call "$BOUNTYPULSE_ADDRESS" \
  "bidCountByBounty(uint256)(uint256)" \
  1 \
  --rpc-url "$ANVIL_RPC_URL"
```

Bid 1 for bounty 1:

```bash
cast call "$BOUNTYPULSE_ADDRESS" \
  "getBid(uint256,uint256)((uint256,address,uint256,bool))" \
  1 1 \
  --rpc-url "$ANVIL_RPC_URL"
```

Freelancer pull-payment balance:

```bash
cast call "$BOUNTYPULSE_ADDRESS" \
  "withdrawableBalances(address)(uint256)" \
  0xFREELANCER_ADDRESS \
  --rpc-url "$ANVIL_RPC_URL"
```

## 7. Checkpoint 5 boundary

There are no blockchain `contract.on(...)` listeners in this Checkpoint 4 implementation. This tab can refresh its own data after its own transactions and has a manual Refresh button, but a transaction made in a separate browser window does not trigger this window automatically. Checkpoint 5 should add contract event listeners so side-by-side Client and Freelancer windows synchronize without manual action.
