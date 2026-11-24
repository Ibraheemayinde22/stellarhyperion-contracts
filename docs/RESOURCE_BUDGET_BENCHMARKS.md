# Resource budget benchmarks

The fixture executes quote, outbound dispatch, inbound delivery, and settlement through the
native router with controlled rail/token contracts. Soroban host counters report CPU instruction
charges and memory charges. These are native regression measurements; they include host work
and cross-contract fixture calls, and exclude WASM VM instruction execution. Public-network
simulation must supply the complete transaction budget before deployment or signing.

## Reproduce

Use the committed lockfile and the workspace's declared Rust toolchain:

```sh
cd soroban
cargo test --locked -p hyperion-router \
  print_reproducible_quote_dispatch_inbound_and_settlement_budgets -- --nocapture
```

Each fresh world finishes setup and serializes its arguments before measuring. `input_bytes`
is the actual XDR-encoded ScVal argument vector for the measured router call, including the
request or recipient/origin fields. It excludes the transaction envelope, signatures,
authorization entries and resource footprint. Funding the inbound receiver is setup work and
is excluded from the inbound row.

The current native baseline uses `soroban-env-host` 29.0.1, ledger protocol 29 and the committed
lockfile. The command prints this runner information with every report:

| Operation         | Argument XDR bytes | Existing claims | CPU charge | Memory charge |
| ----------------- | -----------------: | --------------: | ---------: | ------------: |
| Quote             |                 80 |               0 |    468,082 |       130,912 |
| Dispatch          |                388 |               0 |  1,890,749 |       570,860 |
| Inbound           |                416 |               0 |    908,242 |       260,088 |
| Single settlement |                 64 |               1 |    711,496 |       270,034 |
| Single settlement |                 64 |              32 |  1,038,833 |       388,082 |

The settlement comparison prints a CPU delta of 327,337 and memory delta of 118,048 for 32
claims versus one. The fixture creates the claims through real router delivery with a blocked
recipient, then unblocks that recipient and settles the same numbered claim. It checks that
both charges stay within twice the one-claim baseline, catching an unintended registry scan.
It preserves exact integer amounts and never seeds synthetic claim records.

Keep the raw `HYPERION_BUDGET` rows and `HYPERION_BUDGET_COMPARISON` with the tested Git revision.
Re-run after changes to source, compiler, host, protocol or fixture assumptions; a report from
another runner is a new baseline. The host ledger/snapshot machinery also contributes to native
costs, so these values do not establish live network fees or deployment acceptance.

## Bounded wire inputs

The parser-limit fixture and the `script/anvil-e2e.sh` report cover these maximum supported
payload sizes. The report compares Rust, Solidity and SDK declarations before the local EVM
rehearsal proceeds.

| Input | Rust | Solidity | SDK | Behavior above limit |
| ----- | ---: | ---: | ---: | -------------------- |
| Muxed StrKey | 69 bytes | 69 bytes | 69 bytes | Reject destination |
| Inbound note | 80 bytes | 80 bytes | 80 bytes | Reject before note parsing/copy |
| CCTP hook | 46 bytes | 38 or 46 bytes written | 46 bytes | Reject on Soroban/SDK; EVM hook encoding is fixed-width |
| Cancellation audit note | 128 printable ASCII bytes | 128 printable ASCII bytes | 128 printable ASCII bytes | Reject before cancellation state changes |
| Queued destination-limit action chain | 64 bytes | 64-byte ITS chain cap | 64 bytes | Reject before queue insertion |
| CCTP burn body / full message | 270 / 418 bytes | Not parsed on EVM | N/A | Reject above supported Soroban message envelope |

The maximums preserve the existing wire layouts: classic StrKeys remain 56 characters, muxed
StrKeys 69, inbound notes 80, and revision-bound CCTP hooks 38 or 46. A single additional byte does not become
an alternate encoding. Oversized CCTP messages are rejected before slicing or reading fields, and
the hook remains bounded before destination decoding. The Rust limit fixture reports CPU charges
for a 4,096-byte invalid CCTP message; input construction is outside the measured interval.

Reproduce the focused fixtures with:

```sh
cd soroban
cargo test --locked -p hyperion-router resource_limits -- --nocapture

cd ../evm
forge test --match-contract HyperionNotesTest
forge test --match-contract RouterAdminTest

cd ../packages/protocol
npm test -- test/notes.test.ts test/timelock.test.ts test/parity.test.ts
```

These are parser and audit-metadata bounds, not deployment activation. No storage schema,
payout ABI, event layout, amount representation, authenticated rail dispatch, replay identity or
recipient-bound claim changes. Existing stored actions and claims need no migration. Producers
must reject rather than truncate oversized payloads; newly submitted destination-flow-limit
actions with chain identifiers over 64 bytes are refused, while an oversized cancellation note
leaves its action queued and cancellable with a valid note. The active
deployment remains Stellar Testnet outbound ITS/CCTP; EVM and other rails remain independently
gated.

The separate actual-WASM `discovery::measure_bounded_replay_upkeep_resources_and_exact_ttl`
fixture must use the final production build. It covers bounded one/32-entry upkeep and exact
TTL, and retains the unchanged WASM deployment-size gate.

With `HYPERION_MEASURE_ROUTER_WASM` set to the final 65,498-byte router artifact
(SHA-256 `392a06a93deac77a41d71dbb0a14d526084c41769e78c26b09470f31ec0a03c8`),
the actual-WASM upkeep fixture reports:

| Replay entries | CPU charge | Memory charge | VM/host instructions | Persistent rent bumps |
| -------------- | ---------: | ------------: | -------------------: | --------------------: |
| 1              |    816,218 |     1,576,465 |              737,665 |                     1 |
| 32             |  4,230,935 |     2,150,244 |            3,849,846 |                    32 |

Every replay ledger entry encodes to 144 XDR bytes, and each retained key reaches the exact
`REPLAY_BUMP_TO` TTL. These are local host/VM fixture measurements with configured contract
code and instance storage; they do not establish live network fee or footprint acceptance.
