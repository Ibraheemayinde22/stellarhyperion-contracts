// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {QueuedTokenRecovery} from "../HyperionTypes.sol";

/// @notice Timelocked recovery of accidental, unencumbered ERC20 custody held by the router.
interface ITokenRecoveryManager {
    event TokenRecoveryQueued(
        uint64 indexed id,
        address indexed token,
        address indexed recipient,
        uint256 amount,
        uint64 eta,
        uint64 expiresAt
    );
    event TokenRecoveryCancelled(uint64 indexed id, address indexed by);
    event TokenRecovered(
        uint64 indexed id, address indexed token, address indexed recipient, uint256 amount
    );

    function ROUTER() external view returns (address);
    function claimLiability(address token) external view returns (uint256);
    function recordClaim(address token, uint256 amount) external;
    function releaseClaim(address token, uint256 amount) external;
    function queueTokenRecovery(address token, address recipient, uint256 amount)
        external
        returns (uint64 id);
    function cancelTokenRecovery(uint64 id) external;
    function executeTokenRecovery(uint64 id) external;
    function queuedTokenRecovery(uint64 id) external view returns (QueuedTokenRecovery memory);
    function tokenRecoveryCount() external view returns (uint64);
}
