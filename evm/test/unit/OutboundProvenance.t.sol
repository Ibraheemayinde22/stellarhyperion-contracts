// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {InvalidAmount, Unauthorized} from "../../src/HyperionErrors.sol";
import {OutboundRecord} from "../../src/HyperionTypes.sol";
import {OutboundProvenance} from "../../src/OutboundProvenance.sol";
import {Test} from "forge-std/Test.sol";

contract OutboundProvenanceTest is Test {
    function test_onlyCreatingRouterCanCommitAndRecordsCannotBeRewritten() public {
        OutboundProvenance history = new OutboundProvenance();
        assertEq(history.ROUTER(), address(this));
        OutboundRecord memory record;
        record.nonce = 1;
        record.sender = address(0xA11CE);
        record.destinationChain = "stellar";
        record.destinationAddress = "immutable provenance";
        vm.prank(address(0xBAD));
        vm.expectRevert(Unauthorized.selector);
        history.commit(record);
        assertEq(history.outboundRecord(1).nonce, 0);
        history.commit(record);
        vm.expectRevert(InvalidAmount.selector);
        history.commit(record);
        assertEq(history.outboundRecord(1).sender, record.sender);
        assertEq(history.outboundRecord(1).destinationAddress, record.destinationAddress);
        record.nonce = 0;
        vm.expectRevert(InvalidAmount.selector);
        history.commit(record);
    }
}
