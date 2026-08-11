#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
OUTPUT_FILE="$ROOT_DIR/frontend/config.local.js"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE does not exist."
  echo "Create it from .env.example and add BOUNTYPULSE_ADDRESS and PINATA_JWT."
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${BOUNTYPULSE_ADDRESS:?Missing BOUNTYPULSE_ADDRESS in .env}"
: "${PINATA_JWT:?Missing PINATA_JWT in .env}"

ANVIL_RPC_URL="${ANVIL_RPC_URL:-http://127.0.0.1:8545}"
ANVIL_CHAIN_ID="${ANVIL_CHAIN_ID:-31337}"
IPFS_GATEWAY="${IPFS_GATEWAY:-https://gateway.pinata.cloud/ipfs}"

if [[ "$ANVIL_CHAIN_ID" != "31337" ]]; then
  echo "ERROR: BountyPulse expects Anvil Chain ID 31337, got $ANVIL_CHAIN_ID."
  exit 1
fi

cat > "$OUTPUT_FILE" <<CONFIG
// Generated from the root .env by tools/generate-frontend-config.sh.
// LOCAL DEVELOPMENT ONLY. This file is ignored by frontend/.gitignore.
window.BOUNTYPULSE_CONFIG = Object.freeze({
  CHAIN_ID: 31337,
  CHAIN_ID_HEX: "0x7a69",
  NETWORK_NAME: "Anvil Local",
  RPC_URL: "$ANVIL_RPC_URL",
  CONTRACT_ADDRESS: "$BOUNTYPULSE_ADDRESS",
  PINATA_JWT: "$PINATA_JWT",
  IPFS_GATEWAY: "$IPFS_GATEWAY",
  MAX_UPLOAD_BYTES: 10 * 1024 * 1024
});
CONFIG

chmod 600 "$OUTPUT_FILE"
echo "Generated $OUTPUT_FILE"
echo "WARNING: It contains a browser-readable JWT. Do not commit it; revoke the key after the local demo."
