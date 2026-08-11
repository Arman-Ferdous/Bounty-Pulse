/* global ethers, IPFSHelper */

(function attachBountyPulseApp(global) {
  "use strict";

  const ROLE = Object.freeze({
    Unregistered: 0,
    Arbiter: 1,
    Client: 2,
    Freelancer: 3
  });

  const ROLE_LABELS = ["Unregistered", "Arbiter", "Client", "Freelancer"];
  const STATUS_LABELS = ["Open", "Locked", "Submitted", "Disputed", "Resolved"];

  // Used only when the generated frontend/BountyPulseABI.json is not present.
  // Checkpoint 2 should still export the complete ABI into that file.
  const MINIMAL_ABI = [
    "function arbiter() view returns (address)",
    "function roleOf(address account) view returns (uint8)",
    "function getUser(address account) view returns (tuple(string name,uint8 role,string ipfsAvatarHash,uint256 reputation,bool isRegistered))",
    "function registerUser(string name,uint8 role,string ipfsAvatarHash)",
    "function postBounty(uint256 maxBudget,string ipfsBountyDetailsHash) returns (uint256 bountyId)",
    "function bountyCount() view returns (uint256)",
    "function getBounty(uint256 bountyId) view returns (tuple(uint256 id,address client,uint256 maxBudget,uint8 status,uint256 selectedBidId,address selectedFreelancer,uint256 agreedAmount,uint256 escrowAmount,uint8 resolution,string ipfsBountyDetailsHash,string ipfsWorkFileHash))",
    "function submitWork(uint256 bountyId,string ipfsWorkFileHash)",
    "event UserRegistered(address indexed account,uint8 indexed role,string name,string ipfsAvatarHash)",
    "event BountyPosted(uint256 indexed bountyId,address indexed client,uint256 maxBudget,string ipfsBountyDetailsHash)",
    "event WorkSubmitted(uint256 indexed bountyId,address indexed freelancer,string ipfsWorkFileHash)"
  ];

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const App = {
    config: null,
    provider: null,
    signer: null,
    contract: null,
    account: null,
    abi: MINIMAL_ABI,
    currentUser: null,
    currentRole: ROLE.Unregistered,
    arbiterAddress: null,
    busy: false,

    async init() {
      this.bindDomEvents();
      this.config = global.BOUNTYPULSE_CONFIG;

      if (!this.config) {
        this.showAlert(
          "danger",
          "Missing config.local.js. Copy config.example.js to config.local.js and fill in the deployed address and Pinata JWT."
        );
        this.setConnectionState("Configuration missing", "danger");
        return;
      }

      this.abi = await this.loadAbi();

      if (!global.ethereum) {
        this.showAlert("danger", "MetaMask is not installed in this browser.");
        this.setConnectionState("MetaMask missing", "danger");
        return;
      }

      this.provider = new ethers.BrowserProvider(global.ethereum);
      this.installWalletListeners();

      try {
        const accounts = await this.provider.send("eth_accounts", []);
        if (accounts.length > 0) {
          await this.connectWithAccount(accounts[0]);
        } else {
          this.setConnectionState("Wallet permission required", "warning");
          this.showAlert(
            "info",
            "MetaMask was detected. Click Connect MetaMask once; future page loads will auto-detect the permitted active account."
          );
        }
      } catch (error) {
        this.handleError(error, "Could not inspect the MetaMask connection");
      }
    },

    bindDomEvents() {
      $("#connectWalletBtn").addEventListener("click", () => this.connectWallet());
      $("#switchNetworkBtn").addEventListener("click", () => this.switchToAnvil());
      $("#testPinataBtn").addEventListener("click", () => this.testPinata());
      $("#registrationForm").addEventListener("submit", (event) => this.register(event));
      $("#postBountyForm").addEventListener("submit", (event) => this.postBounty(event));
      $("#submitWorkForm").addEventListener("submit", (event) => this.submitWork(event));
      $("#clearLogBtn").addEventListener("click", () => {
        $("#activityLog").innerHTML = '<li class="muted">Activity log cleared.</li>';
      });
    },

    installWalletListeners() {
      global.ethereum.on("accountsChanged", async (accounts) => {
        this.log(`MetaMask accountsChanged: ${accounts[0] || "no exposed account"}`);
        if (accounts.length === 0) {
          this.resetWalletState();
          this.setConnectionState("Wallet disconnected", "warning");
          this.showAlert("warning", "MetaMask no longer exposes an account to this DApp.");
          return;
        }
        await this.connectWithAccount(accounts[0]);
      });

      global.ethereum.on("chainChanged", async (chainIdHex) => {
        this.log(`MetaMask chainChanged: ${chainIdHex}`);
        this.provider = new ethers.BrowserProvider(global.ethereum);
        const accounts = await this.provider.send("eth_accounts", []);
        if (accounts.length > 0) {
          await this.connectWithAccount(accounts[0]);
        } else {
          this.resetWalletState();
        }
      });
    },

    async loadAbi() {
      try {
        const response = await fetch("./BountyPulseABI.json", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const abi = await response.json();
        if (!Array.isArray(abi)) throw new Error("ABI JSON is not an array");
        this.log("Loaded complete ABI from BountyPulseABI.json.");
        return abi;
      } catch (error) {
        console.warn("Using minimal Checkpoint 3 ABI:", error);
        this.log("BountyPulseABI.json was not found; using the built-in minimal Checkpoint 3 ABI.");
        return MINIMAL_ABI;
      }
    },

    async connectWallet() {
      if (!global.ethereum) {
        this.showAlert("danger", "MetaMask is not installed.");
        return;
      }

      try {
        const accounts = await global.ethereum.request({ method: "eth_requestAccounts" });
        if (!accounts.length) throw new Error("MetaMask returned no account.");
        await this.connectWithAccount(accounts[0]);
      } catch (error) {
        this.handleError(error, "MetaMask connection failed");
      }
    },

    async connectWithAccount(account) {
      this.setBusy(true, "Reading wallet and Registry…");
      try {
        this.provider = new ethers.BrowserProvider(global.ethereum);
        const network = await this.provider.getNetwork();
        const actualChainId = Number(network.chainId);

        this.updateText("#chainValue", `${network.name || "Custom"} (${actualChainId})`);
        $("#switchNetworkBtn").hidden = actualChainId === Number(this.config.CHAIN_ID);

        if (actualChainId !== Number(this.config.CHAIN_ID)) {
          this.resetContractState();
          this.account = ethers.getAddress(account);
          this.updateWalletHeader();
          this.setConnectionState("Wrong network", "danger");
          this.showAlert(
            "warning",
            `Switch MetaMask to ${this.config.NETWORK_NAME} / Chain ID ${this.config.CHAIN_ID}.`
          );
          return;
        }

        if (!ethers.isAddress(this.config.CONTRACT_ADDRESS)) {
          throw new Error("CONTRACT_ADDRESS in config.local.js is not a valid Ethereum address.");
        }

        this.signer = await this.provider.getSigner();
        this.account = ethers.getAddress(await this.signer.getAddress());

        const code = await this.provider.getCode(this.config.CONTRACT_ADDRESS);
        if (code === "0x") {
          throw new Error(
            "No contract bytecode exists at CONTRACT_ADDRESS on this Anvil instance. Redeploy after every Anvil restart and update config.local.js."
          );
        }

        this.contract = new ethers.Contract(
          this.config.CONTRACT_ADDRESS,
          this.abi,
          this.signer
        );

        this.arbiterAddress = ethers.getAddress(await this.contract.arbiter());
        await this.refreshRegistryView();
        this.updateWalletHeader();
        this.setConnectionState("Connected", "success");
        this.showAlert("success", "MetaMask, Anvil, and BountyPulse are connected.");
      } catch (error) {
        this.resetContractState();
        this.handleError(error, "DApp initialization failed");
        this.setConnectionState("Connection error", "danger");
      } finally {
        this.setBusy(false);
      }
    },

    async refreshRegistryView() {
      if (!this.contract || !this.account) return;

      const [effectiveRoleRaw, user] = await Promise.all([
        this.contract.roleOf(this.account),
        this.contract.getUser(this.account)
      ]);

      this.currentRole = Number(effectiveRoleRaw);
      this.currentUser = {
        name: user.name,
        role: Number(user.role),
        avatarCid: user.ipfsAvatarHash,
        reputation: user.reputation,
        isRegistered: user.isRegistered
      };

      this.renderRoleDashboard();
    },

    renderRoleDashboard() {
      const registered = Boolean(this.currentUser?.isRegistered);
      const roleLabel = ROLE_LABELS[this.currentRole] || `Unknown (${this.currentRole})`;

      this.updateText("#roleValue", registered ? roleLabel : `${roleLabel} — profile not registered`);
      this.updateText("#profileNameValue", registered ? this.currentUser.name : "Not registered");
      this.updateText(
        "#reputationValue",
        this.currentRole === ROLE.Freelancer && registered
          ? this.currentUser.reputation.toString()
          : "Not applicable"
      );

      const avatar = $("#profileAvatar");
      if (registered && this.currentUser.avatarCid) {
        avatar.src = IPFSHelper.gatewayUrl(this.currentUser.avatarCid);
        avatar.alt = `${this.currentUser.name}'s IPFS avatar`;
        avatar.hidden = false;
      } else {
        avatar.removeAttribute("src");
        avatar.hidden = true;
      }

      this.hideAllRolePanels();

      if (!registered) {
        $("#registrationPanel").hidden = false;
        this.configureRegistrationRole();
        return;
      }

      if (this.currentRole === ROLE.Client) {
        $("#clientPanel").hidden = false;
      } else if (this.currentRole === ROLE.Freelancer) {
        $("#freelancerPanel").hidden = false;
      } else if (this.currentRole === ROLE.Arbiter) {
        $("#arbiterPanel").hidden = false;
      }
    },

    configureRegistrationRole() {
      const select = $("#registerRole");
      const isDeployer =
        this.account &&
        this.arbiterAddress &&
        this.account.toLowerCase() === this.arbiterAddress.toLowerCase();

      if (isDeployer) {
        select.innerHTML = '<option value="1">Arbiter</option>';
        select.disabled = true;
        $("#registrationRoleHelp").textContent =
          "The deploying Account 0 is forced to register as Arbiter.";
      } else {
        select.innerHTML = `
          <option value="2">Client</option>
          <option value="3">Freelancer</option>
        `;
        select.disabled = false;
        $("#registrationRoleHelp").textContent =
          "Each non-deployer wallet chooses Client or Freelancer once.";
      }
    },

    async switchToAnvil() {
      try {
        await global.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: this.config.CHAIN_ID_HEX || "0x7a69" }]
        });
      } catch (error) {
        if (error?.code !== 4902) {
          this.handleError(error, "Could not switch network");
          return;
        }

        try {
          await global.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: this.config.CHAIN_ID_HEX || "0x7a69",
                chainName: this.config.NETWORK_NAME || "Anvil Local",
                nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                rpcUrls: [this.config.RPC_URL || "http://127.0.0.1:8545"]
              }
            ]
          });
        } catch (addError) {
          this.handleError(addError, "Could not add the Anvil network");
        }
      }
    },

    async testPinata() {
      this.setBusy(true, "Testing Pinata JWT…");
      try {
        const result = await IPFSHelper.testAuthentication();
        this.log(`Pinata authentication: ${result.message || "success"}`);
        this.showAlert("success", result.message || "Pinata authentication succeeded.");
      } catch (error) {
        this.handleError(error, "Pinata authentication failed");
      } finally {
        this.setBusy(false);
      }
    },

    async register(event) {
      event.preventDefault();
      if (!this.requireReady()) return;

      const name = $("#registerName").value.trim();
      const role = Number($("#registerRole").value);
      const avatarFile = $("#avatarFile").files[0];

      if (!name) return this.showAlert("warning", "Enter a profile name.");
      if (![ROLE.Arbiter, ROLE.Client, ROLE.Freelancer].includes(role)) {
        return this.showAlert("warning", "Choose a valid role.");
      }
      if (!avatarFile) return this.showAlert("warning", "Select an avatar image.");
      if (!avatarFile.type.startsWith("image/")) {
        return this.showAlert("warning", "The avatar must be an image file.");
      }

      this.setBusy(true, "1/4 Uploading avatar to Pinata…");
      try {
        const upload = await IPFSHelper.uploadFile(avatarFile, {
          name: `bountypulse-avatar-${this.shortAddress(this.account)}-${Date.now()}`,
          keyvalues: { kind: "avatar", account: this.account }
        });
        this.showUpload(upload, avatarFile);
        this.log(`Avatar CID received: ${upload.cid}`);

        this.setBusy(true, "2/4 CID received. Waiting for MetaMask signature…");
        const tx = await this.contract.registerUser(name, role, upload.cid);

        this.setBusy(true, `3/4 Mining registration transaction ${this.shortHash(tx.hash)}…`);
        const receipt = await tx.wait();
        if (receipt.status !== 1) throw new Error("Registration transaction was not successful.");

        this.setBusy(true, "4/4 Verifying CID in the on-chain Registry…");
        const stored = await this.contract.getUser(this.account);
        if (stored.ipfsAvatarHash !== upload.cid) {
          throw new Error("Transaction mined, but the on-chain avatar CID does not match.");
        }

        this.log(`Registration mined in block ${receipt.blockNumber}. CID verified on-chain.`);
        this.showAlert(
          "success",
          `Registered successfully. Pinata CID ${upload.cid} is now stored in BountyPulse.sol.`
        );
        event.target.reset();
        await this.refreshRegistryView();
      } catch (error) {
        this.handleError(error, "Registration pipeline failed");
      } finally {
        this.setBusy(false);
      }
    },

    async postBounty(event) {
      event.preventDefault();
      if (!this.requireReady(ROLE.Client)) return;

      const title = $("#bountyTitle").value.trim();
      const description = $("#bountyDescription").value.trim();
      const budgetEth = $("#maxBudgetEth").value.trim();
      const attachmentFile = $("#bountyAttachment").files[0] || null;

      if (!title) return this.showAlert("warning", "Enter a bounty title.");
      if (!description) return this.showAlert("warning", "Enter the bounty description.");
      if (!budgetEth) return this.showAlert("warning", "Enter the maximum budget in ETH.");

      let maxBudgetWei;
      try {
        maxBudgetWei = ethers.parseEther(budgetEth);
        if (maxBudgetWei <= 0n) throw new Error("Budget must be positive.");
      } catch {
        return this.showAlert("warning", "Enter a valid positive ETH amount, for example 1.25.");
      }

      this.setBusy(true, "1/5 Preparing bounty metadata…");
      try {
        let attachment = null;

        if (attachmentFile) {
          this.setBusy(true, "1/5 Uploading bounty attachment to Pinata…");
          const attachmentUpload = await IPFSHelper.uploadFile(attachmentFile, {
            name: `bounty-attachment-${Date.now()}-${attachmentFile.name}`,
            keyvalues: { kind: "bounty-attachment", client: this.account }
          });
          attachment = {
            cid: attachmentUpload.cid,
            fileName: attachmentFile.name,
            mimeType: attachmentFile.type || "application/octet-stream",
            size: attachmentFile.size,
            gatewayUrl: attachmentUpload.gatewayUrl
          };
          this.log(`Attachment CID received: ${attachmentUpload.cid}`);
        }

        const metadata = {
          schema: "bountypulse/bounty-details/v1",
          title,
          description,
          maxBudgetWei: maxBudgetWei.toString(),
          maxBudgetEth: ethers.formatEther(maxBudgetWei),
          client: this.account,
          attachment,
          createdAt: new Date().toISOString()
        };

        this.setBusy(true, "2/5 Uploading bounty-details JSON file to Pinata…");
        const metadataUpload = await IPFSHelper.uploadJSON(
          metadata,
          `bounty-details-${Date.now()}.json`,
          {
            keyvalues: { kind: "bounty-details", client: this.account }
          }
        );
        this.showUpload(metadataUpload, null, metadata);
        this.log(`Bounty metadata CID received: ${metadataUpload.cid}`);

        this.setBusy(true, "3/5 CID received. Waiting for MetaMask signature…");
        const tx = await this.contract.postBounty(maxBudgetWei, metadataUpload.cid);

        this.setBusy(true, `4/5 Mining bounty transaction ${this.shortHash(tx.hash)}…`);
        const receipt = await tx.wait();
        if (receipt.status !== 1) throw new Error("Post-bounty transaction was not successful.");

        const bountyId = this.findEventArgument(receipt, "BountyPosted", "bountyId") ||
          (await this.contract.bountyCount());

        this.setBusy(true, `5/5 Verifying bounty #${bountyId} and CID on-chain…`);
        const stored = await this.contract.getBounty(bountyId);
        if (stored.ipfsBountyDetailsHash !== metadataUpload.cid) {
          throw new Error("Transaction mined, but the on-chain bounty CID does not match.");
        }

        this.log(
          `Bounty #${bountyId} mined in block ${receipt.blockNumber}; metadata CID verified on-chain.`
        );
        this.showAlert(
          "success",
          `Bounty #${bountyId} posted. Its description file is on IPFS and CID ${metadataUpload.cid} is on-chain.`
        );
        event.target.reset();
      } catch (error) {
        this.handleError(error, "Post-bounty metadata pipeline failed");
      } finally {
        this.setBusy(false);
      }
    },

    async submitWork(event) {
      event.preventDefault();
      if (!this.requireReady(ROLE.Freelancer)) return;

      const bountyId = Number($("#workBountyId").value);
      const workFile = $("#workFile").files[0];

      if (!Number.isInteger(bountyId) || bountyId <= 0) {
        return this.showAlert("warning", "Enter a valid positive bounty ID.");
      }
      if (!workFile) return this.showAlert("warning", "Select the work file to submit.");

      this.setBusy(true, `1/5 Checking whether bounty #${bountyId} accepts your work…`);
      try {
        const bounty = await this.contract.getBounty(bountyId);
        const status = Number(bounty.status);

        if (status !== 1) {
          throw new Error(
            `Bounty #${bountyId} is ${STATUS_LABELS[status] || status}, not Locked.`
          );
        }
        if (bounty.selectedFreelancer.toLowerCase() !== this.account.toLowerCase()) {
          throw new Error("The active wallet is not the selected Freelancer for this bounty.");
        }

        this.setBusy(true, "2/5 Uploading submitted work to Pinata…");
        const upload = await IPFSHelper.uploadFile(workFile, {
          name: `bounty-${bountyId}-work-${Date.now()}-${workFile.name}`,
          keyvalues: {
            kind: "submitted-work",
            bountyId: String(bountyId),
            freelancer: this.account
          }
        });
        this.showUpload(upload, workFile);
        this.log(`Work file CID received: ${upload.cid}`);

        this.setBusy(true, "3/5 CID received. Waiting for MetaMask signature…");
        const tx = await this.contract.submitWork(bountyId, upload.cid);

        this.setBusy(true, `4/5 Mining work transaction ${this.shortHash(tx.hash)}…`);
        const receipt = await tx.wait();
        if (receipt.status !== 1) throw new Error("Submit-work transaction was not successful.");

        this.setBusy(true, "5/5 Verifying the work CID on-chain…");
        const stored = await this.contract.getBounty(bountyId);
        if (stored.ipfsWorkFileHash !== upload.cid) {
          throw new Error("Transaction mined, but the on-chain work CID does not match.");
        }

        this.log(`Work CID verified on-chain in block ${receipt.blockNumber}.`);
        this.showAlert(
          "success",
          `Work submitted for bounty #${bountyId}; CID ${upload.cid} is stored on-chain.`
        );
        event.target.reset();
      } catch (error) {
        this.handleError(error, "Work-submission pipeline failed");
      } finally {
        this.setBusy(false);
      }
    },

    findEventArgument(receipt, eventName, argumentName) {
      for (const log of receipt.logs || []) {
        try {
          const parsed = this.contract.interface.parseLog(log);
          if (parsed?.name === eventName) return parsed.args?.[argumentName];
        } catch {
          // Ignore logs from other contracts or unknown interfaces.
        }
      }
      return null;
    },

    showUpload(upload, originalFile = null, jsonValue = null) {
      $("#lastUploadPanel").hidden = false;
      this.updateText("#lastCid", upload.cid);
      this.updateText("#lastFileName", upload.fileName || originalFile?.name || "Generated JSON");
      this.updateText("#lastMimeType", upload.mimeType || originalFile?.type || "application/json");
      this.updateText("#lastCidLength", String(upload.cid.length));

      const link = $("#lastGatewayLink");
      link.href = upload.gatewayUrl;
      link.textContent = upload.gatewayUrl;

      const preview = $("#lastUploadPreview");
      preview.innerHTML = "";

      const mime = upload.mimeType || originalFile?.type || "";
      if (mime.startsWith("image/")) {
        const image = document.createElement("img");
        image.src = upload.gatewayUrl;
        image.alt = "Latest IPFS upload";
        image.className = "gateway-preview-image";
        preview.appendChild(image);
      } else if (mime.startsWith("text/") || mime === "application/json" || jsonValue) {
        const pre = document.createElement("pre");
        pre.textContent = "Loading the pinned content back through the IPFS gateway…";
        preview.appendChild(pre);

        // Read the file back by CID instead of trusting the local pre-upload value.
        // This demonstrates that the gateway can resolve the actual pinned object.
        fetch(upload.gatewayUrl)
          .then((response) => {
            if (!response.ok) throw new Error(`Gateway returned HTTP ${response.status}`);
            return response.text();
          })
          .then((text) => {
            try {
              pre.textContent = JSON.stringify(JSON.parse(text), null, 2);
            } catch {
              pre.textContent = text;
            }
          })
          .catch((error) => {
            pre.textContent =
              `Gateway preview is still propagating or blocked by the browser: ${error.message}\n\n` +
              `Open the gateway link above to verify the CID.`;
          });
      } else {
        const text = document.createElement("p");
        text.className = "muted";
        text.textContent = "Preview is not embedded for this file type. Open the gateway link.";
        preview.appendChild(text);
      }
    },

    requireReady(requiredRole = null) {
      if (this.busy) return false;
      if (!this.contract || !this.signer || !this.account) {
        this.showAlert("warning", "Connect MetaMask to the deployed BountyPulse contract first.");
        return false;
      }
      if (requiredRole !== null && this.currentRole !== requiredRole) {
        this.showAlert(
          "warning",
          `This form requires the ${ROLE_LABELS[requiredRole]} role, but the active wallet is ${ROLE_LABELS[this.currentRole]}.`
        );
        return false;
      }
      return true;
    },

    hideAllRolePanels() {
      ["#registrationPanel", "#clientPanel", "#freelancerPanel", "#arbiterPanel"].forEach(
        (selector) => {
          $(selector).hidden = true;
        }
      );
    },

    resetContractState() {
      this.signer = null;
      this.contract = null;
      this.currentUser = null;
      this.currentRole = ROLE.Unregistered;
      this.arbiterAddress = null;
      this.hideAllRolePanels();
      this.updateText("#roleValue", "Unavailable");
      this.updateText("#profileNameValue", "Unavailable");
      this.updateText("#reputationValue", "Unavailable");
    },

    resetWalletState() {
      this.account = null;
      this.resetContractState();
      this.updateWalletHeader();
    },

    updateWalletHeader() {
      this.updateText("#accountValue", this.account || "Not connected");
      $("#connectWalletBtn").textContent = this.account ? "Reconnect MetaMask" : "Connect MetaMask";
    },

    setConnectionState(text, kind) {
      const badge = $("#connectionBadge");
      badge.textContent = text;
      badge.className = `status-badge status-${kind}`;
    },

    setBusy(isBusy, message = "") {
      this.busy = isBusy;
      $("#busyOverlay").hidden = !isBusy;
      $("#busyMessage").textContent = message || "Working…";
      $$('button[type="submit"], #testPinataBtn').forEach((button) => {
        button.disabled = isBusy;
      });
    },

    showAlert(kind, message) {
      const alert = $("#appAlert");
      alert.className = `app-alert alert-${kind}`;
      alert.textContent = message;
      alert.hidden = false;
    },

    handleError(error, context) {
      const message = this.errorMessage(error);
      console.error(context, error);
      this.log(`${context}: ${message}`, "error");
      this.showAlert("danger", `${context}: ${message}`);
    },

    errorMessage(error) {
      if (!error) return "Unknown error";
      if (error.code === 4001 || error.code === "ACTION_REJECTED") {
        return "The MetaMask request was rejected by the user.";
      }
      return (
        error.shortMessage ||
        error.reason ||
        error.info?.error?.message ||
        error.data?.message ||
        error.message ||
        String(error)
      );
    },

    log(message, kind = "normal") {
      const log = $("#activityLog");
      const item = document.createElement("li");
      item.className = kind === "error" ? "log-error" : "";
      item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
      log.prepend(item);
    },

    updateText(selector, value) {
      $(selector).textContent = value;
    },

    shortAddress(address) {
      return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "unknown";
    },

    shortHash(hash) {
      return hash ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : "unknown";
    }
  };

  global.App = App;
  document.addEventListener("DOMContentLoaded", () => App.init());
})(window);
