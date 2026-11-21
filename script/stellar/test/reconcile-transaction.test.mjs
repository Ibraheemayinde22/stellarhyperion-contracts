import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reconcileLive,
  reconcileTransaction,
  verifyEnvelope,
} from "../reconcile-transaction.mjs";

const passphrase = "Test SDF Network ; September 2015";
// Real, unsigned v1 TransactionEnvelope XDR. No operation is submitted by these fixtures.
const raw = Buffer.alloc(72);
raw.writeUInt32BE(2, 0);
raw.writeUInt32BE(100, 40);
raw.writeBigInt64BE(1n, 44);
const envelopeXdr = raw.toString("base64");
const verified = verifyEnvelope(envelopeXdr, passphrase);
const base = {
  expectedHash: verified.hash,
  expectedNetwork: passphrase,
  expectedSender: verified.source,
  expectedConfig: {
    admin: verified.source,
    guardian: verified.source,
    treasury: verified.source,
    fee_bps: 30,
    flow_window_ledgers: 720,
    timelock_delay: 3600,
    paused: false,
  },
  observedNetwork: passphrase,
  transaction: { status: "SUCCESS", envelopeXdr },
  liveConfig: {
    paused: false,
    treasury: verified.source,
    admin: verified.source,
    guardian: verified.source,
    fee_bps: 30,
    flow_window_ledgers: 720,
    timelock_delay: 3600,
  },
};
test("real decoded envelope, passphrase-derived hash and matching live configuration confirm", () => {
  assert.equal(reconcileTransaction(base).status, "confirmed");
  assert.equal(reconcileTransaction(base).retryAllowed, false);
});
test("asserted hash/network/source strings cannot replace actual envelope evidence", () => {
  const transaction = {
    ...base.transaction,
    hash: base.expectedHash,
    network: passphrase,
    source: base.expectedSender,
    envelopeXdr: "AAAA",
  };
  assert.equal(
    reconcileTransaction({ ...base, transaction }).status,
    "unknown",
  );
});
test("the same envelope on a different network has a different transaction hash", () => {
  const otherNetwork = "Public Global Stellar Network ; September 2015";
  const other = verifyEnvelope(envelopeXdr, otherNetwork);
  assert.notEqual(other.hash, verified.hash);
  assert.equal(
    reconcileTransaction({
      ...base,
      expectedNetwork: otherNetwork,
      observedNetwork: otherNetwork,
    }).reason,
    "envelope-hash-mismatch",
  );
});
test("wrong sender cannot prove an operation even when an RPC response asserts it", () => {
  const different = Buffer.from(raw);
  different[8] = 1;
  const otherSender = verifyEnvelope(
    different.toString("base64"),
    passphrase,
  ).source;
  assert.equal(
    reconcileTransaction({
      ...base,
      expectedSender: otherSender,
      transaction: { ...base.transaction, source: otherSender },
    }).reason,
    "envelope-sender-mismatch",
  );
});
test("malformed config arrays and divergent live fields are never confirmed", () => {
  assert.equal(
    reconcileTransaction({ ...base, liveConfig: [] }).status,
    "unknown",
  );
  assert.equal(
    reconcileTransaction({
      ...base,
      liveConfig: { ...base.liveConfig, fee_bps: 31 },
    }).status,
    "unknown",
  );
  assert.throws(
    () => reconcileTransaction({ ...base, expectedConfig: [] }),
    /complete validated/,
  );
  assert.throws(
    () => reconcileTransaction({ ...base, expectedConfig: { paused: false } }),
    /complete validated/,
  );
  assert.equal(
    reconcileTransaction({
      ...base,
      liveConfig: { ...base.liveConfig, extra: 1 },
    }).status,
    "unknown",
  );
  const missing = { ...base.liveConfig };
  delete missing.guardian;
  assert.equal(
    reconcileTransaction({ ...base, liveConfig: missing }).status,
    "unknown",
  );
});
test("failed, pending, not-found and unavailable outcomes never propose replacement operations", () => {
  for (const status of ["FAILED", "PENDING", "NOT_FOUND"]) {
    const result = reconcileTransaction({
      ...base,
      transaction: { ...base.transaction, status },
    });
    assert.notEqual(result.status, "confirmed");
    assert.equal(result.retryAllowed, false);
  }
  assert.equal(
    reconcileTransaction({ ...base, transaction: null }).status,
    "unknown",
  );
});
test("live mode retrieves the known hash and actual read-only configuration", async () => {
  const calls = [];
  const request = {
    ...base,
    rpcUrl: "http://127.0.0.1:8000",
    contractId: "C" + "A".repeat(55),
  };
  const result = await reconcileLive(request, {
    rpc: async (method, params) => {
      calls.push({ method, params });
      return method === "getNetwork" ? { passphrase } : base.transaction;
    },
    configReader: async (value) => {
      assert.equal(value.contractId, request.contractId);
      return base.liveConfig;
    },
  });
  assert.equal(result.status, "confirmed");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["getNetwork", "getTransaction"],
  );
  assert.equal(calls[1].params.hash, verified.hash);
});
test("live network mismatch stops before transaction or config reads", async () => {
  const calls = [];
  const result = await reconcileLive(
    {
      ...base,
      rpcUrl: "http://127.0.0.1:8000",
      contractId: "C" + "A".repeat(55),
    },
    {
      rpc: async (method) => {
        calls.push(method);
        return { passphrase: "wrong" };
      },
      configReader: () => {
        throw new Error("must not be called");
      },
    },
  );
  assert.equal(result.reason, "network-mismatch");
  assert.deepEqual(calls, ["getNetwork"]);
});
