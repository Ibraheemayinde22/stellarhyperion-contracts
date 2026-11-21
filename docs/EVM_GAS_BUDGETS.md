# EVM governance and claim gas budgets

The Foundry regression suite reports router gas for timelock queue/execute, normal inbound
delivery, hostile-recipient claim parking, and normal or hostile claim settlement. It grows the
action history to 16 entries and the claim history to 32 entries, and reports 10-claim settlement
batches. Hostile cases use the local frozen-recipient token fixture.

Each reported budget uses a fixed fixture baseline target with a 25% tolerance. The enforced
ceiling is computed by the test and printed next to the measured gas; the baseline column is a
regression target, not a previously measured result. These figures are not transaction fee quotes
or estimates for a live chain.

| Case | Baseline gas | Enforced ceiling |
| --- | ---: | ---: |
| Governance queue action | 250,000 | 312,500 |
| Governance execute action | 150,000 | 187,500 |
| Normal inbound, first / shared storage warm | 180,000 / 140,000 | 225,000 / 175,000 |
| Hostile inbound claim parking, first / after 32 claims | 300,000 / 250,000 | 375,000 / 312,500 |
| Normal settlement batch of 10, first / shared storage warm | 1,000,000 / 900,000 | 1,250,000 / 1,125,000 |
| Hostile settlement batch of 2, first / shared storage warm | 350,000 / 300,000 | 437,500 / 375,000 |

“First” and “shared storage warm” describe sequential calls within one test transaction.
Distinct action and claim records still use fresh mapping slots; later calls reuse already-warmed
role, counter, router, and token-account storage. The reports therefore expose growth and the
warm shared-state effect without claiming every per-record slot is warm. The measured section
starts immediately before each router call; fixture deployment and setup are excluded.

Reproduce the measurements and assertions from the repository root with:

```sh
cd evm && forge test --match-contract RouterGasBudgetTest --gas-report -vv
```

The budget suite uses the default Foundry profile pinned in `evm/foundry.toml`: Solidity 0.8.28,
Cancun, optimizer enabled with 200 runs, and `via_ir = true`. Do not compare reports from a
different compiler or optimizer profile against these ceilings.

This adds no selector, storage field, or wire-format change, so it requires no router migration or
protocol parity update. The EVM remains development-only; the active deployment remains Stellar
Testnet outbound ITS/CCTP. Passing local gas budgets is not deployment or activation evidence.
