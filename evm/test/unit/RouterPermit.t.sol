// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {OutboundRequest, RouteKind} from "../../src/HyperionTypes.sol";
import {IHyperionRouter} from "../../src/interfaces/IHyperionRouter.sol";
import {Fixture} from "../Fixture.sol";
import {MockRailAdapter} from "../mocks/MockRailAdapter.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {ERC20Permit} from "openzeppelin/token/ERC20/extensions/ERC20Permit.sol";
import {ReentrancyGuard} from "openzeppelin/utils/ReentrancyGuard.sol";

contract RouterPermitToken is ERC20Permit {
    IHyperionRouter private _callback;
    OutboundRequest private _replay;

    constructor() ERC20("Permit Coin", "PERMIT") ERC20Permit("Permit Coin") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function arm(IHyperionRouter callback, OutboundRequest calldata replay) external {
        _callback = callback;
        _replay = replay;
    }

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public override {
        super.permit(owner, spender, value, deadline, v, r, s);
        if (address(_callback) != address(0)) _callback.bridgeOut(_replay);
    }
}

contract RouterPermitTest is Fixture {
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    RouterPermitToken private permitToken;
    address private owner;
    uint256 private ownerKey;

    function setUp() public override {
        super.setUp();
        (owner, ownerKey) = makeAddrAndKey("permit-owner");
        permitToken = new RouterPermitToken();
        _registerToken(address(permitToken), 6, FLOW_LIMIT);
        permitToken.mint(owner, 10_000_000e6);
    }

    function _signature(address spender, uint256 value, uint256 deadline)
        private
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 body = keccak256(
            abi.encode(PERMIT_TYPEHASH, owner, spender, value, permitToken.nonces(owner), deadline)
        );
        return
            vm.sign(ownerKey, keccak256(abi.encodePacked("\x19\x01", permitToken.DOMAIN_SEPARATOR(), body)));
    }

    function _assertUntouched() private view {
        assertEq(permitToken.nonces(owner), 0);
        assertEq(permitToken.allowance(owner, address(router)), 0);
        assertEq(permitToken.balanceOf(owner), 10_000_000e6);
        assertEq(permitToken.balanceOf(treasury), 0);
        assertEq(router.outboundNonce(), 0);
        assertEq(cctpRail.callCount(), 0);
        assertEq(router.flowAvailable(address(permitToken), RouteKind.Cctp), FLOW_LIMIT);
    }

    function test_permit_binds_exact_fee_and_floored_debit_then_spends_allowance_once() public {
        OutboundRequest memory request = _tokenRequest(address(permitToken), 1_000_000_123, 4);
        uint256 gross = 1_000_000_100; // fee 1,000,000 plus representable net 999,000,100.
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signature(address(router), gross, deadline);
        assertEq(permitToken.allowance(owner, address(router)), 0);
        vm.prank(owner);
        assertEq(router.bridgeOutWithPermit(request, deadline, v, r, s), 1);
        assertEq(permitToken.balanceOf(owner), 10_000_000e6 - gross);
        assertEq(permitToken.balanceOf(treasury), 1_000_000);
        assertEq(permitToken.balanceOf(address(cctpRail)), 999_000_100);
        assertEq(permitToken.allowance(owner, address(router)), 0);
        assertEq(permitToken.nonces(owner), 1);
        assertEq(cctpRail.callCount(), 1);
    }

    function test_expired_permit_cannot_move_tokens_or_charge_flow() public {
        uint256 deadline = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) = _signature(address(router), 1000e6, deadline);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ERC20Permit.ERC2612ExpiredSignature.selector, deadline));
        router.bridgeOutWithPermit(_tokenRequest(address(permitToken), 1000e6, 7), deadline, v, r, s);
        _assertUntouched();
    }

    function test_permit_for_another_spender_cannot_dispatch() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signature(stranger, 1000e6, deadline);
        vm.prank(owner);
        vm.expectPartialRevert(ERC20Permit.ERC2612InvalidSigner.selector);
        router.bridgeOutWithPermit(_tokenRequest(address(permitToken), 1000e6, 7), deadline, v, r, s);
        _assertUntouched();
    }

    function test_permit_for_a_larger_allowance_cannot_dispatch() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signature(address(router), 1000e6 + 1, deadline);
        vm.prank(owner);
        vm.expectPartialRevert(ERC20Permit.ERC2612InvalidSigner.selector);
        router.bridgeOutWithPermit(_tokenRequest(address(permitToken), 1000e6, 7), deadline, v, r, s);
        _assertUntouched();
    }

    function test_another_caller_cannot_dispatch_with_the_owners_permit() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signature(address(router), 1000e6, deadline);
        vm.prank(stranger);
        vm.expectPartialRevert(ERC20Permit.ERC2612InvalidSigner.selector);
        router.bridgeOutWithPermit(_tokenRequest(address(permitToken), 1000e6, 7), deadline, v, r, s);
        _assertUntouched();
    }

    function test_replayed_permit_cannot_dispatch_a_second_transfer() public {
        OutboundRequest memory request = _tokenRequest(address(permitToken), 1000e6, 7);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signature(address(router), 1000e6, deadline);
        vm.prank(owner);
        router.bridgeOutWithPermit(request, deadline, v, r, s);
        uint256 balance = permitToken.balanceOf(owner);
        uint256 available = router.flowAvailable(address(permitToken), RouteKind.Cctp);
        vm.prank(owner);
        vm.expectPartialRevert(ERC20Permit.ERC2612InvalidSigner.selector);
        router.bridgeOutWithPermit(request, deadline, v, r, s);
        assertEq(permitToken.balanceOf(owner), balance);
        assertEq(permitToken.nonces(owner), 1);
        assertEq(router.outboundNonce(), 1);
        assertEq(cctpRail.callCount(), 1);
        assertEq(router.flowAvailable(address(permitToken), RouteKind.Cctp), available);
    }

    function test_rail_failure_rolls_back_the_permit_nonce_allowance_and_fee() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signature(address(router), 1000e6, deadline);
        cctpRail.setDispatchReverts(true);
        vm.prank(owner);
        vm.expectRevert(MockRailAdapter.Rejected.selector);
        router.bridgeOutWithPermit(_tokenRequest(address(permitToken), 1000e6, 7), deadline, v, r, s);
        _assertUntouched();
    }

    function test_permit_callback_cannot_reenter_dispatch() public {
        OutboundRequest memory request = _tokenRequest(address(permitToken), 1000e6, 7);
        permitToken.arm(IHyperionRouter(address(router)), request);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signature(address(router), 1000e6, deadline);
        vm.prank(owner);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        router.bridgeOutWithPermit(request, deadline, v, r, s);
        _assertUntouched();
    }

    function test_non_permit_token_keeps_the_explicit_approval_path() public {
        vm.prank(alice);
        vm.expectRevert();
        router.bridgeOutWithPermit(
            _usdcRequest(1000e6), block.timestamp + 1 hours, 27, bytes32(0), bytes32(0)
        );
        assertEq(router.outboundNonce(), 0);
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(1000e6));
        assertEq(usdc.balanceOf(alice), 10_000_000e6 - 1000e6);
        assertEq(cctpRail.callCount(), 1);
    }

    function test_a_separately_submitted_permit_can_use_explicit_dispatch() public {
        OutboundRequest memory request = _tokenRequest(address(permitToken), 1000e6, 7);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signature(address(router), 1000e6, deadline);
        permitToken.permit(owner, address(router), 1000e6, deadline, v, r, s);
        vm.prank(owner);
        vm.expectPartialRevert(ERC20Permit.ERC2612InvalidSigner.selector);
        router.bridgeOutWithPermit(request, deadline, v, r, s);
        vm.prank(owner);
        router.bridgeOut(request);
        assertEq(permitToken.nonces(owner), 1);
        assertEq(permitToken.allowance(owner, address(router)), 0);
        assertEq(router.outboundNonce(), 1);
    }
}
