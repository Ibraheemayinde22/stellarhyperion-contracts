import { test } from "node:test";
import assert from "node:assert/strict";
import { replayJournal } from "../replay-journal.mjs";
import { cliCodec } from "../restore-plan.mjs";
const contract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const codec = {
  encode: (_, value) => Buffer.from(JSON.stringify(value)).toString("base64"),
  decode: (_, value) => JSON.parse(Buffer.from(value, "base64").toString()),
};
function event(c = codec) {
  return {
    contractId: contract,
    type: "contract",
    inSuccessfulContractCall: true,
    ledger: 123,
    pagingToken: "123-1",
    topic: [
      { symbol: "hyperion" },
      { symbol: "replay" },
      { u32: 0 },
      { bytes: "a5".repeat(32) },
    ].map((v) => c.encode("ScVal", v)),
    value: c.encode("ScVal", {
      map: [
        { key: { symbol: "version" }, val: { u32: 1 } },
        { key: { symbol: "ledger" }, val: { u32: 123 } },
        { key: { symbol: "timestamp" }, val: { u64: "9007199254740993" } },
      ],
    }),
  };
}
test("exports every identity byte, route-scoped restoration key and recoverable page cursor", async () => {
  const e = event();
  const page = await replayJournal(
    { contract, startLedger: 100, limit: 1 },
    async (method, params) => {
      assert.equal(method, "getEvents");
      assert.equal(params.startLedger, 100);
      assert.equal(params.pagination.limit, 1);
      return { events: [e], latestLedger: 130 };
    },
    codec,
  );
  assert.equal(page.nextCursor, "123-1");
  assert.equal(page.caughtUp, false);
  assert.equal(page.records[0].timestamp, "9007199254740993");
  const key = codec.decode("LedgerKey", page.records[0].ledgerKey);
  assert.deepEqual(key.contract_data.key.vec, [
    { symbol: "Processed" },
    { u32: 0 },
    { bytes: "a5".repeat(32) },
  ]);
  assert.deepEqual(page.records[0].event, e);
});
test("cursor resume and empty pages retain the committed checkpoint", async () => {
  const page = await replayJournal(
    { contract, cursor: "123-1" },
    async (_, params) => {
      assert.equal(params.startLedger, undefined);
      assert.equal(params.pagination.cursor, "123-1");
      return { events: [], latestLedger: 130 };
    },
    codec,
  );
  assert.equal(page.nextCursor, "123-1");
  assert.equal(page.caughtUp, true);
});
test("rejects wrong contract, failed calls, truncated identity and duplicate pages", async () => {
  for (const patch of [
    { contractId: "other" },
    { inSuccessfulContractCall: false },
    { topic: event().topic.slice(0, 3) },
  ])
    await assert.rejects(
      replayJournal(
        { contract, startLedger: 1 },
        async () => ({ events: [{ ...event(), ...patch }], latestLedger: 130 }),
        codec,
      ),
      /provenance/,
    );
  await assert.rejects(
    replayJournal(
      { contract, startLedger: 1 },
      async () => ({ events: [event(), event()], latestLedger: 130 }),
      codec,
    ),
    /provenance/,
  );
  await assert.rejects(
    replayJournal(
      { contract, startLedger: 1, limit: 33 },
      async () => {
        throw Error("read");
      },
      codec,
    ),
    /limit/,
  );
});
test("installed Stellar CLI roundtrips full replay identity into a real persistent LedgerKey", async () => {
  const page = await replayJournal(
    { contract, startLedger: 1 },
    async () => ({ events: [event(cliCodec)], latestLedger: 130 }),
    cliCodec,
  );
  const key = cliCodec.decode("LedgerKey", page.records[0].ledgerKey);
  assert.equal(key.contract_data.contract, contract);
  assert.equal(key.contract_data.key.vec[2].bytes, "a5".repeat(32));
  assert.equal(key.contract_data.durability, "persistent");
});
