// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MalformedMessage, UnsupportedHookVersion} from "../../src/HyperionErrors.sol";
import {NotesHarness} from "../harness/LibHarness.sol";
import {Test} from "forge-std/Test.sol";

contract MalformedCorpusTest is Test {
    function test_sharedCorpusClassificationsAndFullWidthNonce() public {
        NotesHarness notes = new NotesHarness();
        bytes memory corpus = bytes(vm.readFile("../testdata/malformed-message-corpus.tsv"));
        uint256 start;
        uint256 cases;
        for (uint256 i; i <= corpus.length; ++i) {
            if (i != corpus.length && corpus[i] != "\n") continue;
            if (i > start && corpus[start] != "#") {
                string[4] memory row = _row(corpus, start, i);
                assertEq(row[1], "outbound", row[0]);
                bytes memory payload = vm.parseBytes(row[2]);
                try notes.decodeOutboundNote(payload) returns (address recipient, uint64 nonce) {
                    assertEq(row[3], "ok", row[0]);
                    assertEq(recipient, address(0xBEEF1), row[0]);
                    assertEq(
                        nonce,
                        keccak256(bytes(row[0])) == keccak256("outbound-wide-nonce")
                            ? type(uint64).max
                            : uint64(0x0102030405060708),
                        row[0]
                    );
                } catch (bytes memory reason) {
                    bytes4 expected = keccak256(bytes(row[3])) == keccak256("MalformedMessage")
                        ? MalformedMessage.selector
                        : UnsupportedHookVersion.selector;
                    assertTrue(
                        keccak256(bytes(row[3])) == keccak256("MalformedMessage")
                            || keccak256(bytes(row[3])) == keccak256("UnsupportedHookVersion"),
                        row[0]
                    );
                    assertEq(reason, abi.encodeWithSelector(expected), row[0]);
                }
                ++cases;
            }
            start = i + 1;
        }
        assertEq(cases, 5, "all shared corpus rows consumed");
    }

    function _row(bytes memory data, uint256 start, uint256 end)
        private
        pure
        returns (string[4] memory values)
    {
        uint256 field;
        uint256 fieldStart = start;
        for (uint256 i = start; i <= end; ++i) {
            if (i != end && data[i] != "|") continue;
            require(field < 4, "extra corpus field");
            bytes memory value = new bytes(i - fieldStart);
            for (uint256 j; j < value.length; ++j) {
                value[j] = data[fieldStart + j];
            }
            values[field++] = string(value);
            fieldStart = i + 1;
        }
        require(field == 4, "missing corpus field");
    }
}
