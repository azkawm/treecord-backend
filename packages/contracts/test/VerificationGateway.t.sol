// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Campaign} from "../src/Campaign.sol";
import {IVerificationGateway} from "../src/interfaces/IVerificationGateway.sol";
import {
    Attestation,
    AttestationKind,
    CampaignConfig,
    Tree,
    TreeStatus,
    AttestationExpired,
    InvalidAttestationKind,
    InvalidAttester,
    InvalidPlantedAttestation,
    InvalidScore,
    InvalidSignature,
    LengthMismatch,
    MilestoneAlreadySettled,
    NonceAlreadyUsed,
    SlotAlreadyPlanted,
    SlotNotOwned,
    TreeCampaignMismatch,
    UnknownCampaign,
    WrongPlanter
} from "../src/libraries/TreecordTypes.sol";
import {TestBase} from "./utils/TestBase.sol";

contract VerificationGatewayTest is TestBase {
    Campaign internal c;

    function setUp() public override {
        super.setUp();
        c = _activeCampaign();
        _claim(c, planter1, 2); // slots 3, 4
        _claim(c, planter2, 1); // slot 5
    }

    // -----------------------------------------------------------------------
    // EIP-712
    // -----------------------------------------------------------------------

    function test_typeHashMatchesSpec() public view {
        assertEq(
            gateway.ATTESTATION_TYPEHASH(),
            keccak256(
                "Attestation(uint8 kind,address campaign,uint256 slotId,uint256 treeId,address planter,uint8 milestone,bytes32 evidenceHash,bytes8 geohash,uint16 score,uint256 nonce,uint64 expiry)"
            )
        );
    }

    function test_domainMatchesSpec() public view {
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            gateway.eip712Domain();
        assertEq(name, "Treecord");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(gateway));
        assertEq(
            gateway.domainSeparator(),
            keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256("Treecord"),
                    keccak256("1"),
                    block.chainid,
                    address(gateway)
                )
            )
        );
    }

    function test_hashAttestationMatchesManualDigest() public {
        Attestation memory att = _attestation(AttestationKind.Planted, address(c), 3, 0, planter1, 0);
        bytes32 structHash = keccak256(
            abi.encode(
                gateway.ATTESTATION_TYPEHASH(),
                att.kind,
                att.campaign,
                att.slotId,
                att.treeId,
                att.planter,
                att.milestone,
                att.evidenceHash,
                att.geohash,
                att.score,
                att.nonce,
                att.expiry
            )
        );
        assertEq(
            gateway.hashAttestation(att), keccak256(abi.encodePacked("\x19\x01", gateway.domainSeparator(), structHash))
        );
    }

    /// @dev Fixed vector shared with packages/shared parity tests (prompt 5). Chain id 84532 and a gateway at a
    ///      fixed address make the digest independent of deployment order. The expected digest was computed
    ///      independently with viem `hashTypedData` using the same domain and message.
    function test_parityFixture() public {
        vm.chainId(84532);
        address fixedGateway = 0x1111111111111111111111111111111111111111;
        deployCodeTo("VerificationGateway.sol:VerificationGateway", abi.encode(roles), fixedGateway);
        Attestation memory att = Attestation({
            kind: 0,
            campaign: 0x2222222222222222222222222222222222222222,
            slotId: 12,
            treeId: 0,
            planter: 0x3333333333333333333333333333333333333333,
            milestone: 0,
            evidenceHash: keccak256("treecord-fixture"),
            geohash: bytes8("qqguwvt"),
            score: 9200,
            nonce: 42,
            expiry: 1_800_000_000
        });
        bytes32 digest = IVerificationGateway(fixedGateway).hashAttestation(att);
        assertEq(digest, 0xa2a16bb4d852b11e15802eaa9c06005c38528d81023d86e406cac952340062ed);
    }

    // -----------------------------------------------------------------------
    // PLANTED
    // -----------------------------------------------------------------------

    function test_plantedRegistersTreeAndPaysMilestoneZero() public {
        Attestation memory att = _attestation(AttestationKind.Planted, address(c), 3, 0, planter1, 0);
        vm.expectEmit(address(gateway));
        emit IVerificationGateway.AttestationAccepted(att.nonce, att.kind, 1, att.evidenceHash, att.score);
        uint256 treeId = _submit(att);

        assertEq(treeId, 1);
        assertEq(usdc.balanceOf(planter1), M0);
        assertTrue(gateway.nonceUsed(att.nonce));
        assertTrue(c.isMilestonePaid(treeId, 0));
        assertEq(c.slotTree(3), treeId);
        assertEq(registry.treeOfSlot(address(c), 3), treeId);
        assertEq(c.plantedCount(), 1);
        assertEq(c.lastPlantedAt(), _now());

        Tree memory tree = registry.getTree(treeId);
        assertEq(tree.campaign, address(c));
        assertEq(tree.slotId, 3);
        assertEq(uint8(tree.status), uint8(TreeStatus.Alive));
        assertEq(tree.planter, planter1);
        assertEq(tree.plantedAt, _now());
        assertEq(tree.geohash, att.geohash);
        assertEq(tree.latestEvidenceHash, att.evidenceHash);
    }

    function test_anyoneCanRelay() public {
        Attestation memory att = _attestation(AttestationKind.Planted, address(c), 3, 0, planter1, 0);
        bytes memory sig = _sign(attesterKey, att);
        vm.prank(outsider);
        gateway.submit(att, sig);
        assertEq(usdc.balanceOf(planter1), M0);
    }

    function test_revertWhen_signerIsNotAttester() public {
        (address mallory, uint256 malloryKey) = makeAddrAndKey("mallory");
        Attestation memory att = _attestation(AttestationKind.Planted, address(c), 3, 0, planter1, 0);
        bytes memory sig = _sign(malloryKey, att);
        vm.expectRevert(abi.encodeWithSelector(InvalidAttester.selector, mallory));
        gateway.submit(att, sig);
    }

    function test_revertWhen_signatureMalformed() public {
        Attestation memory att = _attestation(AttestationKind.Planted, address(c), 3, 0, planter1, 0);
        vm.expectRevert(InvalidSignature.selector);
        gateway.submit(att, hex"1234");
    }

    function test_revertWhen_payloadTamperedAfterSigning() public {
        Attestation memory att = _attestation(AttestationKind.Planted, address(c), 3, 0, planter1, 0);
        bytes memory sig = _sign(attesterKey, att);
        att.planter = planter2;
        vm.expectRevert(); // recovers a random non-attester address
        gateway.submit(att, sig);
    }

    function test_revertWhen_nonceReused() public {
        Attestation memory att = _attestation(AttestationKind.Planted, address(c), 3, 0, planter1, 0);
        _submit(att);
        _submitExpectRevert(att, abi.encodeWithSelector(NonceAlreadyUsed.selector, att.nonce));
    }

    function test_revertWhen_expired() public {
        Attestation memory att = _attestation(AttestationKind.Planted, address(c), 3, 0, planter1, 0);
        bytes memory sig = _sign(attesterKey, att);
        vm.warp(uint256(att.expiry) + 1);
        vm.expectRevert(abi.encodeWithSelector(AttestationExpired.selector, att.expiry));
        gateway.submit(att, sig);
    }

    function test_acceptedAtExactExpiry() public {
        Attestation memory att = _attestation(AttestationKind.Planted, address(c), 3, 0, planter1, 0);
        bytes memory sig = _sign(attesterKey, att);
        vm.warp(att.expiry);
        // Milestone 0 window is [plantedAt, plantedAt + unit], and plantedAt is now, so this succeeds.
        gateway.submit(att, sig);
    }

    function test_revertWhen_scoreAboveMax() public {
        Attestation memory att = _attestation(AttestationKind.Planted, address(c), 3, 0, planter1, 0);
        att.score = 10_001;
        _submitExpectRevert(att, abi.encodeWithSelector(InvalidScore.selector, 10_001));
    }

    function test_revertWhen_unknownKind() public {
        Attestation memory att = _attestation(AttestationKind.Planted, address(c), 3, 0, planter1, 0);
        att.kind = 4;
        _submitExpectRevert(att, abi.encodeWithSelector(InvalidAttestationKind.selector, 4));
    }

    function test_revertWhen_unknownCampaign() public {
        Attestation memory att = _attestation(AttestationKind.Planted, outsider, 3, 0, planter1, 0);
        _submitExpectRevert(att, abi.encodeWithSelector(UnknownCampaign.selector, outsider));
    }

    function test_revertWhen_plantedHasTreeIdOrMilestone() public {
        Attestation memory att = _attestation(AttestationKind.Planted, address(c), 3, 7, planter1, 0);
        _submitExpectRevert(att, abi.encodeWithSelector(InvalidPlantedAttestation.selector));
        att = _attestation(AttestationKind.Planted, address(c), 3, 0, planter1, 1);
        _submitExpectRevert(att, abi.encodeWithSelector(InvalidPlantedAttestation.selector));
    }

    function test_revertWhen_wrongPlanterForSlot() public {
        Attestation memory att = _attestation(AttestationKind.Planted, address(c), 3, 0, planter2, 0);
        _submitExpectRevert(att, abi.encodeWithSelector(SlotNotOwned.selector, 3, planter2));
    }

    function test_revertWhen_slotAlreadyPlanted() public {
        _plant(c, 3, planter1);
        Attestation memory att = _attestation(AttestationKind.Planted, address(c), 3, 0, planter1, 0);
        _submitExpectRevert(att, abi.encodeWithSelector(SlotAlreadyPlanted.selector, 3));
    }

    // -----------------------------------------------------------------------
    // ALIVE, DEAD, REPLANTED
    // -----------------------------------------------------------------------

    function test_aliveRecordsCheckInAndPays() public {
        uint256 treeId = _plant(c, 3, planter1);
        _warpToOpen(c, treeId, 1);
        _checkIn(c, treeId, planter1, 1);
        assertEq(usdc.balanceOf(planter1), 2 * M0);
        assertEq(registry.getTree(treeId).checkInCount, 1);
    }

    function test_revertWhen_aliveFromWrongPlanter() public {
        uint256 treeId = _plant(c, 3, planter1);
        _warpToOpen(c, treeId, 1);
        Attestation memory att = _attestation(AttestationKind.Alive, address(c), 0, treeId, planter2, 1);
        _submitExpectRevert(att, abi.encodeWithSelector(WrongPlanter.selector, treeId, planter2));
    }

    function test_revertWhen_treeInDifferentCampaign() public {
        uint256 treeId = _plant(c, 3, planter1);
        CampaignConfig memory cfg = _defaultConfig();
        Campaign other = _createCampaign(cfg);
        _warpToOpen(c, treeId, 1);
        Attestation memory att = _attestation(AttestationKind.Alive, address(other), 0, treeId, planter1, 1);
        _submitExpectRevert(att, abi.encodeWithSelector(TreeCampaignMismatch.selector, treeId, address(other)));
    }

    function test_revertWhen_aliveForMilestoneZero() public {
        uint256 treeId = _plant(c, 3, planter1);
        Attestation memory att = _attestation(AttestationKind.Alive, address(c), 0, treeId, planter1, 0);
        _submitExpectRevert(att, abi.encodeWithSelector(MilestoneAlreadySettled.selector, treeId, 0));
    }

    function test_deadAndReplantedThroughGateway() public {
        uint256 treeId = _plant(c, 3, planter1);
        _reportDead(c, treeId, planter1);
        assertEq(uint8(registry.statusOf(treeId)), uint8(TreeStatus.Dead));
        _reportReplanted(c, treeId, planter1);
        assertEq(uint8(registry.statusOf(treeId)), uint8(TreeStatus.Alive));
    }

    // -----------------------------------------------------------------------
    // Batches
    // -----------------------------------------------------------------------

    function test_submitBatch() public {
        Attestation[] memory atts = new Attestation[](3);
        bytes[] memory sigs = new bytes[](3);
        atts[0] = _attestation(AttestationKind.Planted, address(c), 3, 0, planter1, 0);
        atts[1] = _attestation(AttestationKind.Planted, address(c), 4, 0, planter1, 0);
        atts[2] = _attestation(AttestationKind.Planted, address(c), 5, 0, planter2, 0);
        for (uint256 i = 0; i < 3; ++i) {
            sigs[i] = _sign(attesterKey, atts[i]);
        }
        vm.prank(relayer);
        gateway.submitBatch(atts, sigs);

        assertEq(registry.treeCount(), 3);
        assertEq(usdc.balanceOf(planter1), 2 * M0);
        assertEq(usdc.balanceOf(planter2), M0);
    }

    function test_batchIsAllOrNothing() public {
        Attestation[] memory atts = new Attestation[](2);
        bytes[] memory sigs = new bytes[](2);
        atts[0] = _attestation(AttestationKind.Planted, address(c), 3, 0, planter1, 0);
        atts[1] = _attestation(AttestationKind.Planted, address(c), 5, 0, planter1, 0); // slot 5 is planter2's
        sigs[0] = _sign(attesterKey, atts[0]);
        sigs[1] = _sign(attesterKey, atts[1]);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(SlotNotOwned.selector, 5, planter1));
        gateway.submitBatch(atts, sigs);

        assertEq(registry.treeCount(), 0);
        assertFalse(gateway.nonceUsed(atts[0].nonce));
        assertEq(usdc.balanceOf(planter1), 0);
    }

    function test_revertWhen_batchLengthMismatch() public {
        Attestation[] memory atts = new Attestation[](2);
        bytes[] memory sigs = new bytes[](1);
        vm.expectRevert(LengthMismatch.selector);
        gateway.submitBatch(atts, sigs);
    }
}
