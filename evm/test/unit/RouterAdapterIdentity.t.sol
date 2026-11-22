// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AdapterCodeMissing,
    AdapterIdentityMismatch,
    AdapterMethodUnavailable,
    UpgradeableAdapterUnsupported
} from "../../src/HyperionErrors.sol";
import {ActionKind, AdminAction, RouteKind} from "../../src/HyperionTypes.sol";
import {Fixture} from "../Fixture.sol";
import {MockRailAdapter} from "../mocks/MockRailAdapter.sol";
import {ERC1967Proxy} from "openzeppelin/proxy/ERC1967/ERC1967Proxy.sol";

contract AdapterInterfaceProbe {
    address public immutable ROUTER;
    RouteKind private immutable ROUTE;
    uint256 private immutable MODE;

    constructor(address router, RouteKind route_, uint256 mode) {
        ROUTER = router;
        ROUTE = route_;
        MODE = mode;
    }

    function route() external view returns (RouteKind) {
        return ROUTE;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        return _probe();
    }

    function _probe() private view returns (bytes memory) {
        if (MODE == 0) return "";
        if (MODE == 1) return abi.encode(uint256(2));
        if (MODE == 2) return abi.encode(address(1));
        if (MODE == 4) return abi.encode(uint256(0));
        revert();
    }
}

contract RouterAdapterIdentityTest is Fixture {
    function test_hiddenProxyImplementationIsNotCertifiedByRuntimeHash() public {
        MockRailAdapter implementation = new MockRailAdapter(RouteKind.Cctp, address(router));
        ERC1967Proxy proxy =
            new ERC1967Proxy(address(implementation), abi.encodeCall(MockRailAdapter.setRefund, (0)));
        _setAdapter(RouteKind.Cctp, address(proxy));
        bytes32 reviewedShell = router.adapterCodeHash(RouteKind.Cctp);
        AdapterInterfaceProbe replacement = new AdapterInterfaceProbe(address(router), RouteKind.Cctp, 4);
        vm.store(
            address(proxy),
            0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc,
            bytes32(uint256(uint160(address(replacement))))
        );
        assertEq(
            address(proxy).codehash, reviewedShell, "proxy shell is unchanged across implementation update"
        );
        assertEq(MockRailAdapter(payable(address(proxy))).ROUTER(), address(router));
        // Runtime hashing cannot certify hidden proxy storage or governance. Such candidates
        // require independent implementation/upgrade review before any activation approval.
    }

    function test_wrongRouterAndRouteCannotBeQueued() public {
        MockRailAdapter wrongRouter = new MockRailAdapter(RouteKind.Cctp, stranger);
        _refuse(address(wrongRouter), AdapterIdentityMismatch.selector);
        MockRailAdapter wrongRoute = new MockRailAdapter(RouteKind.AxelarIts, address(router));
        _refuse(address(wrongRoute), AdapterIdentityMismatch.selector);
    }

    function test_emptyCodeAndMissingOrNoncanonicalInterfaceCannotBeQueued() public {
        _refuse(stranger, AdapterCodeMissing.selector);
        _refuse(
            address(new AdapterInterfaceProbe(address(router), RouteKind.Cctp, 0)),
            AdapterMethodUnavailable.selector
        );
        _refuse(
            address(new AdapterInterfaceProbe(address(router), RouteKind.Cctp, 1)),
            AdapterMethodUnavailable.selector
        );
        _refuse(
            address(new AdapterInterfaceProbe(address(router), RouteKind.Cctp, 3)),
            AdapterMethodUnavailable.selector
        );
    }

    function test_discoverableImplementationIsExplicitlyUnsupported() public {
        _refuse(
            address(new AdapterInterfaceProbe(address(router), RouteKind.Cctp, 2)),
            UpgradeableAdapterUnsupported.selector
        );
    }

    function test_runtimeIdentityIsCapturedAndChangesCannotDispatch() public {
        assertEq(router.adapterCodeHash(RouteKind.Cctp), address(cctpRail).codehash);
        vm.etch(address(cctpRail), hex"00");
        vm.prank(alice);
        vm.expectRevert(AdapterIdentityMismatch.selector);
        router.bridgeOut(_usdcRequest(1000e6));
        assertEq(router.outboundNonce(), 0);
    }

    function test_changedRuntimeDuringTimelockCannotActivate() public {
        MockRailAdapter candidate = new MockRailAdapter(RouteKind.Cctp, address(router));
        AdminAction memory action = _empty(ActionKind.SetAdapter);
        action.subject = address(candidate);
        uint64 id = _mature(action);
        // This second adapter still passes the interface/router/route probes, but is different
        // reviewed runtime because its constructor binds another immutable route code path.
        AdapterInterfaceProbe replacement = new AdapterInterfaceProbe(address(router), RouteKind.Cctp, 4);
        vm.etch(address(candidate), address(replacement).code);
        vm.prank(admin);
        vm.expectRevert(AdapterIdentityMismatch.selector);
        router.executeAction(id);
        assertFalse(router.queuedAction(id).executed);
        assertEq(router.adapter(RouteKind.Cctp), address(cctpRail));
    }

    function _refuse(address candidate, bytes4 errorSelector) private {
        AdminAction memory action = _empty(ActionKind.SetAdapter);
        action.subject = candidate;
        vm.prank(admin);
        vm.expectRevert(errorSelector);
        router.queueAction(action);
    }
}
