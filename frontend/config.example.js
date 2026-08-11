// Copy this file to config.local.js, then fill in the two placeholders.
// config.local.js is ignored by Git because it contains local secrets.
window.BOUNTYPULSE_CONFIG = Object.freeze({
  CHAIN_ID: 31337,
  CHAIN_ID_HEX: "0x7a69",
  NETWORK_NAME: "Anvil Local",
  RPC_URL: "http://127.0.0.1:8545",

  CONTRACT_ADDRESS: "0xYOUR_DEPLOYED_BOUNTYPULSE_ADDRESS",

  // Local classroom development only. Use a restricted/revocable Pinata JWT.
  // Never commit config.local.js.
  PINATA_JWT: "YOUR_PINATA_JWT",

  IPFS_GATEWAY: "https://gateway.pinata.cloud/ipfs",
  MAX_UPLOAD_BYTES: 10 * 1024 * 1024
});
