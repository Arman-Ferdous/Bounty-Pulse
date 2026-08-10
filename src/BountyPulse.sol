// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title BountyPulse
/// @notice A decentralized micro-bounty platform with escrow, bidding,
///         IPFS CIDs, reputation, dispute resolution, and pull payments.
contract BountyPulse {
    // ---------------------------------------------------------------------
    // Enums
    // ---------------------------------------------------------------------

    enum Role {
        Unregistered,
        Arbiter,
        Client,
        Freelancer
    }

    enum BountyStatus {
        Open,
        Locked,
        Submitted,
        Disputed,
        Resolved
    }

    enum Resolution {
        None,
        ClientWon,
        FreelancerWon
    }

    // ---------------------------------------------------------------------
    // Structs
    // ---------------------------------------------------------------------

    struct User {
        string name;
        Role role;
        string ipfsAvatarHash;
        uint256 reputation;
        bool isRegistered;
    }

    struct Bounty {
        uint256 id;
        address client;
        uint256 maxBudget;
        BountyStatus status;
        uint256 selectedBidId;
        address selectedFreelancer;
        uint256 agreedAmount;
        uint256 escrowAmount;
        Resolution resolution;
        string ipfsBountyDetailsHash;
        string ipfsWorkFileHash;
    }

    struct Bid {
        uint256 id;
        address freelancer;
        uint256 amount;
        bool selected;
    }

    // ---------------------------------------------------------------------
    // Constants and state
    // ---------------------------------------------------------------------

    uint256 public constant INITIAL_REPUTATION = 100;
    uint256 public constant MINIMUM_BID_REPUTATION = 40;
    uint256 public constant APPROVAL_REPUTATION_BONUS = 15;
    uint256 public constant DISPUTE_REPUTATION_PENALTY = 30;
    uint256 public constant PLATFORM_FEE_PERCENT = 2;
    uint256 public constant PERCENT_DENOMINATOR = 100;

    address public immutable arbiter;

    uint256 public bountyCount;

    mapping(address => User) public users;
    mapping(uint256 => Bounty) public bounties;

    // bountyId => number of bids submitted for that bounty
    mapping(uint256 => uint256) public bidCountByBounty;

    // bountyId => bidId => Bid
    mapping(uint256 => mapping(uint256 => Bid)) public bids;

    // bountyId => freelancer => whether the freelancer already bid
    mapping(uint256 => mapping(address => bool)) public hasBid;

    // Pull-payment ledger for Freelancer and Arbiter earnings.
    mapping(address => uint256) public withdrawableBalances;

    address[] private registeredUserAddresses;

    // 1 = unlocked, 2 = locked
    uint256 private reentrancyStatus = 1;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event UserRegistered(address indexed account, Role indexed role, string name, string ipfsAvatarHash);

    event BountyPosted(
        uint256 indexed bountyId, address indexed client, uint256 maxBudget, string ipfsBountyDetailsHash
    );

    event BidSubmitted(uint256 indexed bountyId, uint256 indexed bidId, address indexed freelancer, uint256 amount);

    event BountyFunded(
        uint256 indexed bountyId,
        uint256 indexed bidId,
        address indexed freelancer,
        uint256 escrowAmount,
        uint256 refundedExcess
    );

    event WorkSubmitted(uint256 indexed bountyId, address indexed freelancer, string ipfsWorkFileHash);

    event WorkApproved(
        uint256 indexed bountyId,
        address indexed freelancer,
        uint256 freelancerPayout,
        uint256 platformFee,
        uint256 newReputation
    );

    event BountyDisputed(uint256 indexed bountyId, address indexed client);

    event DisputeResolved(
        uint256 indexed bountyId,
        Resolution indexed resolution,
        uint256 clientRefund,
        uint256 freelancerPayout,
        uint256 platformFee,
        uint256 freelancerReputation
    );

    event FundsClaimed(address indexed account, uint256 amount);

    // ---------------------------------------------------------------------
    // Custom errors
    // ---------------------------------------------------------------------

    error OnlyArbiter();
    error AlreadyRegistered();
    error NotRegistered();
    error InvalidRole();
    error UnauthorizedRole(Role requiredRole, Role actualRole);
    error EmptyField();
    error InvalidAmount();
    error BountyNotFound(uint256 bountyId);
    error BidNotFound(uint256 bountyId, uint256 bidId);
    error NotBountyClient();
    error NotSelectedFreelancer();
    error InvalidBountyStatus(BountyStatus requiredStatus, BountyStatus actualStatus);
    error BidExceedsBudget(uint256 bidAmount, uint256 maxBudget);
    error ReputationTooLow(uint256 currentReputation, uint256 requiredReputation);
    error AlreadyBidOnBounty();
    error InsufficientEscrow(uint256 requiredAmount, uint256 suppliedAmount);
    error EtherTransferFailed();
    error NoFundsToClaim();
    error NotEligibleToClaim();
    error ReentrantCall();
    error DirectEtherNotAccepted();

    // ---------------------------------------------------------------------
    // Constructor and modifiers
    // ---------------------------------------------------------------------

    constructor() {
        // Following the reference Voting contract's admin pattern, the
        // deploying account becomes BountyPulse's privileged Arbiter.
        arbiter = msg.sender;
    }

    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert OnlyArbiter();
        _;
    }

    modifier onlyRole(Role requiredRole) {
        User storage user = users[msg.sender];

        if (!user.isRegistered) revert NotRegistered();
        if (user.role != requiredRole) {
            revert UnauthorizedRole(requiredRole, user.role);
        }

        _;
    }

    modifier nonReentrant() {
        if (reentrancyStatus != 1) revert ReentrantCall();
        reentrancyStatus = 2;
        _;
        reentrancyStatus = 1;
    }

    // ---------------------------------------------------------------------
    // Registry
    // ---------------------------------------------------------------------

    /// @notice Register the caller's on-chain profile.
    /// @dev The deployer must choose Arbiter; all other accounts must choose
    ///      either Client or Freelancer.
    function registerUser(string calldata name, Role role, string calldata ipfsAvatarHash) external {
        if (users[msg.sender].isRegistered) revert AlreadyRegistered();

        if (msg.sender == arbiter) {
            if (role != Role.Arbiter) revert InvalidRole();
        } else if (role != Role.Client && role != Role.Freelancer) {
            revert InvalidRole();
        }

        if (bytes(name).length == 0 || bytes(ipfsAvatarHash).length == 0) {
            revert EmptyField();
        }

        uint256 startingReputation = role == Role.Freelancer ? INITIAL_REPUTATION : 0;

        users[msg.sender] = User({
            name: name, role: role, ipfsAvatarHash: ipfsAvatarHash, reputation: startingReputation, isRegistered: true
        });

        registeredUserAddresses.push(msg.sender);

        emit UserRegistered(msg.sender, role, name, ipfsAvatarHash);
    }

    /// @notice Returns the effective role used by the role-based frontend.
    /// @dev The deployer is recognized as Arbiter even before creating a profile.
    function roleOf(address account) external view returns (Role) {
        if (account == arbiter) return Role.Arbiter;
        return users[account].role;
    }

    // ---------------------------------------------------------------------
    // Bounty and bid workflow
    // ---------------------------------------------------------------------

    /// @notice A registered Client posts an Open bounty.
    function postBounty(uint256 maxBudget, string calldata ipfsBountyDetailsHash)
        external
        onlyRole(Role.Client)
        returns (uint256 bountyId)
    {
        if (maxBudget == 0) revert InvalidAmount();
        if (bytes(ipfsBountyDetailsHash).length == 0) revert EmptyField();

        bountyId = ++bountyCount;

        bounties[bountyId] = Bounty({
            id: bountyId,
            client: msg.sender,
            maxBudget: maxBudget,
            status: BountyStatus.Open,
            selectedBidId: 0,
            selectedFreelancer: address(0),
            agreedAmount: 0,
            escrowAmount: 0,
            resolution: Resolution.None,
            ipfsBountyDetailsHash: ipfsBountyDetailsHash,
            ipfsWorkFileHash: ""
        });

        emit BountyPosted(bountyId, msg.sender, maxBudget, ipfsBountyDetailsHash);
    }

    /// @notice A registered Freelancer proposes a non-payable price quote.
    function submitBid(uint256 bountyId, uint256 bidAmount) external onlyRole(Role.Freelancer) returns (uint256 bidId) {
        Bounty storage bounty = _requireBounty(bountyId);
        _requireStatus(bounty, BountyStatus.Open);

        if (bidAmount == 0) revert InvalidAmount();
        if (bidAmount > bounty.maxBudget) {
            revert BidExceedsBudget(bidAmount, bounty.maxBudget);
        }

        uint256 reputation = users[msg.sender].reputation;
        if (reputation < MINIMUM_BID_REPUTATION) {
            revert ReputationTooLow(reputation, MINIMUM_BID_REPUTATION);
        }

        // The specification does not explicitly discuss duplicate bids.
        // This design keeps one active quote per freelancer per bounty.
        if (hasBid[bountyId][msg.sender]) revert AlreadyBidOnBounty();

        bidId = ++bidCountByBounty[bountyId];

        bids[bountyId][bidId] = Bid({id: bidId, freelancer: msg.sender, amount: bidAmount, selected: false});

        hasBid[bountyId][msg.sender] = true;

        emit BidSubmitted(bountyId, bidId, msg.sender, bidAmount);
    }

    /// @notice The bounty owner selects a bid and locks exactly that amount.
    /// @dev Underpayment reverts. Overpayment is refunded in this transaction.
    function fundBounty(uint256 bountyId, uint256 bidId) external payable onlyRole(Role.Client) nonReentrant {
        Bounty storage bounty = _requireBounty(bountyId);
        _requireStatus(bounty, BountyStatus.Open);

        if (bounty.client != msg.sender) revert NotBountyClient();

        Bid storage selectedBid = _requireBid(bountyId, bidId);
        uint256 requiredAmount = selectedBid.amount;

        if (msg.value < requiredAmount) {
            revert InsufficientEscrow(requiredAmount, msg.value);
        }

        // Effects: lock the winning bid before making the external refund call.
        bounty.status = BountyStatus.Locked;
        bounty.selectedBidId = bidId;
        bounty.selectedFreelancer = selectedBid.freelancer;
        bounty.agreedAmount = requiredAmount;
        bounty.escrowAmount = requiredAmount;
        selectedBid.selected = true;

        uint256 excess = msg.value - requiredAmount;

        emit BountyFunded(bountyId, bidId, selectedBid.freelancer, requiredAmount, excess);

        // Interaction comes last. A failed excess refund reverts everything.
        if (excess > 0) {
            _sendEther(payable(msg.sender), excess);
        }
    }

    /// @notice The selected Freelancer stores the submitted work's IPFS CID.
    function submitWork(uint256 bountyId, string calldata ipfsWorkFileHash) external onlyRole(Role.Freelancer) {
        Bounty storage bounty = _requireBounty(bountyId);
        _requireStatus(bounty, BountyStatus.Locked);

        if (bounty.selectedFreelancer != msg.sender) {
            revert NotSelectedFreelancer();
        }
        if (bytes(ipfsWorkFileHash).length == 0) revert EmptyField();

        bounty.ipfsWorkFileHash = ipfsWorkFileHash;
        bounty.status = BountyStatus.Submitted;

        emit WorkSubmitted(bountyId, msg.sender, ipfsWorkFileHash);
    }

    /// @notice The Client approves work and credits 98%/2% pull payments.
    function approveWork(uint256 bountyId) external onlyRole(Role.Client) {
        Bounty storage bounty = _requireBounty(bountyId);
        _requireStatus(bounty, BountyStatus.Submitted);

        if (bounty.client != msg.sender) revert NotBountyClient();

        uint256 escrowedAmount = bounty.escrowAmount;
        uint256 platformFee = calculatePlatformFee(escrowedAmount);
        uint256 freelancerPayout = escrowedAmount - platformFee;

        // Effects only: nobody is paid automatically here.
        bounty.escrowAmount = 0;
        bounty.status = BountyStatus.Resolved;
        bounty.resolution = Resolution.FreelancerWon;

        withdrawableBalances[arbiter] += platformFee;
        withdrawableBalances[bounty.selectedFreelancer] += freelancerPayout;

        User storage freelancer = users[bounty.selectedFreelancer];
        freelancer.reputation += APPROVAL_REPUTATION_BONUS;

        emit WorkApproved(bountyId, bounty.selectedFreelancer, freelancerPayout, platformFee, freelancer.reputation);
    }

    /// @notice The Client disputes submitted work.
    function disputeBounty(uint256 bountyId) external onlyRole(Role.Client) {
        Bounty storage bounty = _requireBounty(bountyId);
        _requireStatus(bounty, BountyStatus.Submitted);

        if (bounty.client != msg.sender) revert NotBountyClient();

        bounty.status = BountyStatus.Disputed;

        emit BountyDisputed(bountyId, msg.sender);
    }

    /// @notice The Arbiter resolves a dispute.
    /// @param freelancerAtFault true => refund Client and penalize Freelancer.
    ///                          false => credit Freelancer minus 2% fee.
    function resolveDispute(uint256 bountyId, bool freelancerAtFault) external onlyArbiter nonReentrant {
        Bounty storage bounty = _requireBounty(bountyId);
        _requireStatus(bounty, BountyStatus.Disputed);

        uint256 escrowedAmount = bounty.escrowAmount;
        User storage freelancer = users[bounty.selectedFreelancer];

        // Shared effects happen before any possible external call.
        bounty.escrowAmount = 0;
        bounty.status = BountyStatus.Resolved;

        if (freelancerAtFault) {
            bounty.resolution = Resolution.ClientWon;

            uint256 oldReputation = freelancer.reputation;
            freelancer.reputation =
                oldReputation > DISPUTE_REPUTATION_PENALTY ? oldReputation - DISPUTE_REPUTATION_PENALTY : 0;

            emit DisputeResolved(bountyId, Resolution.ClientWon, escrowedAmount, 0, 0, freelancer.reputation);

            // The specification explicitly requires a 100% Client refund.
            _sendEther(payable(bounty.client), escrowedAmount);
        } else {
            bounty.resolution = Resolution.FreelancerWon;

            uint256 platformFee = calculatePlatformFee(escrowedAmount);
            uint256 freelancerPayout = escrowedAmount - platformFee;

            withdrawableBalances[arbiter] += platformFee;
            withdrawableBalances[bounty.selectedFreelancer] += freelancerPayout;

            emit DisputeResolved(
                bountyId, Resolution.FreelancerWon, 0, freelancerPayout, platformFee, freelancer.reputation
            );
        }
    }

    // ---------------------------------------------------------------------
    // Pull payments and percentage math
    // ---------------------------------------------------------------------

    /// @notice Freelancer or Arbiter withdraws accumulated earnings.
    function claimFunds() external nonReentrant {
        if (msg.sender != arbiter) {
            User storage user = users[msg.sender];
            if (!user.isRegistered || user.role != Role.Freelancer) {
                revert NotEligibleToClaim();
            }
        }

        uint256 amount = withdrawableBalances[msg.sender];
        if (amount == 0) revert NoFundsToClaim();

        // Checks-Effects-Interactions: zero first, transfer last.
        withdrawableBalances[msg.sender] = 0;

        emit FundsClaimed(msg.sender, amount);
        _sendEther(payable(msg.sender), amount);
    }

    /// @notice Calculates the Arbiter's 2% fee using Solidity integer math.
    function calculatePlatformFee(uint256 amount) public pure returns (uint256) {
        return (amount * PLATFORM_FEE_PERCENT) / PERCENT_DENOMINATOR;
    }

    /// @notice Calculates the remainder credited to a Freelancer.
    function calculateFreelancerPayout(uint256 amount) public pure returns (uint256) {
        return amount - calculatePlatformFee(amount);
    }

    // ---------------------------------------------------------------------
    // Read helpers for tests and the later frontend
    // ---------------------------------------------------------------------

    function getUser(address account) external view returns (User memory) {
        return users[account];
    }

    function getBounty(uint256 bountyId) external view returns (Bounty memory) {
        Bounty storage bounty = _requireBounty(bountyId);
        return bounty;
    }

    function getBid(uint256 bountyId, uint256 bidId) external view returns (Bid memory) {
        Bid storage bid = _requireBid(bountyId, bidId);
        return bid;
    }

    function registeredUserCount() external view returns (uint256) {
        return registeredUserAddresses.length;
    }

    function registeredUserAt(uint256 index) external view returns (address) {
        return registeredUserAddresses[index];
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    function _requireBounty(uint256 bountyId) internal view returns (Bounty storage bounty) {
        if (bountyId == 0 || bountyId > bountyCount) {
            revert BountyNotFound(bountyId);
        }

        bounty = bounties[bountyId];
    }

    function _requireBid(uint256 bountyId, uint256 bidId) internal view returns (Bid storage bid) {
        if (bidId == 0 || bidId > bidCountByBounty[bountyId]) {
            revert BidNotFound(bountyId, bidId);
        }

        bid = bids[bountyId][bidId];
    }

    function _requireStatus(Bounty storage bounty, BountyStatus requiredStatus) internal view {
        if (bounty.status != requiredStatus) {
            revert InvalidBountyStatus(requiredStatus, bounty.status);
        }
    }

    function _sendEther(address payable recipient, uint256 amount) internal {
        (bool success,) = recipient.call{value: amount}("");
        if (!success) revert EtherTransferFailed();
    }

    receive() external payable {
        revert DirectEtherNotAccepted();
    }

    fallback() external payable {
        revert DirectEtherNotAccepted();
    }
}
