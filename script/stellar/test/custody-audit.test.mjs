import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { auditCustody, readAmount } from "../custody-audit.mjs";

const FIXTURES = resolve("script/stellar/test/fixtures/custody");
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const ROUTER = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARQG5";
const RAIL = "CBRAILAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAXI7N";

function snapshot(overrides = {}) {
  return {
    token: "CTOKENFIXTUREAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    router: ROUTER,
    routerBalance: "300",
    claimLiability: { outstanding: "300", custody: "300", known: true },
    holders: [{ route: "cctp", role: "adapter", address: RAIL, balance: "0" }],
    ...overrides,
  };
}

test("custody equal to unsettled claims with empty holders reconciles", () => {
  const report = auditCustody(snapshot());
  assert.equal(report.version, 1);
  assert.equal(report.routerCustody, "300");
  assert.equal(report.unsettledClaims, "300");
  assert.equal(report.routerUnexplained, "0");
  assert.equal(report.holderUnexplained, "0");
  assert.equal(report.status, "reconciled");
  assert.equal(report.movesFunds, false);
});

test("donations to the router and a rail are separated from unsettled claims", () => {
  const report = auditCustody(fixture("donations.json"));
  assert.equal(report.unsettledClaims, "1000000000");
  assert.equal(report.routerUnexplained, "17");
  // One address configured as adapter and receiver is listed once, under its first route.
  assert.deepEqual(
    report.holders.map((holder) => [holder.route, holder.roles, holder.balance]),
    [
      ["cctp", ["adapter", "rail-receiver"], "5"],
      ["axelar-its", ["adapter"], "0"],
    ],
  );
  assert.equal(report.holderUnexplained, "5");
  assert.equal(report.status, "unexplained");
});

test("custody below unsettled claims is a shortfall even when a holder is unreadable", () => {
  const report = auditCustody(
    snapshot({
      routerBalance: "299",
      holders: [{ route: "cctp", role: "adapter", address: RAIL, balance: null }],
    }),
  );
  assert.equal(report.routerUnexplained, "-1");
  assert.equal(report.holderUnexplained, null);
  assert.equal(report.status, "shortfall");
});

test("incomplete liability history is unknown, never zero", () => {
  const report = auditCustody(fixture("unmigrated.json"));
  assert.equal(report.routerCustody, "1000000009");
  assert.equal(report.unsettledClaims, null);
  assert.equal(report.routerUnexplained, null);
  assert.equal(report.status, "unknown");

  for (const claimLiability of [undefined, null, { outstanding: "5" }]) {
    const missing = auditCustody(snapshot({ claimLiability }));
    assert.equal(missing.unsettledClaims, null);
    assert.equal(missing.status, "unknown");
  }
});

test("unreadable or inexact balances are unknown, not zero", () => {
  for (const routerBalance of [null, undefined, "-1", "1.5", 1.5, "", "0x10", 2 ** 60]) {
    const report = auditCustody(snapshot({ routerBalance }));
    assert.equal(report.routerCustody, null, String(routerBalance));
    assert.equal(report.status, "unknown");
  }
  const holder = auditCustody(
    snapshot({ holders: [{ route: "cctp", role: "adapter", address: RAIL, balance: "x" }] }),
  );
  assert.equal(holder.holders[0].balance, null);
  assert.equal(holder.status, "unknown");

  // Two disagreeing reads of one address trust neither.
  const split = auditCustody(
    snapshot({
      holders: [
        { route: "cctp", role: "adapter", address: RAIL, balance: "0" },
        { route: "cctp", role: "rail-receiver", address: RAIL, balance: "4" },
      ],
    }),
  );
  assert.equal(split.holders[0].balance, null);
  assert.equal(split.status, "unknown");
});

test("amounts stay exact beyond the safe-integer range", () => {
  const big = "170141183460469231731687303715884105727"; // i128::MAX
  const report = auditCustody(
    snapshot({
      routerBalance: big,
      claimLiability: { outstanding: "1", known: true },
    }),
  );
  assert.equal(report.routerUnexplained, "170141183460469231731687303715884105726");
  assert.equal(readAmount(" 42 "), 42n);
});

test("the router never counts as its own holder", () => {
  const report = auditCustody(
    snapshot({ holders: [{ route: "cctp", role: "adapter", address: ROUTER, balance: "9" }] }),
  );
  assert.deepEqual(report.holders, []);
  assert.equal(report.status, "reconciled");
});

test("malformed snapshots are refused rather than guessed at", () => {
  assert.throws(() => auditCustody(null), /snapshot must be an object/);
  assert.throws(() => auditCustody(snapshot({ token: "" })), /snapshot.token/);
  assert.throws(
    () => auditCustody(snapshot({ holders: [{ route: "ibc", role: "adapter", address: RAIL }] })),
    /route must be one of/,
  );
  assert.throws(
    () => auditCustody(snapshot({ holders: [{ route: "cctp", role: "owner", address: RAIL }] })),
    /role must be one of/,
  );
});

test("the CLI prints the same report and reads only the snapshot it is given", () => {
  const result = spawnSync(
    process.execPath,
    ["script/stellar/custody-audit.mjs", "--snapshot", join(FIXTURES, "donations.json")],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), auditCustody(fixture("donations.json")));

  const bad = spawnSync(process.execPath, ["script/stellar/custody-audit.mjs"], {
    input: "{}",
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /snapshot.token/);
});
