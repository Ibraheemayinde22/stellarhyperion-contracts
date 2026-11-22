// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Origin, OutboundRequest, RouteKind} from "../../src/HyperionTypes.sol";
import {Fixture} from "../Fixture.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockRailAdapter} from "../mocks/MockRailAdapter.sol";

contract RouterProviderFaultTest is Fixture {
    function test_sharedRustFaultVectorsPreserveU64WrapAndStageSalts() public {
        string[] memory rows = vm.split(vm.readFile("../testdata/provider-fault-vectors.tsv"), "\n");
        uint256 cases;
        for (uint256 i; i < rows.length; ++i) {
            bytes memory row = bytes(rows[i]);
            if (row.length == 0 || row[0] == "#") continue;
            string[] memory fields = vm.split(rows[i], "|");
            assertEq(fields.length, 3);
            uint256 seed = vm.parseUint(fields[0]);
            assertLe(seed, type(uint64).max);
            // The preceding assertion bounds this shared corpus value to u64.
            // forge-lint: disable-next-line(unsafe-typecast)
            _configureProviderFaults(uint64(seed));
            assertEq(providerFaults.dispatchMask, vm.parseUint(fields[1]));
            assertEq(providerFaults.inboundMask, vm.parseUint(fields[2]));
            ++cases;
        }
        assertEq(cases, 4);
    }

    function test_seedReplaysSameStageMasksAndAttemptFlags() public {
        uint256 requestedSeed = vm.envOr("HYPERION_FAULT_SEED", uint256(156));
        require(requestedSeed <= type(uint64).max, "fault seed exceeds uint64");
        // The checked seed must fit the shared Rust u64 schedule API.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 seed = uint64(requestedSeed);
        _configureProviderFaults(seed);
        ProviderFaultSchedule memory saved = providerFaults;
        if (seed == 156) {
            assertEq(saved.dispatchMask, 0xd1b1c0866b4b6016, "Rust dispatch stage mask");
            assertEq(saved.inboundMask, 0x41613ddf7b22f3a1, "Rust inbound stage mask");
        }
        bool[80] memory dispatch;
        bool[80] memory inbound;
        for (uint256 i; i < 80; ++i) {
            dispatch[i] = _nextProviderFault(PROVIDER_STAGE_DISPATCH);
            inbound[i] = _nextProviderFault(PROVIDER_STAGE_INBOUND);
        }
        _configureProviderFaults(seed);
        assertEq(providerFaults.dispatchMask, saved.dispatchMask);
        assertEq(providerFaults.inboundMask, saved.inboundMask);
        for (uint256 i; i < 80; ++i) {
            assertEq(_nextProviderFault(PROVIDER_STAGE_DISPATCH), dispatch[i]);
            assertEq(_nextProviderFault(PROVIDER_STAGE_INBOUND), inbound[i]);
            if (i >= 64) {
                assertEq(dispatch[i], dispatch[i - 64]);
                assertEq(inbound[i], inbound[i - 64]);
            }
        }
    }

    function test_seededScheduleDrivesRealDispatchAndInbound() public {
        uint256 requestedSeed = vm.envOr("HYPERION_FAULT_SEED", uint256(156));
        require(requestedSeed <= type(uint64).max, "fault seed exceeds uint64");
        usdc.mint(railReceiver, 10_000e6);
        vm.prank(railReceiver);
        usdc.approve(address(router), type(uint256).max);
        _setRailReceiver(RouteKind.AxelarIts, railReceiver);
        for (uint256 i; i < 2; ++i) {
            // requestedSeed was bounded to u64 before any fixture state changed.
            // forge-lint: disable-next-line(unsafe-typecast)
            _configureProviderFaults(uint64(requestedSeed));
            MockRailAdapter rail = i == 0 ? cctpRail : itsRail;
            RouteKind route = RouteKind(i);
            for (uint256 attempt; attempt < 8; ++attempt) {
                bool failed = _nextProviderFault(PROVIDER_STAGE_DISPATCH);
                rail.setDispatchReverts(failed);
                OutboundRequest memory request = _usdcRequest(100e6);
                request.route = route;
                BalanceSnapshot memory before_ = _snapshot(alice, bob);
                uint64 nonceBefore = router.outboundNonce();
                vm.prank(alice);
                if (failed) vm.expectRevert(MockRailAdapter.Rejected.selector);
                router.bridgeOutBounded(request, 0);
                assertEq(router.outboundNonce(), nonceBefore + (failed ? 0 : 1));
                _assertConserved(before_, _snapshot(alice, bob), "seeded provider dispatch");
                failed = _nextProviderFault(PROVIDER_STAGE_INBOUND);
                usdc.setBlocked(railReceiver, failed);
                Origin memory origin = Origin({
                    chain: STELLAR,
                    // The enclosing loop bounds attempt to 0 through 7.
                    // forge-lint: disable-next-line(unsafe-typecast)
                    nonce: uint64(attempt),
                    messageId: keccak256(abi.encode(i, attempt)),
                    sender: G_KEY
                });
                before_ = _snapshot(alice, bob);
                vm.prank(railReceiver);
                if (failed) vm.expectRevert(abi.encodeWithSelector(MockERC20.Frozen.selector, railReceiver));
                router.bridgeIn(route, address(usdc), 100e6, bob, origin);
                assertEq(router.processed(keccak256(abi.encode(route, origin.messageId))), !failed);
                _assertConserved(before_, _snapshot(alice, bob), "seeded provider inbound");
            }
            usdc.setBlocked(railReceiver, false);
        }
    }

    function test_scheduledFailuresRollBackBothPaidRailsAndAllowRetry() public {
        vm.deal(alice, 1 ether);
        for (uint256 i; i < 2; ++i) {
            providerFaults.dispatchMask = 1;
            providerFaults.dispatchAttempts = 0;
            MockRailAdapter rail = i == 0 ? cctpRail : itsRail;
            OutboundRequest memory request = _usdcRequest(1000e6);
            request.route = RouteKind(i);
            BalanceSnapshot memory before_ = _snapshot(alice, bob);
            uint64 nonceBefore = router.outboundNonce();
            uint256 flowBefore = router.flowAvailable(address(usdc), request.route);
            rail.setDispatchReverts(_nextProviderFault(PROVIDER_STAGE_DISPATCH));
            vm.prank(alice);
            vm.expectRevert(MockRailAdapter.Rejected.selector);
            router.bridgeOutBounded{value: 0.2 ether}(request, 0.2 ether);
            _assertConserved(
                before_,
                _snapshot(alice, bob),
                i == 0 ? "CCTP scheduled dispatch failure" : "ITS scheduled dispatch failure"
            );
            assertEq(router.outboundNonce(), nonceBefore);
            assertEq(router.outboundRecord(nonceBefore + 1).nonce, 0);
            assertEq(router.flowAvailable(address(usdc), request.route), flowBefore);
            assertEq(rail.callCount(), 0);
            rail.setDispatchReverts(_nextProviderFault(PROVIDER_STAGE_DISPATCH));
            vm.prank(alice);
            uint64 nonce = router.bridgeOutBounded{value: 0.2 ether}(request, 0.2 ether);
            assertEq(nonce, nonceBefore + 1);
            assertEq(rail.callCount(), 1);
            _assertConserved(before_, _snapshot(alice, bob), "scheduled dispatch successful retry");
        }
    }

    function test_scheduledInboundFailureRollsBackReplayAndRecipientThenRetries() public {
        providerFaults.inboundMask = 1;
        providerFaults.inboundAttempts = 0;
        _setRailReceiver(RouteKind.AxelarIts, railReceiver);
        usdc.mint(railReceiver, 1000e6);
        vm.prank(railReceiver);
        usdc.approve(address(router), type(uint256).max);
        for (uint256 i; i < 2; ++i) {
            providerFaults.inboundAttempts = 0;
            Origin memory origin =
                Origin({chain: STELLAR, nonce: 7, messageId: bytes32(i + 1), sender: G_KEY});
            RouteKind route = RouteKind(i);
            BalanceSnapshot memory before_ = _snapshot(alice, bob);
            usdc.setBlocked(railReceiver, _nextProviderFault(PROVIDER_STAGE_INBOUND));
            vm.prank(railReceiver);
            vm.expectRevert(abi.encodeWithSelector(MockERC20.Frozen.selector, railReceiver));
            router.bridgeIn(route, address(usdc), 100e6, bob, origin);
            _assertConserved(before_, _snapshot(alice, bob), "scheduled inbound failure");
            assertFalse(router.processed(keccak256(abi.encode(route, origin.messageId))));
            assertEq(router.claimCount(), 0);
            usdc.setBlocked(railReceiver, _nextProviderFault(PROVIDER_STAGE_INBOUND));
            vm.prank(railReceiver);
            router.bridgeIn(route, address(usdc), 100e6, bob, origin);
            assertTrue(router.processed(keccak256(abi.encode(route, origin.messageId))));
            _assertConserved(before_, _snapshot(alice, bob), "scheduled inbound successful retry");
        }
    }
}
