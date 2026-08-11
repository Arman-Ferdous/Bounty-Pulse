#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Checking BountyPulse Checkpoint 4..."
echo

required_files=(
  frontend/index.html
  frontend/app.js
  frontend/ipfsHelper.js
  frontend/styles.css
  frontend/BountyPulseABI.json
)

for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "FAIL: missing $file"
    exit 1
  fi
done

echo "PASS: Checkpoint 4 frontend files exist."

if command -v node >/dev/null 2>&1; then
  node --check frontend/app.js
  node --check frontend/ipfsHelper.js
  echo "PASS: JavaScript syntax checks passed."
else
  echo "WARN: node is not installed, so JS syntax checks were skipped."
fi

for needle in \
  'bidCountByBounty' \
  'getBid' \
  'submitBid' \
  'fundBounty' \
  'withdrawableBalances' \
  'claimFunds' \
  'budget-desc' \
  '{ value: amountWei }'
do
  if ! grep -Fq "$needle" frontend/app.js; then
    echo "FAIL: frontend/app.js is missing required Checkpoint 4 logic: $needle"
    exit 1
  fi
done

echo "PASS: feed, bid, exact-escrow, sorting, and Claim Funds logic are present."

if grep -Fq 'window.location.reload' frontend/app.js; then
  echo "FAIL: hard page reload logic found in frontend/app.js"
  exit 1
fi

echo "PASS: no window.location.reload() is used."

# Check the exported ABI contains the contract functions needed by this checkpoint.
for function_name in \
  bountyCount \
  getBounty \
  bidCountByBounty \
  getBid \
  submitBid \
  fundBounty \
  withdrawableBalances \
  claimFunds \
  submitWork \
  approveWork
do
  if ! jq -e --arg name "$function_name" \
      '.[] | select(.type == "function" and .name == $name)' \
      frontend/BountyPulseABI.json >/dev/null; then
    echo "FAIL: ABI is missing function: $function_name"
    exit 1
  fi
done

echo "PASS: exported ABI contains all required Checkpoint 4 functions."

if [[ -f frontend/config.local.js ]]; then
  if git check-ignore -q frontend/config.local.js 2>/dev/null; then
    echo "PASS: frontend/config.local.js is ignored by Git."
  else
    echo "WARN: frontend/config.local.js exists but Git did not report it as ignored."
  fi
else
  echo "WARN: frontend/config.local.js is not present. Run tools/generate-frontend-config.sh before browser testing."
fi

if [[ ! -f .env ]]; then
  echo "WARN: root .env is missing; skipping live Anvil/contract checks."
  exit 0
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

ANVIL_RPC_URL="${ANVIL_RPC_URL:-http://127.0.0.1:8545}"
ANVIL_CHAIN_ID="${ANVIL_CHAIN_ID:-31337}"

if ! command -v cast >/dev/null 2>&1; then
  echo "WARN: cast is not available; skipping live Anvil/contract checks."
  exit 0
fi

actual_chain_id="$(cast chain-id --rpc-url "$ANVIL_RPC_URL")"
if [[ "$actual_chain_id" != "$ANVIL_CHAIN_ID" ]]; then
  echo "FAIL: expected Chain ID $ANVIL_CHAIN_ID, got $actual_chain_id"
  exit 1
fi

echo "PASS: Anvil is reachable on Chain ID $actual_chain_id."

: "${BOUNTYPULSE_ADDRESS:?Missing BOUNTYPULSE_ADDRESS in .env}"
code="$(cast code "$BOUNTYPULSE_ADDRESS" --rpc-url "$ANVIL_RPC_URL")"
if [[ "$code" == "0x" ]]; then
  echo "FAIL: no BountyPulse bytecode exists at $BOUNTYPULSE_ADDRESS on the running Anvil instance."
  exit 1
fi

echo "PASS: BountyPulse bytecode exists at $BOUNTYPULSE_ADDRESS."

bounty_count="$(cast call "$BOUNTYPULSE_ADDRESS" 'bountyCount()(uint256)' --rpc-url "$ANVIL_RPC_URL")"
echo "PASS: bountyCount() view call returned: $bounty_count"

echo
echo "Checkpoint 4 CLI checks complete."
echo "Start the frontend with:"
echo "  cd frontend && python3 -m http.server 5500"
echo "Then demonstrate: fetch/sort -> Freelancer bid -> Client exact escrow -> submit/approve -> Claim Funds."
