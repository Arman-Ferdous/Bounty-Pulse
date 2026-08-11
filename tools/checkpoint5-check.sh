#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Checking BountyPulse Checkpoint 5..."
echo

required_files=(
  frontend/index.html
  frontend/app.js
  frontend/ipfsHelper.js
  frontend/styles.css
)

for file in "${required_files[@]}"; do
  [[ -f "$file" ]] || { echo "FAIL: missing $file"; exit 1; }
done
echo "PASS: Checkpoint 5 frontend files exist."

command -v node >/dev/null 2>&1 || { echo "FAIL: node is required for JS syntax checks."; exit 1; }
node --check frontend/app.js
node --check frontend/ipfsHelper.js
echo "PASS: JavaScript syntax checks passed."

python3 - <<'PY'
import re
from pathlib import Path
js = Path('frontend/app.js').read_text()
html = Path('frontend/index.html').read_text()
ids = set(re.findall(r'id="([^"]+)"', html))
refs = set(re.findall(r'\$\("#([A-Za-z0-9_-]+)"\)', js))
missing = sorted(refs - ids)
if missing:
    raise SystemExit('FAIL: app.js references missing DOM IDs: ' + ', '.join(missing))
print('PASS: app.js DOM references exist in index.html.')
PY

grep -q 'await listenedContract.on(eventName, handler)' frontend/app.js || {
  echo "FAIL: Ethers.js contract event listener registration was not found."; exit 1;
}
grep -q 'removeAllListeners' frontend/app.js || {
  echo "FAIL: listener cleanup was not found; reconnects could duplicate callbacks."; exit 1;
}
if grep -q 'window\.location\.reload' frontend/app.js; then
  echo "FAIL: hard page reload found in app.js."
  exit 1
fi
if grep -Eq 'setInterval[[:space:]]*\(' frontend/app.js; then
  echo "FAIL: periodic polling loop found; Checkpoint 5 should be event-driven."
  exit 1
fi
echo "PASS: event-driven sync is present with cleanup and no hard reload/polling loop."

events=(
  UserRegistered
  BountyPosted
  BidSubmitted
  BountyFunded
  WorkSubmitted
  WorkApproved
  BountyDisputed
  DisputeResolved
  FundsClaimed
)

for event_name in "${events[@]}"; do
  grep -q "$event_name" frontend/app.js || {
    echo "FAIL: frontend listener plan is missing $event_name"; exit 1;
  }
done
echo "PASS: all 9 BountyPulse state-change event names are wired into the live-sync plan."

if [[ -f src/BountyPulse.sol ]]; then
  for event_name in "${events[@]}"; do
    grep -q "event $event_name" src/BountyPulse.sol || {
      echo "FAIL: Solidity event declaration missing: $event_name"; exit 1;
    }
    grep -q "emit $event_name" src/BountyPulse.sol || {
      echo "FAIL: Solidity event is never emitted: $event_name"; exit 1;
    }
  done
  echo "PASS: BountyPulse.sol declares and emits all 9 events."
fi

if [[ -f frontend/BountyPulseABI.json ]]; then
  command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required to validate the ABI."; exit 1; }
  jq empty frontend/BountyPulseABI.json
  for event_name in "${events[@]}"; do
    jq -e --arg n "$event_name" '.[] | select(.type == "event" and .name == $n)' \
      frontend/BountyPulseABI.json >/dev/null || {
        echo "FAIL: exported ABI is missing event $event_name"; exit 1;
      }
  done
  echo "PASS: exported ABI contains all live-sync events."
else
  echo "WARN: frontend/BountyPulseABI.json is absent; app.js will use its fallback ABI."
fi

if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [[ -f frontend/config.local.js ]]; then
    git check-ignore -q frontend/config.local.js || {
      echo "FAIL: frontend/config.local.js is not ignored by Git."; exit 1;
    }
  fi
  if [[ -f .env ]]; then
    git check-ignore -q .env || {
      echo "FAIL: .env is not ignored by Git."; exit 1;
    }
  fi
  echo "PASS: local secret configuration is not intended for Git tracking."
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if command -v cast >/dev/null 2>&1 && [[ -n "${ANVIL_RPC_URL:-}" ]]; then
  actual_chain="$(cast chain-id --rpc-url "$ANVIL_RPC_URL" 2>/dev/null || true)"
  [[ "$actual_chain" == "31337" ]] || {
    echo "FAIL: Anvil is not reachable on Chain ID 31337."; exit 1;
  }
  echo "PASS: Anvil is reachable on Chain ID 31337."

  if [[ -n "${BOUNTYPULSE_ADDRESS:-}" ]]; then
    code="$(cast code "$BOUNTYPULSE_ADDRESS" --rpc-url "$ANVIL_RPC_URL" 2>/dev/null || true)"
    [[ -n "$code" && "$code" != "0x" ]] || {
      echo "FAIL: no BountyPulse bytecode exists at $BOUNTYPULSE_ADDRESS"; exit 1;
    }
    echo "PASS: BountyPulse bytecode exists at $BOUNTYPULSE_ADDRESS."
  fi
else
  echo "WARN: live Anvil check skipped (cast/.env RPC unavailable)."
fi

echo
echo "Checkpoint 5 static + chain checks passed."
echo "Manual browser proof still required: keep Client and Freelancer windows open,"
echo "approve work in the Client window, and show Freelancer Unclaimed Earnings"
echo "changing automatically from the WorkApproved event without clicking refresh."
