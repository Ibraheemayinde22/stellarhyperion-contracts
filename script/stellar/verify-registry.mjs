#!/usr/bin/env node
// Compare a read-only live snapshot with one explicitly selected protocol-registry revision.
// Missing or unreachable fields remain unknown; they are never treated as healthy.
//
// Usage:
//   node script/stellar/verify-registry.mjs --live live.json \
//     --network stellar-testnet --revision git:<selected-commit>

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SDK = path.join(ROOT, "packages/protocol/dist/index.js");

function required(flag, args) {
  const i = args.indexOf(flag);
  if (i < 0 || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${flag} is required`);
  return args[i + 1];
}
function readJson(file) {
  if (!existsSync(file)) throw new Error(`no file at ${file}`);
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`cannot parse ${file}: ${error.message}`); }
}
function unavailable(value) {
  return value === undefined || value === null ||
    (value && typeof value === "object" && value.status === "unavailable");
}
function text(value) { return value === undefined || value === null ? "" : String(value).trim(); }
function same(left, right) { return text(left).toLowerCase() === text(right).toLowerCase(); }
function compare(results, field, live, expected, provenance) {
  if (unavailable(live)) results.push({ field, state: "unknown", live: null, expected, provenance });
  else if (same(live, expected)) results.push({ field, state: provenance.confirmed ? "verified" : "inferred", live, expected, provenance });
  else results.push({ field, state: "drift", live, expected, provenance });
}

try {
  const args = process.argv.slice(2);
  const liveFile = required("--live", args);
  const network = required("--network", args);
  const revision = required("--revision", args);
  if (!revision.trim()) throw new Error("--revision must identify the selected SDK registry revision");
  if (!existsSync(SDK)) throw new Error(`protocol SDK is not built at ${SDK}; build the selected revision first`);

  const live = readJson(liveFile);
  const registry = await import(SDK);
  const chain = registry.chainByKey(network);
  if (!chain) throw new Error(`unknown registry chain ${network}`);
  if (live.network && live.network !== network) throw new Error(`live snapshot names ${live.network}, expected ${network}`);
  const results = [];
  const chainProvenance = { confirmed: true, source: "protocol chain registry" };
  compare(results, "network.passphrase", live.networkPassphrase, chain.networkPassphrase, chainProvenance);
  compare(results, "network.axelarName", live.axelarName, chain.axelarName, chainProvenance);
  if (chain.cctpDomain !== null) compare(results, "network.cctpDomain", live.cctpDomain, chain.cctpDomain, chainProvenance);

  for (const asset of registry.assetsOn(network)) {
    const liveAsset = live.tokens?.[asset.symbol];
    const provenance = { confirmed: asset.confirmed, source: asset.source };
    compare(results, `token.${asset.symbol}.code`, liveAsset?.code, asset.family === "stellar" ? asset.code : asset.symbol, provenance);
    if (asset.family === "stellar") {
      compare(results, `token.${asset.symbol}.issuer`, liveAsset?.issuer, asset.issuer, provenance);
      if (asset.sacId) compare(results, `token.${asset.symbol}.sacId`, liveAsset?.sacId, asset.sacId, provenance);
    } else compare(results, `token.${asset.symbol}.address`, liveAsset?.address, asset.address, provenance);
    compare(results, `token.${asset.symbol}.decimals`, liveAsset?.decimals, asset.decimals, provenance);
  }

  for (const [slug, expected] of Object.entries(registry.railContracts(network) ?? {})) {
    if (!expected?.axelar) continue;
    // The registry calls this family `axelar`; deployment records and snapshots call the
    // executable ITS lane `axelar-its`.
    const providerKey = slug === "axelar" ? "axelar-its" : slug;
    const liveProvider = live.providers?.[providerKey];
    const provenance = { confirmed: expected.confirmed, source: expected.source };
    compare(results, `provider.${providerKey}.address`, liveProvider?.address, expected.axelar.interchainTokenService, provenance);
    compare(results, `provider.${providerKey}.chainName`, liveProvider?.chainName, expected.axelar.chainName, provenance);
    compare(results, `provider.${providerKey}.gasService`, liveProvider?.gasService, expected.axelar.gasService, provenance);
    if (expected.axelar.gateway) compare(results, `provider.${providerKey}.gateway`, liveProvider?.gateway, expected.axelar.gateway, provenance);
  }

  const states = ["verified", "inferred", "unknown", "drift"];
  const summary = {
    registryRevision: revision,
    network,
    results,
    counts: Object.fromEntries(states.map((state) => [state, results.filter((r) => r.state === state).length])),
    healthy: results.every((result) => result.state !== "drift"),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.healthy) process.exitCode = 1;
} catch (error) {
  console.error(`verify-registry: ${error.message}`);
  process.exitCode = 2;
}
