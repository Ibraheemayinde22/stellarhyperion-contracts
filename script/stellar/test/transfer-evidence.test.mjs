import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  createIntent,
  validateTransferEvidence,
} from "../transfer-evidence.mjs";

const fixtures = resolve("script/stellar/test/fixtures/transfer-evidence");
const input = (name) =>
  JSON.parse(readFileSync(join(fixtures, name), "utf8"));

function evidence() {
  const intent = createIntent(input("intent.json"));
  const source = { ...input("source.json"), intentId: intent.intentId };
  const destination = {
    ...input("destination.json"),
    intentId: intent.intentId,
  };
  return { intent, source, destination };
}

test("source-only evidence cannot be classified as delivered", () => {
  const { intent, source } = evidence();
  const result = validateTransferEvidence(intent, source);
  assert.equal(result.status, "source-confirmed");
  assert.equal(result.delivered, false);
});

test("matching public source and independently observed destination preserve exact amounts", () => {
  const { intent, source, destination } = evidence();
  const result = validateTransferEvidence(intent, source, destination);
  assert.equal(result.status, "delivered");
  assert.equal(result.delivered, true);
  assert.equal(result.bindings.sourceAmount, "100000000000000000001");
  assert.equal(result.bindings.destinationAmount, "99700000000000000001");
});

test("mock evidence and mismatched recipient, amount, or network are rejected", () => {
  const { intent, source, destination } = evidence();
  assert.throws(
    () =>
      validateTransferEvidence(intent, source, {
        ...destination,
        observation: {
          ...destination.observation,
          kind: "mock",
        },
      }),
    /kind must be independent-rpc/,
  );
  assert.throws(
      () =>
        validateTransferEvidence(intent, source, {
          ...destination,
          observation: {
            ...destination.observation,
            provider: "local mock fixture",
          },
        }),
      /public independent provider/,
  );
  assert.throws(
    () =>
      validateTransferEvidence(intent, source, {
        ...destination,
        recipient: "0x3333333333333333333333333333333333333333",
      }),
    /recipient does not match/,
  );
  assert.throws(
    () =>
      validateTransferEvidence(intent, source, {
        ...destination,
        amount: "99700000000000000002",
      }),
    /amount does not match/,
  );
  assert.throws(
    () =>
      validateTransferEvidence(intent, source, {
        ...destination,
        asset: "0x3333333333333333333333333333333333333333",
      }),
    /asset does not match/,
  );
  assert.throws(
    () =>
      validateTransferEvidence(intent, source, {
        ...destination,
        network: "base-sepolia",
      }),
    /network binding mismatch/,
  );
});
