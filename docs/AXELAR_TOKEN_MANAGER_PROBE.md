# Axelar token-manager compatibility probe

`probe_token_manager(token, chain)` on the Soroban Axelar adapter is a read-only view. It reports
whether a local token can be activated for paid ITS dispatch to a linked chain, and why not when
it can't. It returns a versioned `TokenManagerProbe` (`TOKEN_MANAGER_PROBE_VERSION = 1`).

It writes no storage, extends no TTL and publishes no event. Calling it twice returns the same
report.

## What establishes each capability

Every rail fact in the report comes from a real call to the configured ITS contract, made while
the report is built. Configuration, names and symbols never stand in for a read.

| Capability     | Established by                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| Token ID       | The adapter's forward mapping (token to id) and reverse mapping (id to token), read without TTL bump. |
| Rail mapping   | `registered_token_address(token_id)` must return exactly `token`.                                    |
| Manager type   | `token_manager_type(token_id)`, read as its raw `u32` discriminant.                                  |
| Manager        | `deployed_token_manager(token_id)`. Required only for `LockUnlock` (or an unknown type).              |
| Remote trust   | The local link, the local enable switch, and `is_trusted_chain(axelar_chain)` returning `true`.       |
| Admission      | The stored destination capability, bound to the current link and token id and matching the live manager type. |
| Paid send      | The `AxelarIts` route, plus `native_token_address()` answering with the gas token.                    |

Each call's outcome is recorded in `reads` as `Available`, `Rejected` (a contract error),
`Unavailable` (the call aborted: missing method, trap or host failure), `Malformed` (wrong return
type) or `NotRead` (a needed local input was missing).

The probe never calls `interchain_transfer`, because that entry point moves funds and has no
read-only form. After the probe reports `ready`, confirm it by simulating the paid dispatch
itself (`bridge_out_with_gas`) and inspecting the auth tree with `paid_dispatch_auth_spec`.

## Blockers

`ready` is true only when `blockers` is empty. Blockers are reported in this fixed order:

| Blocker                          | Meaning                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `TokenNotMapped`                 | No local token id. No token-scoped rail read is attempted.                      |
| `ReverseMappingMismatch`         | The token id does not map back to this token.                                   |
| `UnregisteredTokenId`            | ITS returned no registered asset for the id.                                    |
| `RailTokenMismatch(registered)`  | ITS registered a different contract.                                            |
| `ManagerTypeUnreadable`          | ITS returned no readable manager type.                                          |
| `UnknownManagerType(raw)`        | ITS reported a manager type this build has not reviewed.                        |
| `ManagerUnavailable`             | A `LockUnlock` token has no readable deployed manager.                          |
| `ChainNotLinked`                 | The chain is not linked on this adapter.                                        |
| `ChainDisabled`                  | The chain is emergency-disabled.                                                |
| `ChainNotTrusted`                | ITS does not report the Axelar chain as trusted.                                |
| `CapabilityNotAdmitted`          | No destination capability is bound to this exact link and token id.            |
| `CapabilityStale(admitted)`      | The admitted manager type differs from what ITS reports now.                    |
| `PaidSendUnsupportedRoute`       | This instance is the GMP route, which never sends paid.                         |
| `MethodUnavailable(method)`      | A required method is missing or answered with the wrong type.                   |

Some rules matter in practice:

- **Symbols never qualify a mapping.** The probe never reads a token's symbol, name or decimals.
  A lookalike with identical metadata either is not mapped (`TokenNotMapped`) or is caught as
  `RailTokenMismatch`.
- **Unknown manager types block.** The manager type decides who the outbound authorization names.
  An unreviewed discriminant is reported raw and is never mapped to the nearest known type.
- **Missing methods block.** Soroban can't tell a missing method from one that trapped, and the
  probe doesn't try to; neither counts as support. For token-scoped reads, a failure is reported
  as missing data (for example `UnregisteredTokenId`), because an unknown token id looks the same
  as a missing method. A wrongly typed answer is always `MethodUnavailable`.

## Compatibility and migration

- **Additive surface.** The change adds `probe_token_manager`, and its types live in
  `hyperion-core::axelar` (`TokenManagerProbe`, `ProbeBlocker`, `MethodRead`, `ReadStatus`,
  `TokenManagerType::from_raw`). `soroban-axelar-adapter.cap` records the new method. No
  existing method, argument, storage key, event or error number changed. Dispatch, replay
  protection, recipient-bound claims and exact-amount checks are untouched.
- **Upgrade.** A deployed adapter gets the probe only through a WASM upgrade. No storage
  migration is needed. The probe reads existing mappings, links and admitted capabilities as they
  are.
- **Versioning.** Consumers must check `version`. Adding or reinterpreting a field or blocker
  bumps `TOKEN_MANAGER_PROBE_VERSION`.
- **Not an activation.** A `ready` report is diagnostic evidence, not permission. The active
  deployment is still Stellar Testnet outbound ITS/CCTP. GMP inbound, EVM and other rail paths
  stay gated until independently validated.
- **EVM.** `AxelarItsAdapter.sol` is unchanged. It is a gated development adapter. An EVM
  equivalent would need its own probe plus ABI and capability-snapshot regeneration, both of which
  need Foundry.
