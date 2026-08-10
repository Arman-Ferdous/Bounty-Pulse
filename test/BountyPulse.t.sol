// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BountyPulse} from "../src/BountyPulse.sol";

contract BountyPulseTest is Test {
    BountyPulse internal bountyPulse;

    address internal arbiter = makeAddr("arbiter");
    address internal client = makeAddr("client");
    address internal freelancer = makeAddr("freelancer");
    address internal secondFreelancer = makeAddr("secondFreelancer");

    uint256 internal constant MAX_BUDGET = 2 ether;
    uint256 internal constant BID_AMOUNT = 1 ether;

    string internal constant CLIENT_AVATAR = "QmClientAvatarCid";
    string internal constant FREELANCER_AVATAR = "QmFreelancerAvatarCid";
    string internal constant BOUNTY_DETAILS = "QmBountyDetailsCid";
    string internal constant WORK_FILE = "QmSubmittedWorkCid";

    function setUp() public {
        vm.prank(arbiter);
        bountyPulse = new BountyPulse();

        vm.deal(client, 100 ether);
        vm.deal(freelancer, 100 ether);
        vm.deal(secondFreelancer, 100 ether);
        vm.deal(arbiter, 100 ether);

        vm.prank(arbiter);
        bountyPulse.registerUser("Aria Arbiter", BountyPulse.Role.Arbiter, "QmArbiterAvatarCid");

        vm.prank(client);
        bountyPulse.registerUser("Alice Client", BountyPulse.Role.Client, CLIENT_AVATAR);

        vm.prank(freelancer);
        bountyPulse.registerUser("Bob Freelancer", BountyPulse.Role.Freelancer, FREELANCER_AVATAR);

        vm.prank(secondFreelancer);
        bountyPulse.registerUser("Carol Freelancer", BountyPulse.Role.Freelancer, "QmSecondFreelancerAvatarCid");
    }

    function test_ArbiterIsTheContractDeployerAndCanRegisterProfile() public {
        assertEq(bountyPulse.arbiter(), arbiter);
        assertEq(uint256(bountyPulse.roleOf(arbiter)), uint256(BountyPulse.Role.Arbiter));

        BountyPulse.User memory user = bountyPulse.getUser(arbiter);
        assertTrue(user.isRegistered);
        assertEq(uint256(user.role), uint256(BountyPulse.Role.Arbiter));
        assertEq(user.reputation, 0);
    }

    function test_FreelancerStartsWithReputation100() public {
        BountyPulse.User memory user = bountyPulse.getUser(freelancer);

        assertTrue(user.isRegistered);
        assertEq(uint256(user.role), uint256(BountyPulse.Role.Freelancer));
        assertEq(user.reputation, 100);
    }

    function test_WalletCannotRegisterTwice() public {
        vm.expectRevert(BountyPulse.AlreadyRegistered.selector);
        vm.prank(client);
        bountyPulse.registerUser("Duplicate Client", BountyPulse.Role.Client, CLIENT_AVATAR);
    }

    function test_ClientPostsAnOpenBounty() public {
        vm.prank(client);
        uint256 bountyId = bountyPulse.postBounty(MAX_BUDGET, BOUNTY_DETAILS);

        BountyPulse.Bounty memory bounty = bountyPulse.getBounty(bountyId);

        assertEq(bounty.id, 1);
        assertEq(bounty.client, client);
        assertEq(bounty.maxBudget, MAX_BUDGET);
        assertEq(uint256(bounty.status), uint256(BountyPulse.BountyStatus.Open));
    }

    function test_BidCannotExceedMaximumBudget() public {
        vm.prank(client);
        uint256 bountyId = bountyPulse.postBounty(MAX_BUDGET, BOUNTY_DETAILS);

        vm.expectRevert(abi.encodeWithSelector(BountyPulse.BidExceedsBudget.selector, MAX_BUDGET + 1, MAX_BUDGET));
        vm.prank(freelancer);
        bountyPulse.submitBid(bountyId, MAX_BUDGET + 1);
    }

    function test_SubmitBidIsNonPayable() public {
        vm.prank(client);
        uint256 bountyId = bountyPulse.postBounty(MAX_BUDGET, BOUNTY_DETAILS);

        bytes memory callData = abi.encodeWithSelector(BountyPulse.submitBid.selector, bountyId, BID_AMOUNT);

        vm.prank(freelancer);
        (bool success,) = address(bountyPulse).call{value: 1 wei}(callData);

        assertFalse(success);
        assertEq(address(bountyPulse).balance, 0);
    }

    function test_UnderpaymentRevertsEntireFundingTransaction() public {
        (uint256 bountyId, uint256 bidId) = _postAndBid(BID_AMOUNT);

        vm.expectRevert(abi.encodeWithSelector(BountyPulse.InsufficientEscrow.selector, BID_AMOUNT, BID_AMOUNT - 1));
        vm.prank(client);
        bountyPulse.fundBounty{value: BID_AMOUNT - 1}(bountyId, bidId);

        BountyPulse.Bounty memory bounty = bountyPulse.getBounty(bountyId);
        assertEq(uint256(bounty.status), uint256(BountyPulse.BountyStatus.Open));
        assertEq(bounty.escrowAmount, 0);
        assertEq(address(bountyPulse).balance, 0);
    }

    function test_OverpaymentKeepsExactBidAndRefundsExcess() public {
        (uint256 bountyId, uint256 bidId) = _postAndBid(BID_AMOUNT);

        uint256 clientBalanceBefore = client.balance;
        uint256 sentAmount = BID_AMOUNT + 0.25 ether;

        vm.prank(client);
        bountyPulse.fundBounty{value: sentAmount}(bountyId, bidId);

        BountyPulse.Bounty memory bounty = bountyPulse.getBounty(bountyId);

        assertEq(client.balance, clientBalanceBefore - BID_AMOUNT);
        assertEq(address(bountyPulse).balance, BID_AMOUNT);
        assertEq(bounty.escrowAmount, BID_AMOUNT);
        assertEq(bounty.agreedAmount, BID_AMOUNT);
        assertEq(bounty.selectedFreelancer, freelancer);
        assertEq(uint256(bounty.status), uint256(BountyPulse.BountyStatus.Locked));
    }

    function test_ApprovalUsesTwoPercentPullPaymentAndAddsReputation() public {
        uint256 bountyId = _createSubmittedBounty();

        vm.prank(client);
        bountyPulse.approveWork(bountyId);

        uint256 expectedFee = 0.02 ether;
        uint256 expectedPayout = 0.98 ether;

        assertEq(bountyPulse.withdrawableBalances(arbiter), expectedFee);
        assertEq(bountyPulse.withdrawableBalances(freelancer), expectedPayout);
        assertEq(bountyPulse.withdrawableBalances(arbiter) + bountyPulse.withdrawableBalances(freelancer), BID_AMOUNT);

        BountyPulse.User memory user = bountyPulse.getUser(freelancer);
        BountyPulse.Bounty memory bounty = bountyPulse.getBounty(bountyId);

        assertEq(user.reputation, 115);
        assertEq(bounty.escrowAmount, 0);
        assertEq(uint256(bounty.status), uint256(BountyPulse.BountyStatus.Resolved));
        assertEq(uint256(bounty.resolution), uint256(BountyPulse.Resolution.FreelancerWon));
    }

    function test_FreelancerAndArbiterCanClaimAccumulatedFunds() public {
        uint256 bountyId = _createSubmittedBounty();

        vm.prank(client);
        bountyPulse.approveWork(bountyId);

        uint256 freelancerBalanceBefore = freelancer.balance;
        uint256 arbiterBalanceBefore = arbiter.balance;

        vm.prank(freelancer);
        bountyPulse.claimFunds();

        vm.prank(arbiter);
        bountyPulse.claimFunds();

        assertEq(freelancer.balance, freelancerBalanceBefore + 0.98 ether);
        assertEq(arbiter.balance, arbiterBalanceBefore + 0.02 ether);
        assertEq(bountyPulse.withdrawableBalances(freelancer), 0);
        assertEq(bountyPulse.withdrawableBalances(arbiter), 0);
        assertEq(address(bountyPulse).balance, 0);
    }

    function test_FreelancerFaultRefundsClientAndSubtractsThirtyReputation() public {
        uint256 bountyId = _createSubmittedBounty();

        vm.prank(client);
        bountyPulse.disputeBounty(bountyId);

        uint256 clientBalanceBefore = client.balance;

        vm.prank(arbiter);
        bountyPulse.resolveDispute(bountyId, true);

        BountyPulse.User memory user = bountyPulse.getUser(freelancer);
        BountyPulse.Bounty memory bounty = bountyPulse.getBounty(bountyId);

        assertEq(client.balance, clientBalanceBefore + BID_AMOUNT);
        assertEq(user.reputation, 70);
        assertEq(address(bountyPulse).balance, 0);
        assertEq(uint256(bounty.resolution), uint256(BountyPulse.Resolution.ClientWon));
    }

    function test_ClientFaultCreditsFreelancerMinusTwoPercentFee() public {
        uint256 bountyId = _createSubmittedBounty();

        vm.prank(client);
        bountyPulse.disputeBounty(bountyId);

        vm.prank(arbiter);
        bountyPulse.resolveDispute(bountyId, false);

        BountyPulse.User memory user = bountyPulse.getUser(freelancer);
        BountyPulse.Bounty memory bounty = bountyPulse.getBounty(bountyId);

        assertEq(bountyPulse.withdrawableBalances(freelancer), 0.98 ether);
        assertEq(bountyPulse.withdrawableBalances(arbiter), 0.02 ether);
        assertEq(user.reputation, 100);
        assertEq(uint256(bounty.resolution), uint256(BountyPulse.Resolution.FreelancerWon));
    }

    function test_ReputationBelowFortyCannotBid() public {
        // 100 -> 70 -> 40 -> 10 after three Freelancer-fault resolutions.
        for (uint256 i = 0; i < 3; i++) {
            uint256 bountyId = _createSubmittedBounty();

            vm.prank(client);
            bountyPulse.disputeBounty(bountyId);

            vm.prank(arbiter);
            bountyPulse.resolveDispute(bountyId, true);
        }

        BountyPulse.User memory user = bountyPulse.getUser(freelancer);
        assertEq(user.reputation, 10);

        vm.prank(client);
        uint256 newBountyId = bountyPulse.postBounty(MAX_BUDGET, BOUNTY_DETAILS);

        vm.expectRevert(abi.encodeWithSelector(BountyPulse.ReputationTooLow.selector, 10, 40));
        vm.prank(freelancer);
        bountyPulse.submitBid(newBountyId, BID_AMOUNT);
    }

    function testFuzz_PercentageMathPreservesTheWholeEscrow(uint128 rawAmount) public {
        uint256 amount = uint256(rawAmount);
        uint256 fee = bountyPulse.calculatePlatformFee(amount);
        uint256 freelancerPayout = bountyPulse.calculateFreelancerPayout(amount);

        assertEq(fee, (amount * 2) / 100);
        assertEq(fee + freelancerPayout, amount);
    }

    // ------------------------------------------------------------------
    // Test helpers
    // ------------------------------------------------------------------

    function _postAndBid(uint256 bidAmount) internal returns (uint256 bountyId, uint256 bidId) {
        vm.prank(client);
        bountyId = bountyPulse.postBounty(MAX_BUDGET, BOUNTY_DETAILS);

        vm.prank(freelancer);
        bidId = bountyPulse.submitBid(bountyId, bidAmount);
    }

    function _createSubmittedBounty() internal returns (uint256 bountyId) {
        uint256 bidId;
        (bountyId, bidId) = _postAndBid(BID_AMOUNT);

        vm.prank(client);
        bountyPulse.fundBounty{value: BID_AMOUNT}(bountyId, bidId);

        vm.prank(freelancer);
        bountyPulse.submitWork(bountyId, WORK_FILE);
    }
}
