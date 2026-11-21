// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Execute} from "../../script/Execute.s.sol";
import {Verify} from "../../script/Verify.s.sol";
import {HyperionRouter} from "../../src/HyperionRouter.sol";
import {ActionKind, AdminAction} from "../../src/HyperionTypes.sol";
import {Fixture} from "../Fixture.sol";

contract GuardianEvidenceHarness is Verify {
    function reconstruct(string calldata logs, address router, bytes32 role)
        external
        view
        returns (uint256 used, uint256 count, address first, bool activeFirst)
    {
        address[] memory members = new address[](128);
        bool[] memory active = new bool[](128);
        (used, count) = _applyGuardianLogs(logs, router, role, members, active, 0, 0);
        return (used, count, members[0], active[0]);
    }
}

contract DeploymentScriptRegressionTest is Fixture {
    string private constant RECORD = "deployments/unit-execution-record.json";

    function test_reportOnlyLeavesUnmappedPhaseOneUntouchedWithoutProviders() public {
        HyperionRouter fresh = _freshRouter();
        AdminAction memory action = _empty(ActionKind.SetFeeBps);
        action.amount = 20;
        vm.prank(admin);
        uint64 id = fresh.queueAction(action);
        _record(fresh, id);
        vm.setEnv("HYPERION_REPORT_ONLY", "true");
        Execute execute = new Execute();
        execute.run();
        assertFalse(fresh.queuedAction(id).executed);
        assertEq(fresh.feeBps(), FEE_BPS);
        vm.setEnv("HYPERION_REPORT_ONLY", "false");
    }

    function test_staleProviderFailsBeforeAnyActionOrBroadcast() public {
        HyperionRouter fresh = _freshRouter();
        AdminAction memory action = _empty(ActionKind.SetFeeBps);
        action.amount = 20;
        vm.prank(admin);
        uint64 id = fresh.queueAction(action);
        _record(fresh, id);
        vm.setEnv("HYPERION_REPORT_ONLY", "false");
        vm.warp(block.timestamp + TIMELOCK + 1);
        Execute execute = new Execute();
        vm.expectRevert("record token has no code");
        execute.run();
        assertFalse(fresh.queuedAction(id).executed);
        assertEq(fresh.feeBps(), FEE_BPS);
    }

    function test_actionIdBeyondUint64IsRejectedBeforeReportOrBroadcast() public {
        _record(router, uint256(type(uint64).max) + 1);
        vm.setEnv("HYPERION_REPORT_ONLY", "true");
        Execute execute = new Execute();
        vm.expectRevert("action id exceeds uint64");
        execute.run();
        vm.setEnv("HYPERION_REPORT_ONLY", "false");
    }

    function test_guardianEvidenceReconstructsZeroGrantDuplicateAndRevoke() public {
        GuardianEvidenceHarness harness = new GuardianEvidenceHarness();
        bytes32 role = router.GUARDIAN_ROLE();
        (uint256 used, uint256 count,,) = harness.reconstruct("[]", address(router), role);
        assertEq(used, 0);
        assertEq(count, 0);
        string memory grant = _event(keccak256("RoleGranted(bytes32,address,address)"), role, false, 4);
        (used, count,,) =
            harness.reconstruct(string.concat("[", grant, ",", grant, "]"), address(router), role);
        assertEq(used, 1);
        assertEq(count, 1, "hidden grant invalidates absent-guardian policy");
        string memory revoke = _event(keccak256("RoleRevoked(bytes32,address,address)"), role, false, 4);
        bool active;
        (used, count,, active) =
            harness.reconstruct(string.concat("[", grant, ",", revoke, "]"), address(router), role);
        assertEq(used, 1);
        assertEq(count, 0);
        assertFalse(active);
    }

    function test_guardianEvidenceFailsClosedForIncompleteWrongRoleAndRemovedLogs() public {
        GuardianEvidenceHarness harness = new GuardianEvidenceHarness();
        bytes32 role = router.GUARDIAN_ROLE();
        vm.expectRevert("guardian RPC did not return a complete bounded array");
        harness.reconstruct("[", address(router), role);
        vm.expectRevert("guardian event identity differs");
        harness.reconstruct(
            string.concat(
                "[", _event(keccak256("RoleGranted(bytes32,address,address)"), bytes32(0), false, 4), "]"
            ),
            address(router),
            role
        );
        vm.expectRevert("removed guardian event is not canonical evidence");
        harness.reconstruct(
            string.concat("[", _event(keccak256("RoleGranted(bytes32,address,address)"), role, true, 4), "]"),
            address(router),
            role
        );
        vm.expectRevert("guardian event identity differs");
        harness.reconstruct(
            string.concat(
                "[", _event(keccak256("RoleGranted(bytes32,address,address)"), role, false, 3), "]"
            ),
            address(router),
            role
        );
    }

    function _record(HyperionRouter target, uint256 id) private {
        vm.setEnv("HYPERION_RECORD", RECORD);
        vm.writeFile(
            RECORD,
            string.concat(
                "{\"chainId\":",
                vm.toString(block.chainid),
                ",\"router\":\"",
                vm.toString(address(target)),
                "\",\"queuedActionIds\":[",
                vm.toString(id),
                "],\"queuedActions\":[\"reviewed action\"],\"token\":\"",
                vm.toString(stranger),
                "\"}"
            )
        );
    }

    function _event(bytes32 kind, bytes32 role, bool removed, uint256 topics)
        private
        view
        returns (string memory)
    {
        return string.concat(
            "{\"address\":\"",
            vm.toString(address(router)),
            "\",\"topics\":[\"",
            vm.toString(kind),
            "\",\"",
            vm.toString(role),
            "\",\"",
            vm.toString(bytes32(uint256(uint160(guardian)))),
            topics == 4 ? string.concat("\",\"", vm.toString(bytes32(uint256(uint160(admin))))) : "",
            "\"],\"removed\":",
            removed ? "true" : "false",
            ",\"data\":\"0x\"}"
        );
    }
}
