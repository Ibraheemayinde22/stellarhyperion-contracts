import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { compareRegistry, loadRegistry } from "../verify-registry.mjs";

const commit = "5d57a1ee944e28f0a06539b7225cf93d729f77d1";
const chain = {
  networkPassphrase: "Case Sensitive Network",
  axelarName: "Stellar-Testnet",
  cctpDomain: 27,
};
const issuer = "G" + "A".repeat(55);
const assets = ["native", "its"].map((representation) => ({
  family: "stellar",
  chain: "stellar-testnet",
  representation,
  code: "USDC",
  issuer: representation === "native" ? issuer : "G" + "B".repeat(55),
  symbol: "USDC",
  decimals: 7,
  confirmed: true,
  source: "primary",
}));
const rails = {
  confirmed: true,
  source: "primary",
  cctp: { tokenMessengerV2: "0x" + "a".repeat(40) },
  axelar: {
    interchainTokenService: "C" + "A".repeat(55),
    chainName: "Stellar-Testnet",
    gasService: "C" + "B".repeat(55),
  },
};
const identity = ({ family, chain, representation, code, issuer }) => ({
  family,
  chain,
  representation,
  code,
  issuer,
});
const selected = {
  commit,
  sourceSha256: "a".repeat(64),
  registry: {
    chainByKey: () => chain,
    assetsOn: () => assets,
    railContracts: () => rails,
    assetIdentity: identity,
    assetIdentityKey: (v) => JSON.stringify(v),
  },
};
const snapshot = () => ({
  network: "stellar-testnet",
  networkPassphrase: chain.networkPassphrase,
  axelarName: chain.axelarName,
  cctpDomain: 27,
  tokens: assets.map((asset) => ({ ...asset })),
  providers: { cctp: { ...rails.cctp }, "axelar-its": { ...rails.axelar } },
});
test("provider metadata is compared and symbol-sharing representations remain distinct", () => {
  const report = compareRegistry(snapshot(), "stellar-testnet", selected);
  assert.equal(report.healthy, true);
  assert.equal(
    report.results.filter((r) => r.field.startsWith("provider.")).length,
    4,
  );
  assert.equal(
    report.results.filter((r) => r.field.endsWith(".decimals")).length,
    2,
  );
  const live = snapshot();
  live.providers["axelar-its"].interchainTokenService = "C" + "Z".repeat(55);
  assert.equal(
    compareRegistry(live, "stellar-testnet", selected).counts.drift,
    1,
  );
});
test("case-sensitive Stellar addresses, issuers, chain names and passphrases cannot pass drift", () => {
  const live = snapshot();
  live.networkPassphrase = live.networkPassphrase.toLowerCase();
  live.providers["axelar-its"].chainName =
    live.providers["axelar-its"].chainName.toLowerCase();
  live.providers["axelar-its"].interchainTokenService =
    live.providers["axelar-its"].interchainTokenService.toLowerCase();
  live.tokens[0].issuer = issuer.toLowerCase();
  const report = compareRegistry(live, "stellar-testnet", selected);
  assert.equal(report.healthy, false);
  assert.equal(report.counts.drift, 3);
  assert.ok(report.counts.unknown > 0);
});
test("unknown and inferred observations are not a healthy ready report", () => {
  const unknown = compareRegistry(
    { network: "stellar-testnet" },
    "stellar-testnet",
    selected,
  );
  assert.equal(unknown.healthy, false);
  assert.ok(unknown.counts.unknown > 0);
  const inferred = {
    ...selected,
    registry: {
      ...selected.registry,
      railContracts: () => ({ ...rails, confirmed: false }),
    },
  };
  assert.equal(
    compareRegistry(snapshot(), "stellar-testnet", inferred).healthy,
    false,
  );
});
test("snapshot identity ambiguity and old symbol-keyed observation shape are rejected", () => {
  const live = snapshot();
  live.tokens.push({ ...live.tokens[0] });
  assert.throws(
    () => compareRegistry(live, "stellar-testnet", selected),
    /ambiguous/,
  );
  assert.throws(
    () =>
      compareRegistry(
        { ...snapshot(), tokens: { USDC: assets[0] } },
        "stellar-testnet",
        selected,
      ),
    /array/,
  );
});
test("selected revision must be an exact commit, and extraction uses that committed source", async () => {
  await assert.rejects(loadRegistry("git:HEAD"), /full 40-character/);
  await assert.rejects(loadRegistry("git:" + "0".repeat(40)));
  const root = new URL("../../..", import.meta.url).pathname;
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const actual = await loadRegistry(`git:${head}`);
  try {
    assert.equal(actual.commit, head);
    assert.match(actual.sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(
      actual.registry.chainByKey("stellar-testnet").networkPassphrase,
      "Test SDF Network ; September 2015",
    );
  } finally {
    actual.cleanup();
  }
});
