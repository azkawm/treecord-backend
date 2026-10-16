// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Campaign} from "../src/Campaign.sol";
import {CampaignFactory} from "../src/CampaignFactory.sol";
import {TreecordRoles} from "../src/TreecordRoles.sol";
import {ICampaignFactory} from "../src/interfaces/ICampaignFactory.sol";
import {ITreeRegistry} from "../src/interfaces/ITreeRegistry.sol";
import {
    CampaignConfig,
    CampaignStatus,
    CommitmentTooShort,
    InvalidAnchorBps,
    InvalidDeadlines,
    InvalidFundingTarget,
    InvalidPerPlanterCap,
    InvalidSplit,
    InvalidTimeUnit,
    InvalidTreeTarget,
    Unauthorized,
    ZeroAddress
} from "../src/libraries/TreecordTypes.sol";
import {TestBase} from "./utils/TestBase.sol";

contract CampaignFactoryTest is TestBase {
    function test_createCampaign() public {
        CampaignConfig memory cfg = _defaultConfig();

        vm.prank(donorA);
        vm.expectEmit(false, true, false, false, address(factory));
        emit ICampaignFactory.CampaignCreated(address(0), donorA, cfg);
        Campaign c = Campaign(factory.createCampaign(cfg));

        assertTrue(factory.isCampaign(address(c)));
        assertEq(factory.campaignCount(), 1);
        assertEq(factory.campaignAt(0), address(c));
        assertEq(factory.campaigns().length, 1);
        assertEq(c.factory(), address(factory));
        assertEq(uint8(c.status()), uint8(CampaignStatus.Funding));
        assertEq(c.anchorSlots(), 2);
        assertEq(c.openSlots(), 6);
        assertEq(c.timeUnit(), UNIT);

        CampaignConfig memory stored = c.config();
        assertEq(stored.creator, donorA);
        assertEq(stored.metadataURI, cfg.metadataURI);
        assertEq(stored.speciesCode, cfg.speciesCode);
        assertEq(stored.fundingTarget, TARGET);
        assertEq(stored.split.incentivesBps, 7000);
    }

    function test_operatorCanCreateForDonor() public {
        vm.prank(operator);
        address c = factory.createCampaign(_defaultConfig());
        assertTrue(factory.isCampaign(c));
    }

    function test_revertWhen_callerIsNotCreatorOrOperator() public {
        CampaignConfig memory cfg = _defaultConfig();
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Unauthorized.selector, outsider));
        factory.createCampaign(cfg);
    }

    function test_revertWhen_splitDoesNotSumTo10000() public {
        CampaignConfig memory cfg = _defaultConfig();
        cfg.split.feeBps = 600;
        _expectInvalid(cfg, abi.encodeWithSelector(InvalidSplit.selector, 10_100));
    }

    function test_revertWhen_commitmentTooShort() public {
        CampaignConfig memory cfg = _defaultConfig();
        cfg.commitmentUnits = 35;
        _expectInvalid(cfg, abi.encodeWithSelector(CommitmentTooShort.selector, 35, 36));
    }

    function test_revertWhen_anchorBpsTooHigh() public {
        CampaignConfig memory cfg = _defaultConfig();
        cfg.anchorBps = 10_001;
        _expectInvalid(cfg, abi.encodeWithSelector(InvalidAnchorBps.selector, 10_001));
    }

    function test_revertWhen_fundingDeadlineNotInFuture() public {
        CampaignConfig memory cfg = _defaultConfig();
        cfg.fundingDeadline = uint64(_now());
        _expectInvalid(cfg, abi.encodeWithSelector(InvalidDeadlines.selector));
    }

    function test_revertWhen_claimDeadlineBeforeFundingDeadline() public {
        CampaignConfig memory cfg = _defaultConfig();
        cfg.claimDeadline = cfg.fundingDeadline - 1;
        _expectInvalid(cfg, abi.encodeWithSelector(InvalidDeadlines.selector));
    }

    function test_revertWhen_zeroTreeTarget() public {
        CampaignConfig memory cfg = _defaultConfig();
        cfg.treeTarget = 0;
        _expectInvalid(cfg, abi.encodeWithSelector(InvalidTreeTarget.selector));
    }

    function test_revertWhen_zeroTimeUnit() public {
        CampaignConfig memory cfg = _defaultConfig();
        cfg.timeUnit = 0;
        _expectInvalid(cfg, abi.encodeWithSelector(InvalidTimeUnit.selector));
    }

    function test_revertWhen_zeroPerPlanterCap() public {
        CampaignConfig memory cfg = _defaultConfig();
        cfg.perPlanterCap = 0;
        _expectInvalid(cfg, abi.encodeWithSelector(InvalidPerPlanterCap.selector));
    }

    function test_revertWhen_fundingTooSmallForEveryTree() public {
        CampaignConfig memory cfg = _defaultConfig();
        cfg.fundingTarget = 10; // 7 base units of incentives for 8 trees
        _expectInvalid(cfg, abi.encodeWithSelector(InvalidFundingTarget.selector));
    }

    function test_revertWhen_zeroCreator() public {
        CampaignConfig memory cfg = _defaultConfig();
        cfg.creator = address(0);
        vm.prank(operator);
        vm.expectRevert(ZeroAddress.selector);
        factory.createCampaign(cfg);
    }

    function test_validateConfigAcceptsDefaults() public view {
        factory.validateConfig(_defaultConfig());
    }

    function test_constructorsRejectZeroAddresses() public {
        vm.expectRevert(ZeroAddress.selector);
        new CampaignFactory(roles, address(0));
        vm.expectRevert(ZeroAddress.selector);
        new CampaignFactory(TreecordRoles(address(0)), address(campaignImpl));
        vm.expectRevert(ZeroAddress.selector);
        new Campaign(roles, IERC20(address(0)), ITreeRegistry(address(registry)));
        vm.expectRevert(ZeroAddress.selector);
        new Campaign(roles, IERC20(address(usdc)), ITreeRegistry(address(0)));
    }

    function test_implementationCannotBeInitialized() public {
        vm.expectRevert();
        campaignImpl.initialize(_defaultConfig());
    }

    function test_cloneCannotBeReinitialized() public {
        Campaign c = _newCampaign();
        vm.expectRevert();
        c.initialize(_defaultConfig());
    }

    function _expectInvalid(CampaignConfig memory cfg, bytes memory err) internal {
        vm.expectRevert(err);
        factory.validateConfig(cfg);
        vm.prank(cfg.creator);
        vm.expectRevert(err);
        factory.createCampaign(cfg);
    }
}
