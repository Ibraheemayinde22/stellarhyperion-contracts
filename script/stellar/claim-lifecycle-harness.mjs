#!/usr/bin/env node

// Deterministic local fixture for the claim lifecycle. It deliberately does not contact a
// network or sign a transaction: deployment scripts use the same snapshots around real calls,
// while this fixture makes interruption and retry behavior reproducible in CI and rehearsals.

const claimId = 1n;
const amount = 3000000000000000007n;
const token = "USDC";
const recipient = "G...RECIPIENT";

const state = {
  schemaVersion: 2,
  nextClaimId: 1n,
  claims: new Map(),
  liabilities: new Map(),
  payouts: new Map(),
};

function snapshot(label, interruption = null) {
  const claim = state.claims.get(claimId);
  return {
    label,
    interruption,
    schemaVersion: state.schemaVersion,
    nextClaimId: state.nextClaimId.toString(),
    liability: (state.liabilities.get(token) ?? 0n).toString(),
    payoutCount: String(state.payouts.get(claimId) ?? 0),
    claim: claim && {
      id: claim.id.toString(),
      token: claim.token,
      amount: claim.amount.toString(),
      recipient: claim.recipient,
      settled: claim.settled,
      failureReason: claim.failureReason,
    },
  };
}

function park() {
  state.claims.set(claimId, {
    id: claimId,
    token,
    amount,
    recipient,
    settled: false,
    failureReason: 4, // custody short / payout deferred
  });
  state.nextClaimId = claimId + 1n;
  state.liabilities.set(token, amount);
}

function failedSettlement() {
  const claim = state.claims.get(claimId);
  claim.failureReason = 4;
  // A failed payout changes diagnostics only. The claim and its liability remain intact.
}

function upgradeAndRestore() {
  state.schemaVersion = 3;
  // Restoration keeps the original claim identity and recipient; it never recreates a claim.
  const claim = state.claims.get(claimId);
  state.claims.set(claimId, { ...claim });
}

function settle() {
  const claim = state.claims.get(claimId);
  if (!claim || claim.settled) return false;
  claim.settled = true;
  claim.failureReason = 0;
  state.liabilities.set(token, 0n);
  state.payouts.set(claimId, (state.payouts.get(claimId) ?? 0) + 1);
  return true;
}

const snapshots = [];
park();
snapshots.push(snapshot("parked"));
failedSettlement();
snapshots.push(snapshot("settlement-failed", "payout interrupted before transfer"));
upgradeAndRestore();
snapshots.push(snapshot("upgrade-restored", "process interrupted after upgrade"));
settle();
snapshots.push(snapshot("settled"));
settle();
snapshots.push(snapshot("settle-retried", "replayed settlement request"));

if ((state.liabilities.get(token) ?? 0n) !== 0n || state.payouts.get(claimId) !== 1) {
  throw new Error("claim lifecycle invariant failed");
}

const result = {
  scenario: "claim-lifecycle-crash-and-upgrade",
  exactIntegerAmount: amount.toString(),
  invariants: {
    liabilitiesSurviveInterruption: snapshots[1].liability === amount.toString(),
    restoredClaimKeepsRecipient: snapshots[2].claim.recipient === recipient,
    repeatedSettlementPaysOnce: snapshots.at(-1).payoutCount === "1",
  },
  snapshots,
};

console.log(JSON.stringify(result, null, 2));
