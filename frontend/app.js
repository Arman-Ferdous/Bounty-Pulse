/* global ethers, IPFSHelper */

(function attachBountyPulseApp(global) {
  "use strict";

  const ROLE = Object.freeze({
    Unregistered: 0,
    Arbiter: 1,
    Client: 2,
    Freelancer: 3
  });

  const STATUS = Object.freeze({
    Open: 0,
    Locked: 1,
    Submitted: 2,
    Disputed: 3,
    Resolved: 4
  });

  const RESOLUTION = Object.freeze({
    None: 0,
    ClientWon: 1,
    FreelancerWon: 2
  });

  const ROLE_LABELS = ["Unregistered", "Arbiter", "Client", "Freelancer"];
  const STATUS_LABELS = ["Open", "Locked", "Submitted", "Disputed", "Resolved"];
  const RESOLUTION_LABELS = ["None", "Client Won", "Freelancer Won"];

  // This fallback keeps the page debuggable if the exported ABI is temporarily missing.
  // The normal project path is still to load frontend/BountyPulseABI.json from Checkpoint 2.
  const MINIMAL_ABI = [
    "function arbiter() view returns (address)",
    "function roleOf(address account) view returns (uint8)",
    "function getUser(address account) view returns (tuple(string name,uint8 role,string ipfsAvatarHash,uint256 reputation,bool isRegistered))",
    "function registerUser(string name,uint8 role,string ipfsAvatarHash)",
    "function postBounty(uint256 maxBudget,string ipfsBountyDetailsHash) returns (uint256 bountyId)",
    "function bountyCount() view returns (uint256)",
    "function getBounty(uint256 bountyId) view returns (tuple(uint256 id,address client,uint256 maxBudget,uint8 status,uint256 selectedBidId,address selectedFreelancer,uint256 agreedAmount,uint256 escrowAmount,uint8 resolution,string ipfsBountyDetailsHash,string ipfsWorkFileHash))",
    "function bidCountByBounty(uint256 bountyId) view returns (uint256)",
    "function getBid(uint256 bountyId,uint256 bidId) view returns (tuple(uint256 id,address freelancer,uint256 amount,bool selected))",
    "function hasBid(uint256 bountyId,address freelancer) view returns (bool)",
    "function submitBid(uint256 bountyId,uint256 bidAmount) returns (uint256 bidId)",
    "function fundBounty(uint256 bountyId,uint256 bidId) payable",
    "function submitWork(uint256 bountyId,string ipfsWorkFileHash)",
    "function approveWork(uint256 bountyId)",
    "function disputeBounty(uint256 bountyId)",
    "function resolveDispute(uint256 bountyId,bool freelancerAtFault)",
    "function withdrawableBalances(address account) view returns (uint256)",
    "function claimFunds()",
    "event UserRegistered(address indexed account,uint8 indexed role,string name,string ipfsAvatarHash)",
    "event BountyPosted(uint256 indexed bountyId,address indexed client,uint256 maxBudget,string ipfsBountyDetailsHash)",
    "event BidSubmitted(uint256 indexed bountyId,uint256 indexed bidId,address indexed freelancer,uint256 amount)",
    "event BountyFunded(uint256 indexed bountyId,uint256 indexed bidId,address indexed freelancer,uint256 escrowAmount,uint256 refundedExcess)",
    "event WorkSubmitted(uint256 indexed bountyId,address indexed freelancer,string ipfsWorkFileHash)",
    "event WorkApproved(uint256 indexed bountyId,address indexed freelancer,uint256 freelancerPayout,uint256 platformFee,uint256 newReputation)",
    "event BountyDisputed(uint256 indexed bountyId,address indexed client)",
    "event DisputeResolved(uint256 indexed bountyId,uint8 indexed resolution,uint256 clientRefund,uint256 freelancerPayout,uint256 platformFee,uint256 freelancerReputation)",
    "event FundsClaimed(address indexed account,uint256 amount)"
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
    feedBusy: false,
    bounties: [],
    profileCache: new Map(),
    metadataCache: new Map(),
    unclaimedBalance: 0n,

    async init() {
      this.bindDomEvents();
      this.config = global.BOUNTYPULSE_CONFIG;

      if (!this.config) {
        this.showAlert(
          "danger",
          "Missing config.local.js. Run tools/generate-frontend-config.sh first."
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
            "MetaMask was detected. Click Connect MetaMask once; the active account will then be detected automatically."
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
      $("#refreshFeedBtn").addEventListener("click", () => this.refreshDashboardData(true));
      $("#sortSelect").addEventListener("change", () => this.renderBountyFeed());
      $("#statusFilter").addEventListener("change", () => this.renderBountyFeed());
      $("#registrationForm").addEventListener("submit", (event) => this.register(event));
      $("#postBountyForm").addEventListener("submit", (event) => this.postBounty(event));
      $("#submitWorkForm").addEventListener("submit", (event) => this.submitWork(event));
      $("#claimFundsBtn").addEventListener("click", () => this.claimFunds());
      $("#bountyFeed").addEventListener("click", (event) => this.handleFeedClick(event));
      $("#bountyFeed").addEventListener("submit", (event) => this.handleFeedSubmit(event));
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

      // Deliberately no contract.on(...) listeners here.
      // Cross-window live synchronization is the boundary for Checkpoint 5.
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
        console.warn("Using minimal Checkpoint 4 ABI:", error);
        this.log("BountyPulseABI.json was not found; using the built-in Checkpoint 4 fallback ABI.");
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
      this.setBusy(true, "Reading wallet, Registry, and marketplace data…");
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
            "No contract bytecode exists at CONTRACT_ADDRESS on this Anvil instance. Redeploy after every Anvil restart and regenerate config.local.js."
          );
        }

        this.contract = new ethers.Contract(
          this.config.CONTRACT_ADDRESS,
          this.abi,
          this.signer
        );

        this.arbiterAddress = ethers.getAddress(await this.contract.arbiter());
        this.profileCache.clear();
        await this.refreshRegistryView();
        await this.refreshDashboardData(false);
        this.updateWalletHeader();
        this.setConnectionState("Connected", "success");
        this.showAlert("success", "MetaMask, Anvil, BountyPulse, and the marketplace feed are connected.");
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
        reputation: BigInt(user.reputation),
        isRegistered: user.isRegistered
      };

      this.profileCache.set(this.account.toLowerCase(), this.currentUser);
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
      $("#earningsPanel").hidden = true;

      if (!registered) {
        $("#registrationPanel").hidden = false;
        this.configureRegistrationRole();
        return;
      }

      if (this.currentRole === ROLE.Client) {
        $("#clientPanel").hidden = false;
      } else if (this.currentRole === ROLE.Freelancer) {
        $("#freelancerPanel").hidden = false;
        $("#earningsPanel").hidden = false;
      } else if (this.currentRole === ROLE.Arbiter) {
        $("#arbiterPanel").hidden = false;
        $("#earningsPanel").hidden = false;
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

    async refreshDashboardData(showMessage = false) {
      if (!this.contract || !this.account || this.feedBusy) return;

      this.feedBusy = true;
      $("#refreshFeedBtn").disabled = true;
      try {
        await Promise.all([
          this.refreshWithdrawableBalance(),
          this.refreshBountyFeed()
        ]);
        if (showMessage) {
          this.showAlert("success", "Marketplace data was fetched again from the smart contract.");
        }
      } catch (error) {
        this.handleError(error, "Could not refresh marketplace data");
      } finally {
        this.feedBusy = false;
        $("#refreshFeedBtn").disabled = false;
      }
    },

    async refreshWithdrawableBalance() {
      if (!this.contract || !this.account) return;

      if (![ROLE.Freelancer, ROLE.Arbiter].includes(this.currentRole)) {
        this.unclaimedBalance = 0n;
        this.updateText("#unclaimedEarnings", "0 ETH");
        $("#claimFundsBtn").disabled = true;
        return;
      }

      const amount = BigInt(await this.contract.withdrawableBalances(this.account));
      this.unclaimedBalance = amount;
      this.updateText("#unclaimedEarnings", `${ethers.formatEther(amount)} ETH`);
      $("#claimFundsBtn").disabled = amount === 0n;
      this.updateText(
        "#earningsWei",
        `${amount.toString()} Wei`
      );
    },

    async refreshBountyFeed() {
      if (!this.contract) return;

      this.updateText("#feedState", "Fetching bounties and bids from BountyPulse.sol…");
      const count = Number(await this.contract.bountyCount());
      this.profileCache.clear();
      if (this.currentUser && this.account) {
        this.profileCache.set(this.account.toLowerCase(), this.currentUser);
      }

      const bountyIds = Array.from({ length: count }, (_, index) => index + 1);
      const loaded = await Promise.all(
        bountyIds.map((bountyId) => this.loadBountyRecord(bountyId))
      );

      this.bounties = loaded;
      this.renderBountyFeed();
      this.log(`Fetched ${loaded.length} bounties and ${loaded.reduce((sum, b) => sum + b.bids.length, 0)} bids using view calls.`);
    },

    async loadBountyRecord(bountyId) {
      const raw = await this.contract.getBounty(bountyId);
      const bidCount = Number(await this.contract.bidCountByBounty(bountyId));
      const bidIds = Array.from({ length: bidCount }, (_, index) => index + 1);

      const [metadata, clientProfile, rawBids] = await Promise.all([
        this.fetchBountyMetadata(raw.ipfsBountyDetailsHash),
        this.loadProfile(raw.client),
        Promise.all(bidIds.map((bidId) => this.contract.getBid(bountyId, bidId)))
      ]);

      const bids = await Promise.all(
        rawBids.map(async (bid) => ({
          id: Number(bid.id),
          freelancer: ethers.getAddress(bid.freelancer),
          amount: BigInt(bid.amount),
          selected: Boolean(bid.selected),
          profile: await this.loadProfile(bid.freelancer)
        }))
      );

      return {
        id: Number(raw.id),
        client: ethers.getAddress(raw.client),
        maxBudget: BigInt(raw.maxBudget),
        status: Number(raw.status),
        selectedBidId: Number(raw.selectedBidId),
        selectedFreelancer: raw.selectedFreelancer,
        agreedAmount: BigInt(raw.agreedAmount),
        escrowAmount: BigInt(raw.escrowAmount),
        resolution: Number(raw.resolution),
        detailsCid: raw.ipfsBountyDetailsHash,
        workCid: raw.ipfsWorkFileHash,
        metadata,
        clientProfile,
        bids
      };
    },

    async loadProfile(address) {
      const normalized = ethers.getAddress(address);
      const key = normalized.toLowerCase();
      if (this.profileCache.has(key)) return this.profileCache.get(key);

      try {
        const user = await this.contract.getUser(normalized);
        const profile = {
          name: user.name || this.shortAddress(normalized),
          role: Number(user.role),
          avatarCid: user.ipfsAvatarHash,
          reputation: BigInt(user.reputation),
          isRegistered: Boolean(user.isRegistered)
        };
        this.profileCache.set(key, profile);
        return profile;
      } catch {
        const fallback = {
          name: this.shortAddress(normalized),
          role: ROLE.Unregistered,
          avatarCid: "",
          reputation: 0n,
          isRegistered: false
        };
        this.profileCache.set(key, fallback);
        return fallback;
      }
    },

    async fetchBountyMetadata(cid) {
      if (!cid) return null;
      if (this.metadataCache.has(cid)) return this.metadataCache.get(cid);

      try {
        const response = await fetch(IPFSHelper.gatewayUrl(cid), { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const metadata = await response.json();
        this.metadataCache.set(cid, metadata);
        return metadata;
      } catch (error) {
        const fallback = {
          title: `Bounty metadata ${cid.slice(0, 10)}…`,
          description: "Metadata could not be rendered through the gateway yet.",
          gatewayError: error.message
        };
        this.metadataCache.set(cid, fallback);
        return fallback;
      }
    },

    renderBountyFeed() {
      const feed = $("#bountyFeed");
      if (!feed) return;

      const filter = $("#statusFilter").value;
      const sortMode = $("#sortSelect").value;
      const visible = this.bounties
        .filter((bounty) => this.matchesStatusFilter(bounty, filter))
        .sort((a, b) => this.compareBounties(a, b, sortMode));

      this.updateText("#feedCount", `${visible.length} shown / ${this.bounties.length} total`);
      this.updateText(
        "#sortGasNote",
        `Sorted ${visible.length} fetched records locally in JavaScript. No blockchain transaction is sent for sorting, so the user's wallet spends no gas on the sort.`
      );

      if (this.bounties.length === 0) {
        feed.innerHTML = `
          <div class="empty-state">
            <strong>No bounties exist yet.</strong>
            <span>Connect a Client account and post the first bounty.</span>
          </div>`;
        this.updateText("#feedState", "Blockchain Registry currently contains 0 bounties.");
        return;
      }

      if (visible.length === 0) {
        feed.innerHTML = `
          <div class="empty-state">
            <strong>No bounties match this status filter.</strong>
            <span>Choose a different filter to inspect the rest of the Registry.</span>
          </div>`;
        this.updateText("#feedState", "The Registry was fetched successfully; the current filter hides all records.");
        return;
      }

      feed.innerHTML = visible.map((bounty) => this.bountyCardHtml(bounty)).join("");
      this.updateText(
        "#feedState",
        `Rendered ${visible.length} bounty records and their submitted bids from contract view data.`
      );
    },

    matchesStatusFilter(bounty, filter) {
      if (filter === "all") return true;
      if (filter === "active") return bounty.status !== STATUS.Resolved;
      return bounty.status === Number(filter);
    },

    compareBounties(a, b, mode) {
      if (mode === "budget-desc") return a.maxBudget === b.maxBudget ? b.id - a.id : (a.maxBudget > b.maxBudget ? -1 : 1);
      if (mode === "budget-asc") return a.maxBudget === b.maxBudget ? a.id - b.id : (a.maxBudget < b.maxBudget ? -1 : 1);
      if (mode === "id-asc") return a.id - b.id;
      return b.id - a.id;
    },

    bountyCardHtml(bounty) {
      const metadata = bounty.metadata || {};
      const title = this.escapeHtml(metadata.title || `Bounty #${bounty.id}`);
      const description = this.escapeHtml(metadata.description || "No rendered description available.");
      const clientName = this.escapeHtml(bounty.clientProfile?.name || this.shortAddress(bounty.client));
      const owner = this.account && bounty.client.toLowerCase() === this.account.toLowerCase();
      const isSelectedFreelancer =
        this.account &&
        bounty.selectedFreelancer &&
        bounty.selectedFreelancer !== ethers.ZeroAddress &&
        bounty.selectedFreelancer.toLowerCase() === this.account.toLowerCase();
      const statusLabel = STATUS_LABELS[bounty.status] || `Status ${bounty.status}`;
      const detailsUrl = this.safeGatewayUrl(bounty.detailsCid);
      const workUrl = bounty.workCid ? this.safeGatewayUrl(bounty.workCid) : "";
      const attachment = metadata.attachment?.cid
        ? `<a href="${this.escapeHtml(this.safeGatewayUrl(metadata.attachment.cid))}" target="_blank" rel="noreferrer">${this.escapeHtml(metadata.attachment.fileName || "IPFS attachment")}</a>`
        : "None";

      let selectedSummary = "";
      if (bounty.status !== STATUS.Open) {
        selectedSummary = `
          <div class="selected-summary">
            <span><strong>Selected bid:</strong> #${bounty.selectedBidId}</span>
            <span><strong>Freelancer:</strong> ${this.escapeHtml(this.shortAddress(bounty.selectedFreelancer))}</span>
            <span><strong>Agreed:</strong> ${this.escapeHtml(ethers.formatEther(bounty.agreedAmount))} ETH</span>
            <span><strong>Escrow now:</strong> ${this.escapeHtml(ethers.formatEther(bounty.escrowAmount))} ETH</span>
          </div>`;
      }

      return `
        <article class="bounty-card" data-bounty-id="${bounty.id}">
          <div class="bounty-card-head">
            <div>
              <p class="bounty-kicker">Bounty #${bounty.id} · ${clientName}</p>
              <h4>${title}</h4>
            </div>
            <span class="bounty-status status-${statusLabel.toLowerCase()}">${this.escapeHtml(statusLabel)}</span>
          </div>

          <p class="bounty-description">${description}</p>

          <div class="metric-grid">
            <div class="metric"><span>Max budget</span><strong>${this.escapeHtml(ethers.formatEther(bounty.maxBudget))} ETH</strong></div>
            <div class="metric"><span>Bids</span><strong>${bounty.bids.length}</strong></div>
            <div class="metric"><span>Client</span><strong>${this.escapeHtml(this.shortAddress(bounty.client))}</strong></div>
            <div class="metric"><span>Resolution</span><strong>${this.escapeHtml(RESOLUTION_LABELS[bounty.resolution] || String(bounty.resolution))}</strong></div>
          </div>

          <div class="resource-links">
            <a href="${this.escapeHtml(detailsUrl)}" target="_blank" rel="noreferrer">Bounty details on IPFS</a>
            <span>Attachment: ${attachment}</span>
            ${workUrl ? `<a href="${this.escapeHtml(workUrl)}" target="_blank" rel="noreferrer">Submitted work on IPFS</a>` : ""}
          </div>

          ${selectedSummary}
          ${this.bidSectionHtml(bounty, owner)}
          ${this.workflowActionsHtml(bounty, owner, isSelectedFreelancer)}
        </article>`;
    },

    bidSectionHtml(bounty, owner) {
      const bidRows = bounty.bids.length
        ? bounty.bids.map((bid) => {
            const rep = bid.profile?.isRegistered ? ` · Rep ${bid.profile.reputation}` : "";
            const selected = bid.selected ? '<span class="mini-chip selected">Selected</span>' : "";
            const fundButton =
              owner && bounty.status === STATUS.Open
                ? `<button class="btn btn-primary btn-small" type="button"
                    data-action="fund" data-bounty-id="${bounty.id}" data-bid-id="${bid.id}" data-amount-wei="${bid.amount}">
                    Pay exact ${this.escapeHtml(ethers.formatEther(bid.amount))} ETH
                  </button>`
                : "";

            return `
              <div class="bid-row">
                <div>
                  <strong>Bid #${bid.id}</strong>
                  ${selected}
                  <div class="bid-person">${this.escapeHtml(bid.profile?.name || this.shortAddress(bid.freelancer))}${this.escapeHtml(rep)}</div>
                  <code>${this.escapeHtml(this.shortAddress(bid.freelancer))}</code>
                </div>
                <div class="bid-price">${this.escapeHtml(ethers.formatEther(bid.amount))} ETH</div>
                <div>${fundButton}</div>
              </div>`;
          }).join("")
        : '<div class="empty-inline">No Freelancer bids submitted yet.</div>';

      let bidForm = "";
      if (this.currentRole === ROLE.Freelancer && bounty.status === STATUS.Open) {
        const currentBid = bounty.bids.find(
          (bid) => this.account && bid.freelancer.toLowerCase() === this.account.toLowerCase()
        );

        if (currentBid) {
          bidForm = `<div class="inline-note">You already bid ${this.escapeHtml(ethers.formatEther(currentBid.amount))} ETH on this bounty.</div>`;
        } else {
          bidForm = `
            <form class="inline-bid-form" data-bounty-id="${bounty.id}" data-max-budget-wei="${bounty.maxBudget}">
              <label for="bid-${bounty.id}">Your quote (ETH)</label>
              <div class="inline-bid-controls">
                <input id="bid-${bounty.id}" name="bidEth" type="number" min="0" step="0.000000000000000001" required placeholder="0.75">
                <button class="btn btn-secondary btn-small" type="submit">Submit Bid</button>
              </div>
              <span class="field-help">Non-payable quote only. Maximum ${this.escapeHtml(ethers.formatEther(bounty.maxBudget))} ETH.</span>
            </form>`;
        }
      }

      return `
        <section class="bid-section">
          <div class="section-mini-head">
            <strong>Submitted bids</strong>
            <span>${bounty.bids.length} on-chain</span>
          </div>
          <div class="bid-list">${bidRows}</div>
          ${bidForm}
        </section>`;
    },

    workflowActionsHtml(bounty, owner, isSelectedFreelancer) {
      const actions = [];

      if (bounty.status === STATUS.Locked && isSelectedFreelancer) {
        actions.push(`
          <button class="btn btn-secondary btn-small" type="button" data-action="prepare-work" data-bounty-id="${bounty.id}">
            Prepare work submission
          </button>`);
      }

      if (bounty.status === STATUS.Submitted && owner && this.currentRole === ROLE.Client) {
        actions.push(`
          <button class="btn btn-primary btn-small" type="button" data-action="approve" data-bounty-id="${bounty.id}">
            Approve work
          </button>`);
        actions.push(`
          <button class="btn btn-danger btn-small" type="button" data-action="dispute" data-bounty-id="${bounty.id}">
            Mark disputed
          </button>`);
      }

      if (bounty.status === STATUS.Disputed && this.currentRole === ROLE.Arbiter) {
        actions.push(`
          <button class="btn btn-danger btn-small" type="button" data-action="resolve-freelancer-fault" data-bounty-id="${bounty.id}">
            Freelancer at fault
          </button>`);
        actions.push(`
          <button class="btn btn-primary btn-small" type="button" data-action="resolve-client-fault" data-bounty-id="${bounty.id}">
            Client at fault
          </button>`);
      }

      if (!actions.length) return "";
      return `<div class="workflow-actions">${actions.join("")}</div>`;
    },

    async handleFeedSubmit(event) {
      const form = event.target.closest(".inline-bid-form");
      if (!form) return;
      event.preventDefault();
      if (!this.requireReady(ROLE.Freelancer)) return;

      const bountyId = Number(form.dataset.bountyId);
      const maxBudgetWei = BigInt(form.dataset.maxBudgetWei);
      const bidEth = new FormData(form).get("bidEth")?.toString().trim();

      let bidWei;
      try {
        bidWei = ethers.parseEther(bidEth || "");
        if (bidWei <= 0n) throw new Error("Bid must be positive");
      } catch {
        return this.showAlert("warning", "Enter a valid positive bid amount in ETH.");
      }

      if (bidWei > maxBudgetWei) {
        return this.showAlert(
          "warning",
          `The quote exceeds the Client's maximum budget of ${ethers.formatEther(maxBudgetWei)} ETH.`
        );
      }

      await this.submitBid(bountyId, bidWei, form);
    },

    async handleFeedClick(event) {
      const button = event.target.closest("button[data-action]");
      if (!button) return;

      const action = button.dataset.action;
      const bountyId = Number(button.dataset.bountyId);

      if (action === "fund") {
        const bidId = Number(button.dataset.bidId);
        const amountWei = BigInt(button.dataset.amountWei);
        await this.fundBounty(bountyId, bidId, amountWei);
      } else if (action === "prepare-work") {
        $("#workBountyId").value = String(bountyId);
        $("#freelancerPanel").scrollIntoView({ behavior: "smooth", block: "start" });
      } else if (action === "approve") {
        await this.approveWork(bountyId);
      } else if (action === "dispute") {
        await this.disputeBounty(bountyId);
      } else if (action === "resolve-freelancer-fault") {
        await this.resolveDispute(bountyId, true);
      } else if (action === "resolve-client-fault") {
        await this.resolveDispute(bountyId, false);
      }
    },

    async submitBid(bountyId, bidWei, form = null) {
      if (!this.requireReady(ROLE.Freelancer)) return;
      this.setBusy(true, `Submitting ${ethers.formatEther(bidWei)} ETH quote for bounty #${bountyId}…`);

      try {
        const tx = await this.contract.submitBid(bountyId, bidWei);
        const receipt = await tx.wait();
        if (receipt.status !== 1) throw new Error("Bid transaction was not successful.");

        const bidId = this.findEventArgument(receipt, "BidSubmitted", "bidId");
        this.log(`Bid ${bidId ? `#${bidId}` : ""} submitted for bounty #${bountyId}. No ETH value was sent.`);
        this.showAlert("success", `Bid submitted for bounty #${bountyId}. This was a non-payable quote.`);
        if (form) form.reset();
        await this.refreshBountyFeed();
      } catch (error) {
        this.handleError(error, "Bid submission failed");
      } finally {
        this.setBusy(false);
      }
    },

    async fundBounty(bountyId, bidId, amountWei) {
      if (!this.requireReady(ROLE.Client)) return;

      const bounty = this.bounties.find((item) => item.id === bountyId);
      const bid = bounty?.bids.find((item) => item.id === bidId);
      if (!bounty || !bid) {
        return this.showAlert("warning", "Refresh the feed before funding this bid.");
      }
      if (bounty.client.toLowerCase() !== this.account.toLowerCase()) {
        return this.showAlert("warning", "Only the Client who posted this bounty can fund it.");
      }
      if (bid.amount !== amountWei) {
        return this.showAlert("danger", "The displayed bid amount changed. Refresh the feed before paying.");
      }

      this.setBusy(
        true,
        `Waiting for MetaMask: fund bounty #${bountyId} with exact bid value ${ethers.formatEther(amountWei)} ETH…`
      );

      try {
        // Checkpoint 4 exact-match escrow: value is taken directly from the selected on-chain bid.
        const tx = await this.contract.fundBounty(bountyId, bidId, { value: amountWei });
        this.log(`Escrow transaction sent with value=${amountWei} Wei exactly.`);

        this.setBusy(true, `Mining escrow transaction ${this.shortHash(tx.hash)}…`);
        const receipt = await tx.wait();
        if (receipt.status !== 1) throw new Error("Escrow transaction was not successful.");

        const stored = await this.contract.getBounty(bountyId);
        const storedEscrow = BigInt(stored.escrowAmount);
        const storedStatus = Number(stored.status);

        if (storedEscrow !== amountWei || storedStatus !== STATUS.Locked) {
          throw new Error(
            `Escrow verification failed. Expected ${amountWei} Wei and Locked status; got ${storedEscrow} Wei and status ${storedStatus}.`
          );
        }

        this.log(
          `Bounty #${bountyId} locked. Contract escrowAmount=${storedEscrow} Wei, exactly matching bid #${bidId}.`
        );
        this.showAlert(
          "success",
          `Exact escrow successful: ${ethers.formatEther(amountWei)} ETH was locked for bounty #${bountyId}.`
        );
        await this.refreshBountyFeed();
      } catch (error) {
        this.handleError(error, "Exact-match escrow payment failed");
      } finally {
        this.setBusy(false);
      }
    },

    async approveWork(bountyId) {
      if (!this.requireReady(ROLE.Client)) return;
      this.setBusy(true, `Approving work for bounty #${bountyId}…`);

      try {
        const tx = await this.contract.approveWork(bountyId);
        const receipt = await tx.wait();
        if (receipt.status !== 1) throw new Error("Approve-work transaction was not successful.");

        const payout = this.findEventArgument(receipt, "WorkApproved", "freelancerPayout");
        const fee = this.findEventArgument(receipt, "WorkApproved", "platformFee");
        this.log(
          `Work approved for bounty #${bountyId}; credited ${payout ?? "?"} Wei to Freelancer and ${fee ?? "?"} Wei to Arbiter pull-payment balances.`
        );
        this.showAlert(
          "success",
          "Work approved. The 98% Freelancer payout and 2% Arbiter fee are now withdrawable balances, not automatic transfers."
        );
        await Promise.all([this.refreshBountyFeed(), this.refreshWithdrawableBalance(), this.refreshRegistryView()]);
      } catch (error) {
        this.handleError(error, "Work approval failed");
      } finally {
        this.setBusy(false);
      }
    },

    async disputeBounty(bountyId) {
      if (!this.requireReady(ROLE.Client)) return;
      this.setBusy(true, `Marking bounty #${bountyId} as disputed…`);

      try {
        const tx = await this.contract.disputeBounty(bountyId);
        const receipt = await tx.wait();
        if (receipt.status !== 1) throw new Error("Dispute transaction was not successful.");
        this.log(`Bounty #${bountyId} moved to Disputed.`);
        this.showAlert("success", `Bounty #${bountyId} is now Disputed and awaits the Arbiter.`);
        await this.refreshBountyFeed();
      } catch (error) {
        this.handleError(error, "Dispute transaction failed");
      } finally {
        this.setBusy(false);
      }
    },

    async resolveDispute(bountyId, freelancerAtFault) {
      if (!this.requireReady(ROLE.Arbiter)) return;
      this.setBusy(true, `Resolving dispute for bounty #${bountyId}…`);

      try {
        const tx = await this.contract.resolveDispute(bountyId, freelancerAtFault);
        const receipt = await tx.wait();
        if (receipt.status !== 1) throw new Error("Dispute-resolution transaction was not successful.");
        this.log(
          `Bounty #${bountyId} resolved: ${freelancerAtFault ? "Freelancer fault / Client refund" : "Client fault / Freelancer pull-payment"}.`
        );
        this.showAlert("success", `Dispute for bounty #${bountyId} was resolved.`);
        await Promise.all([this.refreshBountyFeed(), this.refreshWithdrawableBalance(), this.refreshRegistryView()]);
      } catch (error) {
        this.handleError(error, "Dispute resolution failed");
      } finally {
        this.setBusy(false);
      }
    },

    async claimFunds() {
      if (!this.requireReady()) return;
      if (![ROLE.Freelancer, ROLE.Arbiter].includes(this.currentRole)) {
        return this.showAlert("warning", "Only a Freelancer or Arbiter can use Claim Funds.");
      }
      if (this.unclaimedBalance === 0n) {
        return this.showAlert("warning", "There is no withdrawable balance to claim.");
      }

      const before = this.unclaimedBalance;
      this.setBusy(true, `Claiming ${ethers.formatEther(before)} ETH from the pull-payment balance…`);

      try {
        const tx = await this.contract.claimFunds();
        const receipt = await tx.wait();
        if (receipt.status !== 1) throw new Error("Claim transaction was not successful.");

        const claimed = this.findEventArgument(receipt, "FundsClaimed", "amount") ?? before;
        const after = BigInt(await this.contract.withdrawableBalances(this.account));
        if (after !== 0n) {
          throw new Error(`Claim mined, but withdrawable balance is still ${after} Wei.`);
        }

        this.log(`Claimed ${claimed.toString()} Wei. On-chain withdrawable balance verified as 0 Wei.`);
        this.showAlert(
          "success",
          `Claim Funds succeeded. ${ethers.formatEther(BigInt(claimed))} ETH was withdrawn to the active MetaMask account.`
        );
        await this.refreshWithdrawableBalance();
      } catch (error) {
        this.handleError(error, "Claim Funds failed");
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
        await this.refreshDashboardData(false);
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

        this.metadataCache.set(metadataUpload.cid, metadata);
        this.log(
          `Bounty #${bountyId} mined in block ${receipt.blockNumber}; metadata CID verified on-chain.`
        );
        this.showAlert(
          "success",
          `Bounty #${bountyId} posted. Its description is on IPFS and the CID is on-chain.`
        );
        event.target.reset();
        await this.refreshBountyFeed();
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

        if (status !== STATUS.Locked) {
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
          `Work submitted for bounty #${bountyId}; its CID is stored on-chain.`
        );
        event.target.reset();
        await this.refreshBountyFeed();
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
              "Open the gateway link above to verify the CID.";
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
          `This action requires the ${ROLE_LABELS[requiredRole]} role, but the active wallet is ${ROLE_LABELS[this.currentRole]}.`
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
      this.bounties = [];
      this.unclaimedBalance = 0n;
      this.hideAllRolePanels();
      $("#earningsPanel").hidden = true;
      $("#bountyFeed").innerHTML = '<div class="empty-state"><strong>Connect MetaMask</strong><span>The feed is loaded from the contract after connection.</span></div>';
      this.updateText("#roleValue", "Unavailable");
      this.updateText("#profileNameValue", "Unavailable");
      this.updateText("#reputationValue", "Unavailable");
      this.updateText("#unclaimedEarnings", "0 ETH");
      this.updateText("#earningsWei", "0 Wei");
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
      $$('button[type="submit"], #testPinataBtn, button[data-action], #claimFundsBtn').forEach((button) => {
        button.disabled = isBusy || (button.id === "claimFundsBtn" && this.unclaimedBalance === 0n);
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
      const node = $(selector);
      if (node) node.textContent = value;
    },

    shortAddress(address) {
      return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "unknown";
    },

    shortHash(hash) {
      return hash ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : "unknown";
    },

    safeGatewayUrl(cid) {
      try {
        return IPFSHelper.gatewayUrl(cid);
      } catch {
        const gateway = String(this.config?.IPFS_GATEWAY || "https://gateway.pinata.cloud/ipfs").replace(/\/+$/, "");
        return `${gateway}/${cid}`;
      }
    },

    escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }
  };

  global.App = App;
  document.addEventListener("DOMContentLoaded", () => App.init());
})(window);
