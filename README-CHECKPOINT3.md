# BountyPulse Checkpoint 3 — IPFS Metadata Pipeline

This frontend is a Vanilla HTML/CSS/JavaScript adaptation of the supplied
`Lab5-Web3-Voting-Manual` structure:

- `index.html` provides the UI forms.
- `ipfsHelper.js` performs the Pinata HTTP POST and returns a CID.
- `app.js` uses Ethers.js v6 and MetaMask to pass the CID to BountyPulse.sol.
- `accountsChanged` and `chainChanged` refresh role/account detection.

## Required root `.env`

```dotenv
ANVIL_RPC_URL=http://127.0.0.1:8545
ANVIL_CHAIN_ID=31337
BOUNTYPULSE_ADDRESS=0xYOUR_DEPLOYED_ADDRESS
PINATA_JWT=YOUR_RESTRICTED_TEMPORARY_JWT
IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs
```

## Install into the existing Foundry repository

Copy the `frontend/` and `tools/` directories into the repository root.
Do not overwrite a newer file without reviewing the diff.

## Generate the browser-local configuration

```bash
chmod +x tools/generate-frontend-config.sh tools/checkpoint3-check.sh
./tools/generate-frontend-config.sh
```

`frontend/config.local.js` contains the local contract address and JWT. It is
ignored by `frontend/.gitignore`; never force-add it.

## Export the complete ABI

```bash
forge build
jq '.abi' out/BountyPulse.sol/BountyPulse.json > frontend/BountyPulseABI.json
jq empty frontend/BountyPulseABI.json
```

The DApp has a minimal fallback ABI, but the generated ABI is the correct team artifact.

## Run checks

```bash
./tools/checkpoint3-check.sh
```

## Serve the frontend

Do not open `index.html` with a `file://` URL.

```bash
cd frontend
python3 -m http.server 5500
```

Open `http://127.0.0.1:5500` in the browser that has MetaMask.

## Demonstration flow

1. Keep Anvil running and use the same instance on which BountyPulse was deployed.
2. MetaMask must be on Chain ID 31337.
3. Open the page and connect MetaMask.
4. Click **Test Pinata JWT**.
5. Use an unregistered Client account:
   - enter a name;
   - choose Client;
   - select an avatar image;
   - click **Upload Avatar & Register**;
   - show the returned CID, gateway preview, MetaMask transaction, and Registry verification.
6. Post a bounty:
   - enter title, description, and budget;
   - optionally select an attachment;
   - click **Upload Details & Post Bounty**;
   - show that a JSON metadata file was pinned and its CID was stored on-chain.
7. Switch MetaMask accounts and show that the role-specific panel updates without an address field.

## Checkpoint boundary

This bundle does not implement the Checkpoint 4 open-bounty feed, client-side
sorting, escrow button, or Claim Funds button. It also does not register
`contract.on(...)` listeners for Checkpoint 5. Those are intentionally separate.

## Security boundary

The course reference places a Pinata JWT in frontend JavaScript. This bundle at
least keeps it in ignored `config.local.js`. The token is still visible to the
local browser at runtime. Use a restricted/revocable key for the demo and revoke
it afterward. A production deployment should use a server-created presigned
upload URL instead of exposing a long-lived JWT.
