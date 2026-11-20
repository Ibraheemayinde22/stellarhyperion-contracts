import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverKeys, cliView } from "../discover-keys.mjs";
test("monotonic pages include additions and never skip after earlier settlement", async () => {
  let count = 3;
  const settled = new Set();
  const view = async (method, args) =>
    method === "claim_count"
      ? String(count)
      : JSON.stringify({
          settled: settled.has(args.id),
          amount: "99999999999999999999999999999999999999",
        });
  const first = await discoverKeys(
    { family: "claim", cursor: "0", limit: 2 },
    view,
  );
  settled.add("1");
  count = 4;
  const second = await discoverKeys(
    { family: "claim", cursor: first.nextCursor, limit: 2 },
    view,
  );
  assert.deepEqual(
    first.keys.map((k) => k.id),
    ["1", "2"],
  );
  assert.deepEqual(
    second.keys.map((k) => k.id),
    ["3", "4"],
  );
  assert.equal(second.nextCursor, "5");
});
test("reads are bounded and preserve u64 IDs beyond JavaScript safe integers", async () => {
  const calls = [];
  const view = async (method, args) => {
    calls.push([method, args]);
    if (method === "last_out_nonce") return "18446744073709551615";
    return "{}";
  };
  const result = await discoverKeys(
    { family: "transfer", cursor: "18446744073709551614", limit: 32 },
    view,
  );
  assert.deepEqual(
    result.keys.map((k) => k.id),
    ["18446744073709551614", "18446744073709551615"],
  );
  assert.equal(result.nextCursor, "18446744073709551616");
  assert.equal(calls.length, 3);
  const terminal = await discoverKeys(
    { family: "transfer", cursor: result.nextCursor, limit: 1 },
    view,
  );
  assert.deepEqual(terminal.keys, []);
});
test("an archived or unavailable record remains explicit and advances its recovery checkpoint", async () => {
  const result = await discoverKeys(
    { family: "claim", cursor: "0", limit: 3 },
    async (method, args) => {
      if (method === "claim_count") return "3";
      if (args.id === "2") throw new Error("archived");
      return JSON.stringify({ settled: args.id === "1" });
    },
  );
  assert.deepEqual(
    result.keys.map((k) => k.state),
    ["settled", "unavailable", "open"],
  );
  assert.equal(result.nextCursor, "4");
  assert.ok(!JSON.stringify(result).includes('"archived"'));
});
test("rejects unbounded limits and inexact cursors before any record read", async () => {
  const view = async () => {
    throw new Error("unexpected call");
  };
  for (const limit of [0, 33, 1.2])
    await assert.rejects(
      discoverKeys({ family: "claim", cursor: "0", limit }, view),
      /limit/,
    );
  for (const cursor of [
    9007199254740993,
    "-1",
    "1e3",
    "01",
    "18446744073709551617",
  ])
    await assert.rejects(
      discoverKeys({ family: "claim", cursor, limit: 1 }, view),
      /integer/,
    );
  assert.throws(() => cliView("--send yes"), /address/);
});
