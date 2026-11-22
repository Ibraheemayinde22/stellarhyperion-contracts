// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    ActionFieldNotEmpty,
    AdapterCodeMissing,
    AdapterIdentityMismatch,
    AdapterMethodUnavailable,
    FeeTooHigh,
    InvalidDecimals,
    InvalidLimit,
    InvalidWindow,
    LimitNotRaised,
    TimelockDelayOutOfRange,
    TokenNotRegistered,
    Unauthorized,
    UpgradeableAdapterUnsupported,
    ZeroAddress
} from "./HyperionErrors.sol";
import {ActionKind, AdminAction, RouteKind, TokenConfig} from "./HyperionTypes.sol";
import {AmountMath} from "./libraries/AmountMath.sol";

/// @title Current router proposal constraints
/// @notice Read-only getters used by the immutable action validator.
interface IRouterActionState {
    /// @notice Read the router's current constraint.
    function tokenConfig(address token) external view returns (TokenConfig memory);
    /// @notice Read the router's current constraint.
    function MIN_TIMELOCK_DELAY() external view returns (uint64);
    /// @notice Read the router's current constraint.
    function MAX_TIMELOCK_DELAY() external view returns (uint64);
    /// @notice Read the router's current constraint.
    function MIN_FLOW_WINDOW() external view returns (uint64);
    /// @notice Read the router's current constraint.
    function MAX_FLOW_WINDOW() external view returns (uint64);
}

/// @title Immutable read-only governance action validation
/// @notice Evaluates the creating router's current configuration and candidate adapter probes.
/// It has no privileged call, storage writer, upgrade hook or authority over the router.
contract RouterActionValidator {
    /// @notice The fixed router whose proposals this validator checks.
    address public immutable ROUTER;

    /// @notice Bind the validator to the creating router.
    constructor() {
        ROUTER = msg.sender;
    }

    /// @notice Validate a proposal against the router's actual current state.
    function validate(AdminAction calldata action) external view {
        if (msg.sender != ROUTER) revert Unauthorized();
        IRouterActionState target = IRouterActionState(ROUTER);
        ActionKind kind = action.kind;

        bool usesRoute = kind == ActionKind.SetAdapter || kind == ActionKind.SetRailReceiver
            || kind == ActionKind.EnableRoute || kind == ActionKind.SetRouteFlowLimit;
        bool usesSubject = kind == ActionKind.SetTreasury || kind == ActionKind.SetAdmin
            || kind == ActionKind.SetGuardian || kind == ActionKind.SetAdapter
            || kind == ActionKind.SetRailReceiver || kind == ActionKind.RegisterToken
            || kind == ActionKind.RaiseTokenFlowLimit || kind == ActionKind.SetRouteFlowLimit
            || kind == ActionKind.SetTokenEnabled;
        bool usesAmount = kind == ActionKind.SetFeeBps || kind == ActionKind.EnableRoute
            || kind == ActionKind.RegisterToken || kind == ActionKind.RaiseTokenFlowLimit
            || kind == ActionKind.SetRouteFlowLimit || kind == ActionKind.SetTimelockDelay
            || kind == ActionKind.SetFlowWindow || kind == ActionKind.SetTokenEnabled;
        bool usesDecimals = kind == ActionKind.RegisterToken;

        if (!usesRoute && action.route != RouteKind.Cctp) revert ActionFieldNotEmpty();
        if (!usesSubject && action.subject != address(0)) revert ActionFieldNotEmpty();
        if (!usesAmount && action.amount != 0) revert ActionFieldNotEmpty();
        if (!usesDecimals && action.decimals != 0) revert ActionFieldNotEmpty();
        if (usesSubject && action.subject == address(0)) revert ZeroAddress();

        if (kind == ActionKind.SetFeeBps && action.amount > AmountMath.MAX_FEE_BPS) revert FeeTooHigh();
        if (kind == ActionKind.EnableRoute && action.amount > 1) revert InvalidLimit();
        if (kind == ActionKind.SetTokenEnabled) {
            if (action.amount > 1) revert InvalidLimit();
            if (!target.tokenConfig(action.subject).registered) revert TokenNotRegistered();
        }
        if (kind == ActionKind.RegisterToken) {
            if (action.decimals > AmountMath.MAX_DECIMALS) revert InvalidDecimals();
            (bool okDec, bytes memory retDec) =
                action.subject.staticcall(abi.encodeWithSignature("decimals()"));
            if (!okDec || retDec.length != 32 || abi.decode(retDec, (uint8)) != action.decimals) {
                revert InvalidDecimals();
            }
            (bool okBal, bytes memory retBal) =
                action.subject.staticcall(abi.encodeWithSignature("balanceOf(address)", ROUTER));
            if (!okBal || retBal.length != 32) {
                revert TokenNotRegistered();
            }
        }
        if (kind == ActionKind.RaiseTokenFlowLimit) {
            TokenConfig memory cfg = target.tokenConfig(action.subject);
            if (!cfg.registered) revert TokenNotRegistered();
            if (action.amount <= cfg.flowLimit) revert LimitNotRaised();
        }
        if (kind == ActionKind.SetTimelockDelay) {
            if (action.amount < target.MIN_TIMELOCK_DELAY() || action.amount > target.MAX_TIMELOCK_DELAY()) {
                revert TimelockDelayOutOfRange();
            }
        }
        if (kind == ActionKind.SetFlowWindow) {
            if (action.amount < target.MIN_FLOW_WINDOW() || action.amount > target.MAX_FLOW_WINDOW()) {
                revert InvalidWindow();
            }
        }
        if (kind == ActionKind.SetAdapter) _validateAdapter(action);
    }

    function _validateAdapter(AdminAction memory action) private view {
        if (action.subject.code.length == 0) revert AdapterCodeMissing();
        (bool okRouter, bytes memory routerData) =
            action.subject.staticcall(abi.encodeWithSignature("ROUTER()"));
        if (
            !okRouter || routerData.length != 32
                || abi.decode(routerData, (uint256)) != uint256(uint160(ROUTER))
        ) {
            revert AdapterIdentityMismatch();
        }
        address subject = action.subject;
        (bool okRoute, bytes memory routeData) = subject.staticcall(abi.encodeWithSignature("route()"));
        if (!okRoute || routeData.length != 32 || abi.decode(routeData, (uint256)) != uint256(action.route)) {
            revert AdapterIdentityMismatch();
        }
        (bool okSupports, bytes memory supportsData) =
            action.subject.staticcall(abi.encodeWithSignature("supportsChain(string)", ""));
        if (!okSupports || supportsData.length != 32 || abi.decode(supportsData, (uint256)) > 1) {
            revert AdapterMethodUnavailable();
        }
        (bool okImplementation, bytes memory implementationData) =
            action.subject.staticcall(abi.encodeWithSignature("implementation()"));
        if (
            okImplementation && implementationData.length == 32
                && abi.decode(implementationData, (uint256)) != 0
        ) {
            revert UpgradeableAdapterUnsupported();
        }
    }
}
