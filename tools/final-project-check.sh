#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "============================================================"
echo " BountyPulse final project verification"
echo "============================================================"
echo

for cmd in forge cast node jq python3; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "FAIL: required command '$cmd' is unavailable."; exit 1;
  }
done
echo "PASS: Foundry, Node, jq, and Python tooling are available."

echo
echo "[1/5] Solidity build"
forge build
echo "PASS: forge build"

echo
echo "[2/5] Solidity tests"
forge test
echo "PASS: forge test"

echo
echo "[3/5] Frontend + event sync"
./tools/checkpoint5-check.sh

echo
echo "[4/5] ABI functions"
functions=(
  registerUser postBounty submitBid fundBounty submitWork approveWork
  disputeBounty resolveDispute claimFunds bountyCount getBounty getBid
  withdrawableBalances
)
for fn in "${functions[@]}"; do
  jq -e --arg n "$fn" '.[] | select(.type == "function" and .name == $n)' \
    frontend/BountyPulseABI.json >/dev/null || {
      echo "FAIL: ABI function missing: $fn"; exit 1;
    }
done
echo "PASS: final ABI contains the end-to-end application functions."

echo
echo "[5/5] Secret hygiene + optional Pinata auth"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  [[ ! -f .env ]] || git check-ignore -q .env || { echo "FAIL: .env is not ignored."; exit 1; }
  [[ ! -f frontend/config.local.js ]] || git check-ignore -q frontend/config.local.js || {
    echo "FAIL: frontend/config.local.js is not ignored."; exit 1;
  }

  staged="$(git diff --cached --name-only)"
  if grep -Eq '(^|/)(\.env|config\.local\.js)$' <<<"$staged"; then
    echo "FAIL: a local secret file is staged for commit."
    exit 1
  fi
fi

echo "PASS: local secret files are protected from normal Git commits."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -n "${PINATA_JWT:-}" ]] && command -v curl >/dev/null 2>&1; then
  response="$(curl -fsS --max-time 15 \
    --request GET \
    --url https://api.pinata.cloud/data/testAuthentication \
    --header 'accept: application/json' \
    --header "authorization: Bearer $PINATA_JWT" 2>/dev/null || true)"
  if jq -e '.message | contains("communicating with the Pinata API")' <<<"$response" >/dev/null 2>&1; then
    echo "PASS: Pinata JWT authentication is active."
  else
    echo "WARN: Pinata authentication could not be confirmed now. Browser upload may still be checked manually."
  fi
else
  echo "WARN: Pinata JWT check skipped."
fi

echo
echo "============================================================"
echo " Automated checks passed. Final manual demonstration:"
echo "  1. Open Client + Freelancer in separate browser profiles."
echo "  2. Keep both on the same Anvil contract address."
echo "  3. Reach Submitted status."
echo "  4. Client presses Approve Work."
echo "  5. Freelancer earnings update automatically via WorkApproved."
echo "  6. Freelancer presses Claim Funds; balance returns to 0."
echo "============================================================"
