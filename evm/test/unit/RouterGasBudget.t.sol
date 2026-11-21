// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    ActionKind,
    AdminAction,
    ClaimSettlementResult,
    ClaimSettlementStatus,
    Origin,
    RouteKind
} from "../../src/HyperionTypes.sol";
import {Fixture} from "../Fixture.sol";

contract RouterGasBudgetTest is Fixture {
    uint256 private constant GAS_TOLERANCE_BPS = 2_500;
    uint256 private constant GOVERNANCE_ACTIONS = 16;
    uint256 private constant CLAIM_GROWTH = 32;
    uint256 private constant SETTLEMENT_BATCH = 10;
    uint256 private constant DELIVERY_AMOUNT = 500e6;

    uint256 private constant QUEUE_BASELINE = 250_000;
    uint256 private constant EXECUTE_BASELINE = 150_000;
    uint256 private constant INBOUND_NORMAL_COLD_BASELINE = 180_000;
    uint256 private constant INBOUND_NORMAL_WARM_BASELINE = 140_000;
    uint256 private constant INBOUND_PARKED_COLD_BASELINE = 300_000;
    uint256 private constant INBOUND_PARKED_WARM_BASELINE = 250_000;
    uint256 private constant SETTLEMENT_NORMAL_COLD_BASELINE = 1_000_000;
    uint256 private constant SETTLEMENT_NORMAL_WARM_BASELINE = 900_000;
    uint256 private constant SETTLEMENT_HOSTILE_COLD_BASELINE = 350_000;
    uint256 private constant SETTLEMENT_HOSTILE_WARM_BASELINE = 300_000;

    function test_governanceGasBudgetAtGrowingActionCount() public {
        uint64[] memory ids = new uint64[](GOVERNANCE_ACTIONS);
        for (uint256 i; i < GOVERNANCE_ACTIONS; ++i) {
            AdminAction memory action = _empty(ActionKind.SetFeeBps);
            action.amount = 20 + i;
            uint256 gasUsed;
            (ids[i], gasUsed) = _queue(action);
            if (i == 0) _report("governance.queue.first_new_record", gasUsed, QUEUE_BASELINE);
            if (i == GOVERNANCE_ACTIONS - 1) {
                _report("governance.queue.after_16_actions", gasUsed, QUEUE_BASELINE);
            }
        }

        vm.warp(block.timestamp + TIMELOCK + 1);
        for (uint256 i; i < GOVERNANCE_ACTIONS; ++i) {
            uint256 gasUsed = _execute(ids[i]);
            if (i == 0) _report("governance.execute.first_record", gasUsed, EXECUTE_BASELINE);
            if (i == GOVERNANCE_ACTIONS - 1) {
                _report("governance.execute.after_16_actions", gasUsed, EXECUTE_BASELINE);
            }
        }
    }

    function test_inboundClaimAndSettlementGasBudgetsAtGrowingState() public {
        (uint64 normalClaim, uint256 gasUsed) = _deliver(bob, 1);
        assertEq(normalClaim, 0);
        _report("inbound.normal.first", gasUsed, INBOUND_NORMAL_COLD_BASELINE);

        (normalClaim, gasUsed) = _deliver(bob, 2);
        assertEq(normalClaim, 0);
        _report("inbound.normal.shared_storage_warm", gasUsed, INBOUND_NORMAL_WARM_BASELINE);

        usdc.setBlocked(bob, true);
        uint64[] memory parked = new uint64[](CLAIM_GROWTH);
        for (uint256 i; i < CLAIM_GROWTH; ++i) {
            uint64 claimId;
            (claimId, gasUsed) = _deliver(bob, uint64(i + 3));
            parked[i] = claimId;
            assertEq(parked[i], i + 1);
            if (i == 0) _report("inbound.parked.first_claim", gasUsed, INBOUND_PARKED_COLD_BASELINE);
            if (i == CLAIM_GROWTH - 1) {
                _report("inbound.parked.after_32_claims", gasUsed, INBOUND_PARKED_WARM_BASELINE);
            }
        }

        usdc.setBlocked(bob, false);
        uint64[] memory firstBatch = _claimRange(1, SETTLEMENT_BATCH);
        ClaimSettlementResult[] memory results;
        (results, gasUsed) = _settle(firstBatch);
        _assertSettled(results, ClaimSettlementStatus.Settled);
        _report("settlement.normal.cold_claims_batch_10", gasUsed, SETTLEMENT_NORMAL_COLD_BASELINE);

        uint64[] memory secondBatch = _claimRange(11, SETTLEMENT_BATCH);
        (results, gasUsed) = _settle(secondBatch);
        _assertSettled(results, ClaimSettlementStatus.Settled);
        _report("settlement.normal.warm_shared_storage_batch_10", gasUsed, SETTLEMENT_NORMAL_WARM_BASELINE);

        usdc.setBlocked(alice, true);
        for (uint64 i; i < 4; ++i) {
            (normalClaim,) = _deliver(alice, 100 + i);
            assertEq(normalClaim, 33 + i);
        }

        (results, gasUsed) = _settle(_claimRange(33, 2));
        _assertSettled(results, ClaimSettlementStatus.RecipientRestricted);
        _report("settlement.hostile.cold_claims_batch_2", gasUsed, SETTLEMENT_HOSTILE_COLD_BASELINE);

        (results, gasUsed) = _settle(_claimRange(35, 2));
        _assertSettled(results, ClaimSettlementStatus.RecipientRestricted);
        _report("settlement.hostile.warm_shared_storage_batch_2", gasUsed, SETTLEMENT_HOSTILE_WARM_BASELINE);
    }

    function _queue(AdminAction memory action) private returns (uint64 id, uint256 gasUsed) {
        vm.prank(admin);
        uint256 gasBefore = gasleft();
        id = router.queueAction(action);
        gasUsed = gasBefore - gasleft();
    }

    function _execute(uint64 id) private returns (uint256 gasUsed) {
        vm.prank(admin);
        uint256 gasBefore = gasleft();
        router.executeAction(id);
        gasUsed = gasBefore - gasleft();
    }

    function _deliver(address recipient, uint64 nonce) private returns (uint64 claimId, uint256 gasUsed) {
        Origin memory origin = Origin({
            chain: STELLAR,
            nonce: nonce,
            messageId: keccak256(abi.encode("gas-budget-message", nonce)),
            sender: keccak256(abi.encode("gas-budget-sender", nonce))
        });
        vm.prank(railReceiver);
        uint256 gasBefore = gasleft();
        claimId = router.bridgeIn(RouteKind.Cctp, address(usdc), DELIVERY_AMOUNT, recipient, origin);
        gasUsed = gasBefore - gasleft();
    }

    function _settle(uint64[] memory claimIds)
        private
        returns (ClaimSettlementResult[] memory results, uint256 gasUsed)
    {
        uint256 gasBefore = gasleft();
        results = router.settleClaims(claimIds);
        gasUsed = gasBefore - gasleft();
    }

    function _claimRange(uint64 first, uint256 count) private pure returns (uint64[] memory claimIds) {
        claimIds = new uint64[](count);
        for (uint256 i; i < count; ++i) claimIds[i] = first + uint64(i);
    }

    function _assertSettled(
        ClaimSettlementResult[] memory results,
        ClaimSettlementStatus expected
    ) private pure {
        for (uint256 i; i < results.length; ++i) assertEq(uint8(results[i].status), uint8(expected));
    }

    function _report(string memory caseName, uint256 gasUsed, uint256 baseline) private {
        uint256 budget = baseline + (baseline * GAS_TOLERANCE_BPS / 10_000);
        emit log_named_uint(string.concat("HYPERION_GAS case=", caseName), gasUsed);
        emit log_named_uint(string.concat("HYPERION_GAS_BUDGET case=", caseName), budget);
        assertLe(gasUsed, budget, string.concat(caseName, " exceeded its gas budget"));
    }
}
