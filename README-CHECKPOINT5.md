# BountyPulse — Checkpoint 5: Live Event Auto-Sync

Checkpoint 5 completes the DApp by replacing cross-window manual refreshes with Ethers.js contract event listeners.

## What changed

No Solidity change is required if the Checkpoint 2 `BountyPulse.sol` is still the deployed contract: it already declares and emits the nine state-change events required by the finished frontend.

The frontend now listens for:

- `UserRegistered`
- `BountyPosted`
- `BidSubmitted`
- `BountyFunded`
- `WorkSubmitted`
- `WorkApproved`
- `BountyDisputed`
- `DisputeResolved`
- `FundsClaimed`

Each event is used as a notification signal. The UI then re-reads the affected view data from the contract and re-renders it. The event payload is not treated as the database.

## Install over the working Checkpoint 4 project

From the repository root:

```bash
cp -a /path/to/BountyPulse_Checkpoint5/frontend/. frontend/
cp -a /path/to/BountyPulse_Checkpoint5/tools/. tools/
cp /path/to/BountyPulse_Checkpoint5/README-CHECKPOINT5.md .
chmod +x tools/checkpoint5-check.sh tools/final-project-check.sh tools/generate-frontend-config.sh
```

Keep the existing `frontend/BountyPulseABI.json` and ignored `frontend/config.local.js` from the working project.

## Verify the existing deployment

```bash
set -a
source .env
set +a

cast chain-id --rpc-url "$ANVIL_RPC_URL"
cast code "$BOUNTYPULSE_ADDRESS" --rpc-url "$ANVIL_RPC_URL"
```

Expected chain: `31337`. Contract bytecode must be longer than `0x`.

If Anvil was restarted, redeploy and regenerate the frontend config:

```bash
forge script script/DeployBountyPulse.s.sol:DeployBountyPulse \
  --rpc-url "$ANVIL_RPC_URL" \
  --broadcast \
  -vvvv

# Put the new address in .env, then:
./tools/generate-frontend-config.sh
```

## Run the Checkpoint 5 checker

```bash
./tools/checkpoint5-check.sh
```

It checks JavaScript syntax, DOM references, the nine event names, listener cleanup, absence of `window.location.reload()`, absence of periodic polling, Solidity event emissions, ABI event entries, Anvil, and deployed bytecode.

## Start the frontend

```bash
cd frontend
python3 -m http.server 5500
```

Open `http://127.0.0.1:5500`.

The Live Event Sync card should show approximately:

```text
Live · listening
Listeners: 9 / 9
Events received: 0
```

## Required side-by-side proof

Use separate browser profiles so each profile can keep a different MetaMask account active.

- Window 1: Client
- Window 2: selected Freelancer
- Optional Window 3: Arbiter

Prepare a bounty until its status is `Submitted`:

1. Client posts bounty.
2. Freelancer bids.
3. Client pays the exact selected bid into escrow.
4. Freelancer uploads work and submits the CID.

Now leave both windows open. Do not click the manual refresh button.

In the Client window click `Approve work`.

The contract emits `WorkApproved`. In the Freelancer window the listener receives it, re-reads `withdrawableBalances(activeAccount)`, and the `Unclaimed Earnings` card changes automatically to the 98% payout. The activity log should show `LIVE WorkApproved` followed by `Auto-sync complete`.

That is the core Checkpoint 5 proof.

## Listener lifecycle

The app detaches old contract listeners before recreating the Contract object on `accountsChanged` or `chainChanged`. This prevents duplicate callbacks from accumulating after repeated MetaMask switches.

Events are debounced for 180 ms. If one transaction emits several relevant events, the DApp coalesces them into the smallest set of view-data refreshes instead of rendering repeatedly.

## Why both events and view calls are used

Solidity events are notifications. The contract state remains authoritative. For example, `WorkApproved` tells the Freelancer window that something changed, then the frontend calls:

```javascript
await contract.withdrawableBalances(activeAccount)
await contract.getBounty(bountyId)
await contract.getUser(activeAccount)
```

as needed. This avoids keeping a second unofficial database in JavaScript.

## Final automated project check

Run:

```bash
./tools/final-project-check.sh
```

This performs the Foundry build, Foundry tests, Checkpoint 5 frontend/event checks, ABI validation, secret hygiene checks, local-chain checks, and an optional Pinata authentication check.

## Final Git commit

```bash
git status --short
git check-ignore -v .env
git check-ignore -v frontend/config.local.js

git add \
  frontend/app.js \
  frontend/index.html \
  frontend/styles.css \
  frontend/ipfsHelper.js \
  frontend/config.example.js \
  frontend/.gitignore \
  frontend/BountyPulseABI.json \
  tools/generate-frontend-config.sh \
  tools/checkpoint5-check.sh \
  tools/final-project-check.sh \
  README-CHECKPOINT5.md

git commit -m "feat: complete BountyPulse live event auto-sync"
git push
```

Never commit `.env` or `frontend/config.local.js`.
