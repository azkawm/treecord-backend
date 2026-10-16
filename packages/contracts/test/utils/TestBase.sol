// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Campaign} from "../../src/Campaign.sol";
import {CampaignFactory} from "../../src/CampaignFactory.sol";
import {CarbonLedger} from "../../src/CarbonLedger.sol";
import {TreeRegistry} from "../../src/TreeRegistry.sol";
import {TreecordRoles} from "../../src/TreecordRoles.sol";
import {VerificationGateway} from "../../src/VerificationGateway.sol";
import {ITreeRegistry} from "../../src/interfaces/ITreeRegistry.sol";
import {TreecordConstants as C} from "../../src/libraries/TreecordConstants.sol";
import {Attestation, AttestationKind, CampaignConfig} from "../../src/libraries/TreecordTypes.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @notice Deploys and wires every Treecord contract, creates labeled actors, and provides helpers for
///         campaigns, claims and signed attestations.
abstract contract TestBase is Test {
    uint64 internal constant UNIT = 60;
    uint32 internal constant TREES = 8;
    uint256 internal constant TARGET = 1000e6;

    // Default campaign (8 trees, 1000 USDC): 2 anchor slots, 6 open slots, 87.5 USDC per tree.
    uint256 internal constant PER_TREE = 87.5e6;
    uint256 internal constant M0 = 8.75e6; // milestones 0 to 2
    uint256 internal constant M3 = 13.125e6; // milestones 3 and 4
    uint256 internal constant M5 = 35e6; // milestone 5 (remainder)

    MockUSDC internal usdc;
    TreecordRoles internal roles;
    TreeRegistry internal registry;
    Campaign internal campaignImpl;
    CampaignFactory internal factory;
    VerificationGateway internal gateway;
    CarbonLedger internal ledger;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal relayer = makeAddr("relayer");
    address internal treasury = makeAddr("treasury");
    address internal donorA = makeAddr("donorA");
    address internal donorB = makeAddr("donorB");
    address internal planter1 = makeAddr("planter1");
    address internal planter2 = makeAddr("planter2");
    address internal outsider = makeAddr("outsider");
    address internal attester;
    uint256 internal attesterKey;

    uint256 internal nonceCounter;

    function setUp() public virtual {
        (attester, attesterKey) = makeAddrAndKey("attester");

        usdc = new MockUSDC();
        roles = new TreecordRoles(admin, treasury);
        registry = new TreeRegistry(roles);
        campaignImpl = new Campaign(roles, IERC20(address(usdc)), ITreeRegistry(address(registry)));
        factory = new CampaignFactory(roles, address(campaignImpl));
        gateway = new VerificationGateway(roles);
        ledger = new CarbonLedger(roles, IERC20(address(usdc)), "https://treecord.test/carbon/{id}.json");

        vm.startPrank(admin);
        roles.setFactory(address(factory));
        roles.setTreeRegistry(address(registry));
        roles.setGateway(address(gateway));
        roles.setCarbonLedger(address(ledger));
        roles.grantRole(roles.OPERATOR_ROLE(), operator);
        roles.grantRole(roles.ISSUER_ROLE(), operator);
        roles.grantRole(roles.ATTESTER_ROLE(), attester);
        vm.stopPrank();
    }

    // -----------------------------------------------------------------------
    // Campaign helpers
    // -----------------------------------------------------------------------

    function _defaultConfig() internal view returns (CampaignConfig memory) {
        uint256 nowTs = vm.getBlockTimestamp();
        return CampaignConfig({
            creator: donorA,
            metadataURI: "ipfs://treecord-demo",
            speciesCode: bytes32("SWIETENIA_MACROPHYLLA"),
            regionGeohash: bytes8("qqguwvt"),
            regionRadiusM: 5000,
            treeTarget: TREES,
            anchorBps: C.DEFAULT_ANCHOR_BPS,
            perPlanterCap: 3,
            fundingTarget: TARGET,
            fundingDeadline: uint64(nowTs + 1 days),
            claimDeadline: uint64(nowTs + 2 days),
            commitmentUnits: C.MIN_COMMITMENT_UNITS,
            timeUnit: UNIT,
            split: C.defaultSplit()
        });
    }

    function _createCampaign(CampaignConfig memory cfg) internal returns (Campaign) {
        vm.prank(cfg.creator);
        return Campaign(factory.createCampaign(cfg));
    }

    function _newCampaign() internal returns (Campaign) {
        return _createCampaign(_defaultConfig());
    }

    function _fund(Campaign c, address donor, uint256 amount) internal returns (uint256 accepted) {
        usdc.mint(donor, amount);
        vm.startPrank(donor);
        usdc.approve(address(c), amount);
        accepted = c.contribute(amount);
        vm.stopPrank();
    }

    /// @dev Default campaign funded 600 by donorA and 400 by donorB, so it is Active.
    function _activeCampaign() internal returns (Campaign c) {
        c = _newCampaign();
        _fund(c, donorA, 600e6);
        _fund(c, donorB, 400e6);
    }

    function _claim(Campaign c, address planter, uint16 count) internal {
        vm.prank(operator);
        c.claimSlotsFor(planter, count);
    }

    // -----------------------------------------------------------------------
    // Attestation helpers
    // -----------------------------------------------------------------------

    function _attestation(
        AttestationKind kind,
        address campaign,
        uint256 slotId,
        uint256 treeId,
        address planter,
        uint8 milestone
    ) internal returns (Attestation memory) {
        uint256 nonce = ++nonceCounter;
        return Attestation({
            kind: uint8(kind),
            campaign: campaign,
            slotId: slotId,
            treeId: treeId,
            planter: planter,
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

    function _submit(Attestation memory att) internal returns (uint256 treeId) {
        bytes memory sig = _sign(attesterKey, att);
        vm.prank(relayer);
        treeId = gateway.submit(att, sig);
    }

    /// @dev Signs with the attester key and expects `submit` to revert with `revertData`.
    function _submitExpectRevert(Attestation memory att, bytes memory revertData) internal {
        bytes memory sig = _sign(attesterKey, att);
        vm.prank(relayer);
        vm.expectRevert(revertData);
        gateway.submit(att, sig);
    }

    function _plant(Campaign c, uint256 slotId, address planter) internal returns (uint256) {
        return _submit(_attestation(AttestationKind.Planted, address(c), slotId, 0, planter, 0));
    }

    function _checkIn(Campaign c, uint256 treeId, address planter, uint8 milestone) internal {
        _submit(_attestation(AttestationKind.Alive, address(c), 0, treeId, planter, milestone));
    }

    function _reportDead(Campaign c, uint256 treeId, address planter) internal {
        _submit(_attestation(AttestationKind.Dead, address(c), 0, treeId, planter, 0));
    }

    function _reportReplanted(Campaign c, uint256 treeId, address planter) internal {
        _submit(_attestation(AttestationKind.Replanted, address(c), 0, treeId, planter, 0));
    }

    function _warpToOpen(Campaign c, uint256 treeId, uint8 milestone) internal {
        (uint256 opensAt,) = c.milestoneWindow(treeId, milestone);
        vm.warp(opensAt);
    }

    function _warpPastClose(Campaign c, uint256 treeId, uint8 milestone) internal {
        (, uint256 closesAt) = c.milestoneWindow(treeId, milestone);
        vm.warp(closesAt + 1);
    }

    /// @dev Pays every milestone of a tree on time.
    function _payAllMilestones(Campaign c, uint256 treeId, address planter) internal {
        for (uint8 m = 1; m < C.MILESTONE_COUNT; ++m) {
            _warpToOpen(c, treeId, m);
            _checkIn(c, treeId, planter, m);
        }
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }
}
