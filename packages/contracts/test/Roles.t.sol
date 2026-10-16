// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {TreecordRoles} from "../src/TreecordRoles.sol";
import {AlreadySet, ZeroAddress} from "../src/libraries/TreecordTypes.sol";
import {TestBase} from "./utils/TestBase.sol";

contract RolesTest is TestBase {
    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(ZeroAddress.selector);
        new TreecordRoles(address(0), treasury);
        vm.expectRevert(ZeroAddress.selector);
        new TreecordRoles(admin, address(0));
    }

    function test_wiringIsSet() public view {
        assertEq(roles.factory(), address(factory));
        assertEq(roles.treeRegistry(), address(registry));
        assertEq(roles.gateway(), address(gateway));
        assertEq(roles.carbonLedger(), address(ledger));
        assertEq(roles.treasury(), treasury);
        assertTrue(roles.hasRole(roles.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(roles.hasRole(roles.OPERATOR_ROLE(), operator));
        assertTrue(roles.hasRole(roles.ATTESTER_ROLE(), attester));
        assertTrue(roles.hasRole(roles.ISSUER_ROLE(), operator));
    }

    function test_componentsAreSetOnce() public {
        vm.startPrank(admin);
        vm.expectRevert(AlreadySet.selector);
        roles.setFactory(outsider);
        vm.expectRevert(AlreadySet.selector);
        roles.setTreeRegistry(outsider);
        vm.expectRevert(AlreadySet.selector);
        roles.setGateway(outsider);
        vm.expectRevert(AlreadySet.selector);
        roles.setCarbonLedger(outsider);
        vm.stopPrank();
    }

    function test_componentsRejectZeroAddress() public {
        TreecordRoles fresh = new TreecordRoles(admin, treasury);
        vm.startPrank(admin);
        vm.expectRevert(ZeroAddress.selector);
        fresh.setFactory(address(0));
        vm.expectRevert(ZeroAddress.selector);
        fresh.setTreeRegistry(address(0));
        vm.expectRevert(ZeroAddress.selector);
        fresh.setGateway(address(0));
        vm.expectRevert(ZeroAddress.selector);
        fresh.setCarbonLedger(address(0));
        vm.expectRevert(ZeroAddress.selector);
        fresh.setTreasury(address(0));
        vm.stopPrank();
    }

    function test_setTreasury() public {
        vm.expectEmit(address(roles));
        emit TreecordRoles.TreasuryUpdated(treasury, outsider);
        vm.prank(admin);
        roles.setTreasury(outsider);
        assertEq(roles.treasury(), outsider);
    }

    function test_onlyAdminCanWire() public {
        bytes32 adminRole = roles.DEFAULT_ADMIN_ROLE();
        bytes memory err =
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, adminRole);
        vm.startPrank(outsider);
        vm.expectRevert(err);
        roles.setTreasury(outsider);
        vm.expectRevert(err);
        roles.setFactory(outsider);
        vm.expectRevert(err);
        roles.setTreeRegistry(outsider);
        vm.expectRevert(err);
        roles.setGateway(outsider);
        vm.expectRevert(err);
        roles.setCarbonLedger(outsider);
        vm.stopPrank();
    }
}
