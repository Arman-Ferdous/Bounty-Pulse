// Safe template only. Do not place a real Pinata JWT in a committed file.
window.BOUNTYPULSE_CONFIG = Object.freeze({
  CHAIN_ID: 31337,
  CHAIN_ID_HEX: "0x7a69",
  NETWORK_NAME: "Anvil Local",
  RPC_URL: "http://127.0.0.1:8545",
  CONTRACT_ADDRESS: "0xYOUR_DEPLOYED_BOUNTYPULSE_ADDRESS",
  PINATA_JWT: "YOUR_RESTRICTED_TEMPORARY_PINATA_JWT",
  IPFS_GATEWAY: "https://gateway.pinata.cloud/ipfs",
  MAX_UPLOAD_BYTES: 10 * 1024 * 1024
});
