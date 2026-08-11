#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }

[[ -f frontend/index.html ]] || fail "frontend/index.html is missing"
[[ -f frontend/app.js ]] || fail "frontend/app.js is missing"
[[ -f frontend/ipfsHelper.js ]] || fail "frontend/ipfsHelper.js is missing"
[[ -f frontend/config.local.js ]] || fail "Run ./tools/generate-frontend-config.sh"
pass "Checkpoint 3 frontend files exist"

if command -v node >/dev/null 2>&1; then
  node --check frontend/app.js >/dev/null
  node --check frontend/ipfsHelper.js >/dev/null
  node --check frontend/config.local.js >/dev/null
  pass "JavaScript syntax checks passed"
else
  echo "WARN: Node.js is unavailable, so JavaScript syntax checks were skipped."
fi

if git check-ignore frontend/config.local.js >/dev/null 2>&1; then
  pass "frontend/config.local.js is ignored by Git"
else
  fail "frontend/config.local.js is not ignored by Git"
fi

if [[ -f out/BountyPulse.sol/BountyPulse.json ]]; then
  jq '.abi' out/BountyPulse.sol/BountyPulse.json > frontend/BountyPulseABI.json
  jq empty frontend/BountyPulseABI.json
  pass "Exported full ABI to frontend/BountyPulseABI.json"
else
  echo "WARN: Foundry artifact not found; run forge build, then export the ABI."
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

RPC_URL="${ANVIL_RPC_URL:-http://127.0.0.1:8545}"
ADDRESS="${BOUNTYPULSE_ADDRESS:-}"

if command -v cast >/dev/null 2>&1 && [[ -n "$ADDRESS" ]]; then
  chain_id="$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null || true)"
  [[ "$chain_id" == "31337" ]] || fail "Anvil is not reachable on Chain ID 31337"
  code="$(cast code "$ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null || true)"
  [[ -n "$code" && "$code" != "0x" ]] || fail "No BountyPulse bytecode at $ADDRESS"
  pass "Anvil and deployed BountyPulse contract are reachable"
else
  echo "WARN: Skipped live chain check because cast or BOUNTYPULSE_ADDRESS is unavailable."
fi

echo
echo "CLI checks complete. Start the server and verify MetaMask + Pinata in the browser:"
echo "  cd frontend && python3 -m http.server 5500"
