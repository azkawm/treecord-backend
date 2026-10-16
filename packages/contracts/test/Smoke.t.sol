// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Campaign} from "../src/Campaign.sol";
import {CampaignFactory} from "../src/CampaignFactory.sol";
import {CarbonLedger} from "../src/CarbonLedger.sol";
import {TreeRegistry} from "../src/TreeRegistry.sol";
import {TreecordRoles} from "../src/TreecordRoles.sol";
import {VerificationGateway} from "../src/VerificationGateway.sol";
import {ITreeRegistry} from "../src/interfaces/ITreeRegistry.sol";
import {TreecordConstants as C} from "../src/libraries/TreecordConstants.sol";
import {
    Attestation,
    CampaignConfig,
    CampaignStatus,
    TreeStatus,
    AttestationExpired,
    InvalidAttester,
    NonceAlreadyUsed,
    NonTransferable,
    PlanterCapExceeded,
    TreeFrozen
} from "../src/libraries/TreecordTypes.sol";

contract SmokeUSDC is ERC20 {
    constructor() ERC20("Test USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Shared deployment for the smoke tests. The full suite with TestBase arrives in prompt 4.
abstract contract SmokeBase is Test {
    uint64 internal constant UNIT = 60;

    SmokeUSDC internal usdc;
    TreecordRoles internal roles;
    TreeRegistry internal registry;
    CampaignFactory internal factory;
    Campaign internal campaign;

    address internal treasury = makeAddr("treasury");
    address internal donorA = makeAddr("donorA");
    address internal donorB = makeAddr("donorB");
    address internal planter1 = makeAddr("planter1");
    address internal planter2 = makeAddr("planter2");

    /// @dev Deploys core contracts with this test contract as admin and operator, then creates and funds a
    ///      campaign: 4 trees (1 anchor, 3 open), 1000 USDC target, donorA 600 and donorB 400.
    function _deployCore(address gateway) internal {
        usdc = new SmokeUSDC();
        roles = new TreecordRoles(address(this), treasury);
        registry = new TreeRegistry(roles);
        Campaign impl = new Campaign(roles, IERC20(address(usdc)), ITreeRegistry(address(registry)));
        factory = new CampaignFactory(roles, address(impl));

        roles.setFactory(address(factory));
        roles.setTreeRegistry(address(registry));
        if (gateway != address(0)) roles.setGateway(gateway);
        roles.grantRole(roles.OPERATOR_ROLE(), address(this));

        CampaignConfig memory cfg = CampaignConfig({
            creator: donorA,
            metadataURI: "ipfs://demo",
            speciesCode: bytes32("SWIETENIA_MACROPHYLLA"),
            regionGeohash: bytes8("qqguwvt"),
            regionRadiusM: 5000,
            treeTarget: 4,
            anchorBps: C.DEFAULT_ANCHOR_BPS,
            perPlanterCap: 2,
            fundingTarget: 1000e6,
            fundingDeadline: uint64(block.timestamp + 1 days),
            claimDeadline: uint64(block.timestamp + 2 days),
            commitmentUnits: 36,
            timeUnit: UNIT,
            split: C.defaultSplit()
        });
        vm.prank(donorA);
        campaign = Campaign(factory.createCampaign(cfg));

        usdc.mint(donorA, 600e6);
        usdc.mint(donorB, 600e6);
    }

    function _contribute(address donor, uint256 amount) internal {
        vm.startPrank(donor);
        usdc.approve(address(campaign), amount);
        campaign.contribute(amount);
        vm.stopPrank();
    }
}

/// @notice Campaign and TreeRegistry lifecycle, with this test contract acting as the gateway.
contract SmokeLifecycleTest is SmokeBase {
    function setUp() public {
        _deployCore(address(this));
    }

    function test_fullLifecycle() public {
        // Funding: donorB overpays and only the remainder is pulled. Activation sends 20% to treasury.
        _contribute(donorA, 600e6);
        _contribute(donorB, 600e6);
        assertEq(uint8(campaign.status()), uint8(CampaignStatus.Active));
        assertEq(campaign.contributions(donorB), 400e6);
        assertEq(usdc.balanceOf(donorB), 200e6);
        assertEq(usdc.balanceOf(treasury), 200e6);
        assertEq(usdc.balanceOf(address(campaign)), 800e6);
        assertEq(campaign.perTreeIncentive(), 175e6);
        assertEq(campaign.anchorSlots(), 1);
        assertEq(campaign.openSlots(), 3);

        // Open claims are capped per planter and start after the anchor range.
        campaign.claimSlotsFor(planter1, 2);
        assertEq(campaign.slotOwner(2), planter1);
        assertEq(campaign.slotOwner(3), planter1);
        vm.expectRevert(abi.encodeWithSelector(PlanterCapExceeded.selector, 1, 0));
        campaign.claimSlotsFor(planter1, 1);

        // Plant slot 2 and pay milestone 0.
        uint256 t0 = vm.getBlockTimestamp();
        uint256 treeId = registry.registerTree(address(campaign), 2, planter1, bytes8("qqguwvt"), keccak256("e0"));
        campaign.releaseMilestone(treeId, 0, planter1);
        assertEq(usdc.balanceOf(planter1), 17.5e6);

        // Milestone 1 is due at 3 units.
        vm.warp(t0 + 3 * UNIT);
        registry.recordCheckIn(treeId, keccak256("e1"));
        campaign.releaseMilestone(treeId, 1, planter1);
        assertEq(usdc.balanceOf(planter1), 35e6);

        // Milestone 2 window [6u, 7u] is missed and forfeited.
        vm.warp(t0 + 7 * UNIT + 1);
        campaign.forfeitMilestone(treeId, 2);
        assertEq(campaign.forfeitedPool(), 17.5e6);

        // A flag freezes the clock, and dismissal shifts later windows by the flagged duration.
        vm.prank(donorA);
        registry.flag(treeId, keccak256("looks fake"));
        vm.expectRevert(abi.encodeWithSelector(TreeFrozen.selector, treeId));
        campaign.forfeitMilestone(treeId, 3);
        vm.warp(vm.getBlockTimestamp() + 100);
        registry.resolveFlag(treeId, false, keccak256("checked"));
        (uint256 opensAt,) = campaign.milestoneWindow(treeId, 3);
        assertEq(opensAt, t0 + 12 * UNIT + 100);

        // Death without replanting removes the tree and forfeits everything unpaid.
        registry.markDead(treeId, keccak256("dead"));
        vm.warp(vm.getBlockTimestamp() + 2 * UNIT + 1);
        registry.expireDead(treeId);
        assertEq(uint8(registry.statusOf(treeId)), uint8(TreeStatus.Removed));
        assertEq(campaign.forfeitedPool(), 175e6 - 35e6);
        assertEq(campaign.settledCount(), campaign.plantedCount());

        // After the claim deadline, unclaimed open slots roll into the anchor portion.
        vm.warp(t0 + 2 days);
        assertEq(campaign.availableAnchorSlots(), 2);
        campaign.assignAnchorSlots(planter2, 2);
        assertEq(campaign.slotOwner(1), planter2);
        assertEq(campaign.slotOwner(4), planter2);

        // Completion: everything not paid out is refundable pro rata.
        vm.warp(t0 + 2 days + 37 * UNIT);
        campaign.complete();
        assertEq(campaign.refundPool(), 765e6);
        assertEq(usdc.balanceOf(address(campaign)), 765e6);

        vm.prank(donorA);
        assertEq(campaign.claimRefund(), 459e6);
        vm.prank(donorB);
        assertEq(campaign.claimRefund(), 306e6);
        assertEq(usdc.balanceOf(address(campaign)), 0);
    }
}

/// @notice VerificationGateway signatures and CarbonLedger flows with the real contracts wired.
contract SmokeGatewayLedgerTest is SmokeBase {
    VerificationGateway internal gateway;
    CarbonLedger internal ledger;

    address internal attester;
    uint256 internal attesterKey;
    address internal relayer = makeAddr("relayer");
    address internal buyer = makeAddr("buyer");

    function setUp() public {
        _deployCore(address(0));
        gateway = new VerificationGateway(roles);
        ledger = new CarbonLedger(roles, IERC20(address(usdc)), "https://treecord.app/api/carbon/batches/{id}.json");
        roles.setGateway(address(gateway));
        roles.setCarbonLedger(address(ledger));

        (attester, attesterKey) = makeAddrAndKey("attester");
        roles.grantRole(roles.ATTESTER_ROLE(), attester);
        roles.grantRole(roles.ISSUER_ROLE(), address(this));

        _contribute(donorA, 600e6);
        _contribute(donorB, 600e6);
        campaign.claimSlotsFor(planter1, 2);
    }

    function test_gatewayPlantedAndAlive() public {
        Attestation memory planted = _attestation(0, 0, 0, 1);

        // Digest parity: OpenZeppelin EIP712 equals a hand-built EIP-712 digest.
        bytes32 structHash = keccak256(
            abi.encode(
                gateway.ATTESTATION_TYPEHASH(),
                planted.kind,
                planted.campaign,
                planted.slotId,
                planted.treeId,
                planted.planter,
                planted.milestone,
                planted.evidenceHash,
                planted.geohash,
                planted.score,
                planted.nonce,
                planted.expiry
            )
        );
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", gateway.domainSeparator(), structHash));
        assertEq(gateway.hashAttestation(planted), expected);

        // A relayer submits. The planter is paid milestone 0 without sending a transaction.
        bytes memory sig = _sign(attesterKey, planted);
        vm.prank(relayer);
        uint256 treeId = gateway.submit(planted, sig);
        assertEq(treeId, 1);
        assertEq(usdc.balanceOf(planter1), 17.5e6);
        assertTrue(gateway.nonceUsed(1));

        // Replay, wrong signer, and expiry are rejected.
        vm.expectRevert(abi.encodeWithSelector(NonceAlreadyUsed.selector, 1));
        gateway.submit(planted, sig);

        (address mallory, uint256 malloryKey) = makeAddrAndKey("mallory");
        Attestation memory forged = _attestation(1, treeId, 1, 2);
        bytes memory forgedSig = _sign(malloryKey, forged);
        vm.expectRevert(abi.encodeWithSelector(InvalidAttester.selector, mallory));
        gateway.submit(forged, forgedSig);

        Attestation memory stale = _attestation(1, treeId, 1, 3);
        bytes memory staleSig = _sign(attesterKey, stale);
        vm.warp(stale.expiry + 1);
        vm.expectRevert(abi.encodeWithSelector(AttestationExpired.selector, stale.expiry));
        gateway.submit(stale, staleSig);

        // ALIVE milestone 1 through a batch of one, inside its window.
        vm.warp(registry.getTree(treeId).plantedAt + 3 * UNIT);
        Attestation[] memory atts = new Attestation[](1);
        bytes[] memory sigs = new bytes[](1);
        atts[0] = _attestation(1, treeId, 1, 4);
        sigs[0] = _sign(attesterKey, atts[0]);
        gateway.submitBatch(atts, sigs);
        assertEq(usdc.balanceOf(planter1), 35e6);
        assertEq(registry.getTree(treeId).checkInCount, 1);
    }

    function test_carbonReserveIssueBuyRetire() public {
        // 100 t estimate, reserved 60/40 by contribution.
        ledger.setEstimate(address(campaign), 100_000);
        assertEq(ledger.reservationOf(address(campaign), donorA), 60_000);
        assertEq(ledger.reservationOf(address(campaign), donorB), 40_000);

        // donorB declines, so their share will go to inventory.
        vm.prank(donorB);
        ledger.declineReservation(address(campaign));

        // 80 t issued: donorA is filled first (60 t), the remaining 20 t go to inventory.
        uint256 batchId = ledger.issueBatch(address(campaign), "SRN PPI", "IDN-0001", "IDN-0080", 2026, 80_000);
        assertEq(ledger.balanceOf(donorA, batchId), 60_000);
        assertEq(ledger.balanceOf(donorB, batchId), 0);
        assertEq(ledger.inventoryOf(batchId), 20_000);
        assertEq(ledger.remainingReservation(address(campaign), donorA), 0);

        // Buyer purchases 1.5 t at 15 USDC per tonne. Proceeds go to the treasury.
        ledger.setPrice(batchId, 15e6);
        usdc.mint(buyer, 100e6);
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        vm.startPrank(buyer);
        usdc.approve(address(ledger), type(uint256).max);
        assertEq(ledger.buy(batchId, 1_500), 22.5e6);
        vm.stopPrank();
        assertEq(ledger.balanceOf(buyer, batchId), 1_500);
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, 22.5e6);

        // Credits cannot move between users.
        vm.prank(donorA);
        vm.expectRevert(NonTransferable.selector);
        ledger.safeTransferFrom(donorA, buyer, batchId, 1, "");
        vm.expectRevert(NonTransferable.selector);
        ledger.setApprovalForAll(buyer, true);

        // Retirement burns and records.
        vm.prank(donorA);
        uint256 retirementId = ledger.retire(batchId, 10_000, "PT Contoh", "2026 office emissions");
        assertEq(retirementId, 1);
        assertEq(ledger.balanceOf(donorA, batchId), 50_000);
        assertEq(ledger.getRetirement(retirementId).amount, 10_000);
    }

    function _attestation(uint8 kind, uint256 treeId, uint8 milestone, uint256 nonce)
        internal
        view
        returns (Attestation memory)
    {
        return Attestation({
            kind: kind,
            campaign: address(campaign),
            slotId: 2,
            treeId: treeId,
            planter: planter1,
            milestone: milestone,
            evidenceHash: keccak256(abi.encode("evidence", nonce)),
            geohash: bytes8("qqguwvt"),
            score: 9_200,
            nonce: nonce,
            expiry: uint64(vm.getBlockTimestamp() + 1 hours)
        });
    }

    function _sign(uint256 key, Attestation memory att) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, gateway.hashAttestation(att));
        return abi.encodePacked(r, s, v);
    }
}
