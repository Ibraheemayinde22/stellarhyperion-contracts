# CCTP fee accounting events

The Soroban CCTP adapter publishes a versioned fee accounting record next to each successful
burn and each successful mint. These records let a reconciler match what a user paid on the
source chain to what Circle deducted on the destination, using exact integers only.

The existing `cctp_out` (`Dispatched`) and `cctp_in` (`Received`) events are unchanged. The new
records use their own topics, so an indexer that only decodes the old events sees exactly what it
saw before.

## Outbound: `["hyperion", "cctp_fee_out", token, destination_domain]` (`BurnAccounted`)

Both burn entrypoints publish this record: `dispatch_revision` (plain burn) and
`dispatch_from_revision` (paid forwarding).

| Field                    | Type    | Meaning                                                                    |
| ------------------------ | ------- | -------------------------------------------------------------------------- |
| `version`                | `u32`   | `hyperion_core::cctp::FEE_ACCOUNTING_VERSION`, currently `1`.              |
| `router_nonce`           | `u64`   | The router's outbound nonce. Joins this record to `Dispatched` and the router event. |
| `source_decimals`        | `u32`   | Decimals of the Stellar asset. Every amount below is in its base units.    |
| `source_debit`           | `i128`  | Exact amount the adapter held for this burn and approved to Circle.       |
| `fee_budget`             | `i128`  | The `max_fee` given to Circle: the most the destination may deduct. Zero for finalized lanes, the lane's bps budget for fast lanes, and the caller's live budget for paid forwarding. |
| `burned`                 | `i128`  | Measured decrease of the adapter's balance across the messenger call.     |
| `retained`               | `i128`  | `source_debit - burned`: dust Circle normalized away. It stays in the adapter until `sweep` moves it to the treasury. |
| `forwarding`             | `bool`  | `true` for paid forwarding, `false` for a plain burn.                     |
| `min_finality_threshold` | `u32`   | The finality threshold requested for this burn.                           |

Invariants:

- `burned + retained == source_debit`, with `0 < burned <= source_debit`.
- `0 <= fee_budget < source_debit`.
- `burned` comes from the adapter's balance immediately before and after the messenger call, so
  dust already sitting in the adapter is never counted toward this burn.
- Amounts are never scaled, converted or rounded.

### Reconciling with the destination

Circle mints `burned - fee_executed` on the destination, where `fee_executed <= fee_budget` is
reported in the attested message. To reconcile, join on `router_nonce` (carried in the CCTP hook)
or on the Circle message, and check that `destination_minted + fee_executed == burned` and
`fee_executed <= fee_budget`. If the destination token uses different decimals, convert using the
mapping decimals published in `AssetMapped`.

## Inbound: `["hyperion", "cctp_fee_in", token, source_domain]` (`MintAccounted`)

| Field             | Type          | Meaning                                                               |
| ----------------- | ------------- | --------------------------------------------------------------------- |
| `version`         | `u32`         | `FEE_ACCOUNTING_VERSION`, currently `1`.                              |
| `nonce`           | `BytesN<32>`  | Circle's full nonce. This is the replay identity shared with `Received`. |
| `local_decimals`  | `u32`         | Decimals of the local mapped asset.                                   |
| `remote_decimals` | `u32`         | Decimals of the remote burn token in the mapping.                     |
| `burn_amount`     | `i128`        | Attested `amount`.                                                    |
| `fee_budget`      | `i128`        | Attested `max_fee`.                                                   |
| `fee_executed`    | `i128`        | Attested `fee_executed`: the destination deduction.                  |
| `minted`          | `i128`        | Measured mint delta handed to the router.                            |

Invariants: `minted + fee_executed == burn_amount` and `fee_executed <= fee_budget <= burn_amount`.
The receiver already enforced both before routing (`MintSettlement::from_burn` plus the exact
mint-delta check). The bounds and their `InvalidAmount` error are unchanged.

## Failure behaviour

A record is published only after these steps all succeed: the provider call, the measured
balance check and the allowance cleanup (outbound), or the exact mint check and router handoff
(inbound). A refusal or provider fault aborts the Soroban transaction, and that discards every
event from it, so a failed burn or mint never leaves committed accounting. On top of the existing
checks, a messenger that returns without pulling funds, or that pulls more than the debit, is
now refused with `InvalidAmount` instead of being reported as a successful burn.

Local fixtures in `hyperion-adapter-cctp/src/test/fee_accounting.rs` cover four failure cases: a
reverting messenger, a messenger that burns nothing, and a transmitter that under-mints, each
followed by a clean retry, plus the success cases with and without dust.

## Compatibility and migration

- **Indexers.** `Dispatched`, `Received`, `ApprovalAudited`, the configuration events and all
  their topics are byte-for-byte unchanged. The new topics are additive. Decoders should dispatch
  on `version` and reject versions they do not know. Any field change to either accounting event
  bumps `FEE_ACCOUNTING_VERSION`.
- **Contract interface.** No exported method, argument, return type, storage key or error number
  changed. The capability snapshot is unchanged.
- **Upgrade.** The adapter takes these events only through a WASM upgrade (`upgrade`). No storage
  migration is needed. Burns made before the upgrade have no accounting record. For those burns,
  use `Dispatched.amount` as an upper bound on the burned amount, because dust could not be
  measured then.
- **Size.** The extra events and checks add a few KB of unoptimized WASM. The adapter stays well
  inside the 64KB ledger limit.
- **EVM.** The EVM development adapter is finalized-only, always passes a zero fee budget and
  remains gated. This change does not alter it. Activating it, or adding fee tiers to it, needs
  its own accounting event and ABI parity regeneration.
- **Deployment gating.** The active deployment is still Stellar Testnet outbound ITS/CCTP. These
  events do not activate inbound CCTP or any EVM rail.
