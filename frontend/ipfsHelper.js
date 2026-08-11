/* global BOUNTYPULSE_CONFIG */

/**
 * BountyPulse IPFS helper.
 *
 * This follows the reference Voting DApp's two-step pattern:
 *   1. Upload the heavy file to Pinata/IPFS.
 *   2. Return only the CID so app.js can store it in BountyPulse.sol.
 *
 * Checkpoint-only security note:
 * The project manual uses a JWT directly in browser JavaScript. This version
 * keeps it in ignored config.local.js instead of committing it. A production
 * DApp should replace this with a server-created presigned upload URL.
 */
(function attachIpfsHelper(global) {
  "use strict";

  const PIN_FILE_ENDPOINT = "https://api.pinata.cloud/pinning/pinFileToIPFS";
  const TEST_AUTH_ENDPOINT = "https://api.pinata.cloud/data/testAuthentication";

  function getConfig() {
    const config = global.BOUNTYPULSE_CONFIG;
    if (!config) {
      throw new Error(
        "Missing frontend/config.local.js. Copy config.example.js and fill in the values."
      );
    }
    if (!config.PINATA_JWT || config.PINATA_JWT === "YOUR_PINATA_JWT") {
      throw new Error("PINATA_JWT is not configured in frontend/config.local.js.");
    }
    return config;
  }

  function gatewayUrl(cid) {
    const config = getConfig();
    const gateway = String(config.IPFS_GATEWAY || "https://gateway.pinata.cloud/ipfs")
      .replace(/\/+$/, "");
    return `${gateway}/${cid}`;
  }

  function assertFile(file) {
    if (!(file instanceof File)) {
      throw new TypeError("A browser File object is required for IPFS upload.");
    }
    if (file.size === 0) {
      throw new Error("The selected file is empty.");
    }

    const config = getConfig();
    const maxBytes = Number(config.MAX_UPLOAD_BYTES || 10 * 1024 * 1024);
    if (file.size > maxBytes) {
      const maxMiB = (maxBytes / (1024 * 1024)).toFixed(1);
      throw new Error(`File is too large. This demo allows at most ${maxMiB} MiB.`);
    }
  }

  async function parseResponse(response) {
    const bodyText = await response.text();
    let body;

    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = { raw: bodyText };
    }

    if (!response.ok) {
      const message =
        body?.error?.details ||
        body?.error?.reason ||
        body?.error ||
        body?.message ||
        body?.raw ||
        `Pinata request failed with HTTP ${response.status}`;
      throw new Error(String(message));
    }

    return body;
  }

  async function testAuthentication() {
    const { PINATA_JWT } = getConfig();
    const response = await fetch(TEST_AUTH_ENDPOINT, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${PINATA_JWT}`
      }
    });

    return parseResponse(response);
  }

  /**
   * Upload one file to Pinata and request CIDv0.
   * CIDv0 normally starts with Qm and is 46 characters, matching the brief.
   */
  async function uploadFile(file, options = {}) {
    assertFile(file);
    const { PINATA_JWT } = getConfig();

    const pinName = String(options.name || file.name || `bountypulse-${Date.now()}`);
    const keyvalues = {
      application: "BountyPulse",
      checkpoint: "3",
      ...(options.keyvalues || {})
    };

    const formData = new FormData();
    formData.append("file", file);
    formData.append(
      "pinataMetadata",
      JSON.stringify({
        name: pinName,
        keyvalues
      })
    );
    formData.append("pinataOptions", JSON.stringify({ cidVersion: 0 }));

    const response = await fetch(PIN_FILE_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PINATA_JWT}`
      },
      body: formData
    });

    const result = await parseResponse(response);
    const cid = result.IpfsHash;

    if (!cid) {
      throw new Error("Pinata returned success but no IpfsHash/CID was found.");
    }

    return {
      cid,
      gatewayUrl: gatewayUrl(cid),
      pinSize: result.PinSize ?? file.size,
      timestamp: result.Timestamp ?? null,
      isDuplicate: Boolean(result.isDuplicate),
      fileName: file.name,
      mimeType: file.type || "application/octet-stream"
    };
  }

  async function uploadJSON(value, fileName, options = {}) {
    const safeName = fileName.endsWith(".json") ? fileName : `${fileName}.json`;
    const json = JSON.stringify(value, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const file = new File([blob], safeName, { type: "application/json" });

    return uploadFile(file, {
      ...options,
      name: options.name || safeName
    });
  }

  global.IPFSHelper = Object.freeze({
    testAuthentication,
    uploadFile,
    uploadJSON,
    gatewayUrl
  });
})(window);
