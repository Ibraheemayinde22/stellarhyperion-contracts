# Axelar development evidence reconciliation

The read-only CLI compares an encoded Hyperion source note and its dispatch tuple with a supplied candidate ITS payment event. It moves no funds and performs no RPC requests. The active deployment remains Stellar Testnet outbound ITS/CCTP. Inbound, EVM and GMP execution still require independent deployment validation.

```sh
node script/stellar/reconcile-axelar.mjs --evidence evidence.json --strict
node script/stellar/reconcile-axelar.mjs --fixture script/stellar/test/fixtures/reconciliation/verified --strict
```

Input contains `sourceIntent` and `candidatePayment`. The source must specify `direction`, a complete encoded `note`, a nonzero 32-byte `tokenId`, a positive integer `amount`, and the full source `commandId` or `messageId`. The candidate must supply the matching recipient, token, amount and identity. Outbound command IDs are nonzero 32-byte hex; inbound message IDs are opaque, case-sensitive printable strings of 1–512 bytes. Conflicting command/message aliases are refused.

Amounts can use decimal strings or SDK bigints. Numeric JSON amounts must be safe integers. Negative, zero, fractional, coerced and greater-than-uint256 amounts are refused. Use decimal strings for amounts above `Number.MAX_SAFE_INTEGER`; equality after numeric rounding does not establish a match. The note's recipient is authoritative. An optional source recipient label must agree with it. Inbound Strkeys require a valid checksum, supported kind, nonzero key and canonical padding.

`verified: true` means all four supplied fields agree. Every report includes `evidenceOnly: true` and `executionProofVerified: false`. A report does not authenticate a log, establish chain finality, demonstrate token-manager execution, verify token custody or prove a recipient was paid. Display nonces help operators find records and do not replace the full command identity.

Partial, excessive, mismatched, malformed and missing receipts produce `verified: false` with discrepancies; `--strict` exits 1. The original records are retained separately in `sourceRawReferences` and `candidateRawReferences`, including overlapping keys. `rawReferences` remains a legacy flattened view whose candidate keys can replace source keys; use the separated records to retain both originals.

The SDK exports `reconcileAxelarPayment`. Rust exports `verify_outbound_reconciliation` and `verify_inbound_reconciliation`; both now require the expected complete source identity in addition to the candidate. Callers of the newly introduced Rust helpers must pass that source binding. Existing dispatch, replay and claim interfaces are unchanged.

The additive adapter views `inspectOutboundNote` / `inspectInboundNote` and `inspect_outbound_note` / `inspect_inbound_note` use the established wire decoders. They inspect payloads without authorization or state changes. Wire layouts and stored contract state are unchanged. Using these views on an existing deployment requires a reviewed adapter upgrade; running the standalone CLI does not.

SDK/CLI parity fixtures exercise full identity mismatches, unsafe amounts, note hex, inbound Strkey kinds/checksums, partial receipts and raw-reference collisions. Rust and Foundry suites exercise the actual inspection entrypoints and existing authentication/replay/claim paths. Local verification and artifact-generation results are recorded in the PR description.
