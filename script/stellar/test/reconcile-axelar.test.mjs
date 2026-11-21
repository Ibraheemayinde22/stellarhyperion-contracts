import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";

import {
  reconcileAxelarPayment,
  reconcileAxelarEvidence,
  decodeOutboundNote,
  decodeInboundNote,
} from "../reconcile-axelar.mjs";

const FIXTURES_DIR = resolve("script/stellar/test/fixtures/reconciliation");

test("reconciles exact matching outbound note and candidate payment as verified", () => {
  const fixture = JSON.parse(
    readFileSync(join(FIXTURES_DIR, "verified", "evidence.json"), "utf8"),
  );
  const result = reconcileAxelarEvidence(fixture);

  assert.equal(result.verified, true);
  assert.equal(result.status, "verified");
  assert.equal(result.direction, "outbound");
  assert.deepEqual(result.discrepancies, []);
  assert.ok(result.agreements.includes("recipient"));
  assert.ok(result.agreements.includes("tokenId"));
  assert.ok(result.agreements.includes("amount"));
  assert.ok(result.agreements.includes("commandId"));
  assert.equal(
    result.rawReferences.sourceTxHash,
    "3f9c08e54d72803bba2a20bfa51829375e2ecb534d0263f5339f427f7fef4036",
  );
  assert.equal(
    result.rawReferences.destinationTxHash,
    "0x89e1a2f64c8fbe5a73e6559388df1c3f27de15e5f396497f1f970220cb3d3c85",
  );
  assert.equal(result.details.displayNonce, "42");
});

test("reports unverified on mismatched recipient", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(FIXTURES_DIR, "mismatched-recipient", "evidence.json"),
      "utf8",
    ),
  );
  const result = reconcileAxelarEvidence(fixture);

  assert.equal(result.verified, false);
  assert.equal(result.status, "unverified");
  assert.ok(result.discrepancies.some((d) => d.includes("recipient mismatch")));
});

test("reports unverified on mismatched token ID", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(FIXTURES_DIR, "mismatched-token", "evidence.json"),
      "utf8",
    ),
  );
  const result = reconcileAxelarEvidence(fixture);

  assert.equal(result.verified, false);
  assert.equal(result.status, "unverified");
  assert.ok(result.discrepancies.some((d) => d.includes("token ID mismatch")));
});

test("reports unverified on mismatched amount", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(FIXTURES_DIR, "mismatched-amount", "evidence.json"),
      "utf8",
    ),
  );
  const result = reconcileAxelarEvidence(fixture);

  assert.equal(result.verified, false);
  assert.equal(result.status, "unverified");
  assert.ok(result.discrepancies.some((d) => d.includes("amount mismatch")));
});

test("reports unverified on partial receipt", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(FIXTURES_DIR, "partial-receipt", "evidence.json"),
      "utf8",
    ),
  );
  const result = reconcileAxelarEvidence(fixture);

  assert.equal(result.verified, false);
  assert.equal(result.status, "unverified");
  assert.ok(
    result.discrepancies.some((d) => d.includes("partial receipt detected")),
  );
});

test("reports unverified on missing command ID", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(FIXTURES_DIR, "missing-command-id", "evidence.json"),
      "utf8",
    ),
  );
  const result = reconcileAxelarEvidence(fixture);

  assert.equal(result.verified, false);
  assert.equal(result.status, "unverified");
  assert.ok(
    result.discrepancies.some((d) =>
      d.includes("missing candidate command ID"),
    ),
  );
});

test("reports unverified on missing candidate payment", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(FIXTURES_DIR, "missing-candidate", "evidence.json"),
      "utf8",
    ),
  );
  const result = reconcileAxelarEvidence(fixture);

  assert.equal(result.verified, false);
  assert.equal(result.status, "unverified");
  assert.ok(
    result.discrepancies.some((d) => d.includes("missing candidate payment")),
  );
});

test("reports unverified on malformed note payload", () => {
  const fixture = JSON.parse(
    readFileSync(join(FIXTURES_DIR, "malformed-note", "evidence.json"), "utf8"),
  );
  const result = reconcileAxelarEvidence(fixture);

  assert.equal(result.verified, false);
  assert.equal(result.status, "unverified");
  assert.ok(
    result.discrepancies.some((d) => d.includes("malformed note payload")),
  );
});

test("inbound note reconciliation verifies when Strkey and payment agree", () => {
  // Inbound note: [version=1][kind=0][len=56][GA5ZYIIVYDX5GRF2BKEQD2Y47ZCPG3HX3PUUNPVQ5ZECB57MJG7RLVNR][nonce=99]
  const strkey = "GA5ZYIIVYDX5GRF2BKEQD2Y47ZCPG3HX3PUUNPVQ5ZECB57MJG7RLVNR";
  const strkeyBytes = Buffer.from(strkey, "ascii");
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64BE(99n, 0);

  const inboundNoteHex =
    "0x" +
    Buffer.concat([
      Buffer.from([1, 0, strkeyBytes.length]),
      strkeyBytes,
      nonceBytes,
    ]).toString("hex");

  const source = {
    direction: "inbound",
    note: inboundNoteHex,
    tokenId:
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    amount: "1000000000",
    commandId:
      "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    rawReferences: { sourceChain: "ethereum", sourceBlock: 12345 },
  };

  const matchingCandidate = {
    recipient: strkey,
    tokenId:
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    amount: "1000000000",
    commandId:
      "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    rawReferences: { destinationChain: "stellar", destinationLedger: 67890 },
  };

  const verifiedResult = reconcileAxelarPayment(source, matchingCandidate);
  assert.equal(verifiedResult.verified, true);
  assert.equal(verifiedResult.status, "verified");
  assert.equal(verifiedResult.direction, "inbound");
  assert.equal(verifiedResult.details.expectedRecipient, strkey);

  const mismatchedCandidate = {
    recipient: "GCLWGQBMKCR5W65Q56T77UDCH5GYJ6JISD6G3JOHY5RCD2X6YODP2W4D",
    tokenId:
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    amount: "1000000000",
    commandId:
      "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  };
  const unverifiedResult = reconcileAxelarPayment(source, mismatchedCandidate);
  assert.equal(unverifiedResult.verified, false);
  assert.equal(unverifiedResult.status, "unverified");
  assert.ok(
    unverifiedResult.discrepancies.some((d) =>
      d.includes("recipient mismatch"),
    ),
  );
});

test("bare ITS fields cannot establish encoded Hyperion note intent", () => {
  const source = {
    direction: "outbound",
    recipient: "0x1111111111111111111111111111111111111111",
    tokenId:
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    amount: "2500000",
    commandId:
      "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  };
  const candidate = {
    recipient: "0x1111111111111111111111111111111111111111",
    tokenId:
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    amount: "2500000",
    commandId:
      "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  };
  const res = reconcileAxelarPayment(source, candidate);
  assert.equal(res.verified, false);
  assert.equal(res.status, "unverified");
  assert.ok(
    res.discrepancies.some((d) => d.includes("missing encoded source note")),
  );
});

test("CLI executes properly with --fixture and --strict flags", () => {
  const verifiedFixture = join(FIXTURES_DIR, "verified");
  const cliPath = resolve("script/stellar/reconcile-axelar.mjs");

  const runVerified = spawnSync(
    "node",
    [cliPath, "--fixture", verifiedFixture, "--strict"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(runVerified.status, 0);
  const parsedVerified = JSON.parse(runVerified.stdout);
  assert.equal(parsedVerified.verified, true);

  const unverifiedFixture = join(FIXTURES_DIR, "mismatched-recipient");
  const runUnverified = spawnSync(
    "node",
    [cliPath, "--fixture", unverifiedFixture, "--strict"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(runUnverified.status, 1);
  const parsedUnverified = JSON.parse(runUnverified.stdout);
  assert.equal(parsedUnverified.verified, false);
  assert.equal(parsedUnverified.status, "unverified");
});
