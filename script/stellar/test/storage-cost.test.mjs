import { test } from "node:test";
import assert from "node:assert/strict";
import { projectStorageCosts, captureStorageCosts } from "../storage-cost.mjs";
const enc = (v) => Buffer.from(JSON.stringify(v)).toString("base64");
const codec = {
  decode: (_, v) => JSON.parse(Buffer.from(v, "base64").toString()),
  encode: (_, v) => enc(v),
};
const key = (id) => ({ contract_data: { durability: "persistent", key: id } });
const fp = (keys, archived = []) =>
  enc({
    ext: { v1: { archived_soroban_entries: archived } },
    resources: {
      footprint: { read_only: [], read_write: keys },
      instructions: 123,
      disk_read_bytes: 456,
      write_bytes: 789,
    },
  });
function fixture(count = 1) {
  const raw = Array.from({ length: count }, (_, i) => key(["Claim", i + 1]));
  const keys = raw.map(enc);
  return {
    version: 2,
    network: {
      passphrase: "Test SDF Network ; September 2015",
      protocolVersion: 29,
    },
    assumptions: { cycleLedgers: 518400, ledgersPerYear: 6307200 },
    scenarios: [
      {
        name: `claims-${count}`,
        keys,
        transaction: enc("unsigned fixture"),
        ledgerResponse: {
          latestLedger: 100,
          entries: keys.map((k) => ({
            key: k,
            xdr: enc({
              contract_data: { val: { i128: "10000000000000000001" } },
            }),
            liveUntilLedgerSeq: 200,
          })),
        },
        simulation: {
          latestLedger: 100,
          transactionData: fp(raw),
          minResourceFee: "9007199254740993",
        },
      },
    ],
  };
}
test("1/32 claim growth reports exact recorded bytes/resources and integer fees", () => {
  for (const count of [1, 32]) {
    const report = projectStorageCosts(fixture(count), codec),
      s = report.scenarios[0];
    assert.equal(s.categories.persistent.entries, count);
    assert.equal(s.fees.maintenanceResourceFeeStroops, "9007199254740993");
    assert.equal(
      s.fees.projectedAnnualMaintenanceResourceFeeStroops,
      (9007199254740993n * 13n).toString(),
    );
    assert.equal(s.resources.instructions, 123);
    assert.equal(s.complete, true);
  }
});
test("instance/persistent/archived/unavailable stay separate without invented archive bytes", () => {
  const f = fixture(4),
    s = f.scenarios[0];
  const raw = [
    key("ledger_key_contract_instance"),
    key(["Transfer", 1]),
    key(["Claim", 1]),
    key(["Claim", 2]),
  ];
  s.keys = raw.map(enc);
  s.ledgerResponse.entries = s.keys.slice(0, 2).map((k) => ({
    key: k,
    xdr: enc({ contract_data: { val: { i128: "10" } } }),
    liveUntilLedgerSeq: 200,
  }));
  s.simulation.transactionData = fp(raw.slice(0, 3), [2]);
  const r = projectStorageCosts(f, codec).scenarios[0];
  for (const group of ["instance", "persistent", "archived", "unavailable"])
    assert.equal(r.categories[group].entries, 1);
  assert.equal(r.records[2].xdrBytes, null);
  assert.equal(r.complete, false);
  assert.equal(r.automaticRestorationIncluded, true);
});
test("rejects stale/error/unsafe fees/duplicate/unrecorded/oversized evidence", () => {
  for (const mutate of [
    (f) => (f.scenarios[0].simulation.latestLedger = 1),
    (f) => (f.scenarios[0].simulation.error = "failed"),
    (f) => (f.scenarios[0].simulation.minResourceFee = 9007199254740993),
    (f) => (f.scenarios[0].simulation.minResourceFee = "9223372036854775808"),
    (f) => f.scenarios[0].keys.push(f.scenarios[0].keys[0]),
    (f) => (f.scenarios[0].simulation.transactionData = fp([key(999)])),
    (f) => (f.scenarios[0].keys = Array(33).fill(enc(key(1)))),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => projectStorageCosts(f, codec));
  }
});
test("capturing costs uses only network/ledger reads and transaction simulation", async () => {
  const f = fixture(),
    s = f.scenarios[0],
    calls = [];
  const r = await captureStorageCosts(
    { assumptions: f.assumptions, scenarios: [s] },
    async (method, params) => {
      calls.push(method);
      if (method === "getNetwork") return f.network;
      if (method === "simulateTransaction") {
        assert.equal(params.transaction, s.transaction);
        return s.simulation;
      }
      if (method === "getLedgerEntries") return s.ledgerResponse;
      throw new Error("broadcast forbidden");
    },
  );
  assert.deepEqual(calls, [
    "getNetwork",
    "simulateTransaction",
    "getLedgerEntries",
  ]);
  assert.equal(projectStorageCosts(r, codec).scenarios[0].complete, true);
});

test("installed production codec validates growing real router-shaped XDR fixtures", async () => {
  const { readFileSync } = await import("node:fs");
  const record = JSON.parse(
    readFileSync(
      new URL("../fixtures/storage-cost-rpc-v2.json", import.meta.url),
      "utf8",
    ),
  );
  const report = projectStorageCosts(record);
  assert.deepEqual(
    report.scenarios.map((s) => s.categories.persistent.entries),
    [1, 32],
  );
  assert.ok(
    report.scenarios[1].categories.persistent.recordedXdrBytes >
      report.scenarios[0].categories.persistent.recordedXdrBytes,
  );
  assert.match(record.assumptions.source, /mock RPC/);
});

test("a partial simulated footprint cannot claim complete key-set maintenance coverage", () => {
  const f = fixture(2);
  f.scenarios[0].simulation.transactionData = fp([key(["Claim", 1])]);
  const s = projectStorageCosts(f, codec).scenarios[0];
  assert.equal(
    s.records.every((r) => r.state === "live"),
    true,
  );
  assert.equal(s.footprintCoverageComplete, false);
  assert.equal(s.complete, false);
});

test("restoration preamble costs remain separate and exact", () => {
  const f = fixture(2),
    s = f.scenarios[0];
  s.ledgerResponse.entries = s.ledgerResponse.entries.slice(0, 1);
  s.simulation.transactionData = fp([key(["Claim", 1])]);
  s.simulation.restorePreamble = {
    transactionData: fp([key(["Claim", 2])]),
    minResourceFee: "9007199254740993",
  };
  const r = projectStorageCosts(f, codec).scenarios[0];
  assert.equal(r.categories.archived.entries, 1);
  assert.equal(r.fees.restorationResourceFeeStroops, "9007199254740993");
  assert.equal(r.automaticRestorationIncluded, false);
  assert.equal(r.complete, true);
});
