# Documents

`architecture-v0.1.md` is the design this repository was built from. Its main body is kept unedited;
implementation notes are appended as clearly marked addenda rather than rewritten into the design.

It is kept here rather than summarised because the code refers back to it constantly, and because
a design document rewritten to match what was built stops being useful for the thing a design
document is for, which is telling you what somebody intended before they found out what was hard.
Where the implementation diverged from it, the code says so in a comment at the point of
divergence.

`TESTNET_ACTIVATION.md` records the current supported ITS lane, reviewed paid-transfer artifacts, operator commands and the required acceptance test.

`claim-operations.md` documents claim provenance compatibility, liability and recipient preview views, and paused-departure behavior.

`HOSTILE_FIXTURES.md` documents the test-only hostile Soroban token and rail-receiver fixtures, what each mode does at the router's real boundaries, and the rollback invariants the suite asserts.

## Compatibility and migration notes

- Hyperion note version 1 remains the only supported wire layout. Decoders dispatch by version
  and reject unknown versions before recipient or nonce parsing. Destination note requirements
  are floors: a higher required version can block dispatch but never silently downgrade to v1.
- CCTP expiry and lane-readiness diagnostics are read-only local tools. Expired evidence is never
  classified as a verified mint; renewal plans preserve source message identity and payout intent.
  Unknown or paused messenger/transmitter reads fail closed, and unsupported recovery methods
  remain explicitly unavailable.
- CCTP fee accounting events (`cctp_fee_out`, `cctp_fee_in`) are additive and versioned. They
  record the fee budget, measured burn, retained dust and attested destination deduction in
  explicit units, and existing `cctp_out` / `cctp_in` decoding is unchanged. See
  `CCTP_FEE_ACCOUNTING.md`.
- The Axelar token-manager probe (`probe_token_manager`) is an additive read-only view. It
  establishes token id, manager type, local mapping, remote trust and paid-send reads through
  real ITS calls. Unknown manager types and missing methods block it, and a matching symbol never
  qualifies a mapping. See `AXELAR_TOKEN_MANAGER_PROBE.md`.
- `script/stellar/custody-audit.mjs` is an offline orphaned-custody auditor built on existing
  router and token views; there is no contract change, because the router is at the 64KB limit. It
  separates unsettled claims from unexplained router and adapter balances, reports missing
  liability history or unreadable balances as unknown, and cannot move funds. See
  `claim-operations.md`.
- Inbound routers reject zero and provider amounts outside the router's supported `i128`/`uint128`
  representable range before custody changes. The exact upper bounds retain normal payout and claim
  behavior. Active deployment remains Stellar Testnet outbound ITS/CCTP; EVM and other rail paths
  require independent validation before activation.
