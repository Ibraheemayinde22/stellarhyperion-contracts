#!/usr/bin/env node
// Read-only maintenance projections from recorded XDR footprints and RPC simulations.
import { openSync, readSync, closeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { cliCodec, rpcClient } from "./restore-plan.mjs";
const MAX_KEYS = 32;
function integer(value, name, max = 4294967295) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}
function xdr(value) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 262144 ||
    Buffer.from(value, "base64").toString("base64") !== value
  )
    throw new Error("Invalid bounded canonical XDR");
  return value;
}
function fee(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9]{1,19}$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new Error("Invalid exact simulation resource fee");
  return BigInt(value);
}
function footprint(value, codec) {
  const data = codec.decode("SorobanTransactionData", xdr(value));
  const fp = data?.resources?.footprint;
  if (
    !Array.isArray(fp?.read_only) ||
    !Array.isArray(fp?.read_write) ||
    fp.read_only.length + fp.read_write.length > MAX_KEYS
  )
    throw new Error("Invalid bounded simulation footprint");
  const keys = [...fp.read_only, ...fp.read_write].map((k) =>
    codec.encode("LedgerKey", k),
  );
  const indices = data.ext?.v1?.archived_soroban_entries ?? [];
  if (
    !Array.isArray(indices) ||
    indices.some(
      (i) => !Number.isSafeInteger(i) || i < 0 || i >= fp.read_write.length,
    )
  )
    throw new Error("Invalid archive indices");
  return {
    keys,
    archived: indices.map((i) => codec.encode("LedgerKey", fp.read_write[i])),
    resources: data.resources,
    readOnlyCount: fp.read_only.length,
  };
}
function category(key) {
  if (key.contract_code) return "code";
  if (key.contract_data?.durability !== "persistent")
    throw new Error("Only persistent contract keys are maintained");
  return key.contract_data.key === "ledger_key_contract_instance"
    ? "instance"
    : "persistent";
}
export function projectStorageCosts(record, codec = cliCodec) {
  if (
    record?.version !== 2 ||
    typeof record.network?.passphrase !== "string" ||
    !record.network.passphrase.length
  )
    throw new Error("Record version 2 and network passphrase required");
  integer(record.network.protocolVersion, "protocol version");
  const cycle = integer(record.assumptions?.cycleLedgers, "cycle ledgers");
  const annual = integer(
    record.assumptions?.ledgersPerYear,
    "annual ledger assumption",
  );
  if (
    !Array.isArray(record.scenarios) ||
    !record.scenarios.length ||
    record.scenarios.length > 16
  )
    throw new Error("Supply 1–16 bounded recorded scenarios");
  const scenarios = record.scenarios.map((s) => {
    if (
      typeof s.name !== "string" ||
      !s.name.length ||
      s.name.length > 120 ||
      !Array.isArray(s.keys) ||
      !s.keys.length ||
      s.keys.length > MAX_KEYS
    )
      throw new Error("Invalid scenario or key bound");
    const keys = s.keys.map(xdr);
    if (new Set(keys).size !== keys.length)
      throw new Error("Duplicate recorded key");
    const types = new Map(
      keys.map((k) => [k, category(codec.decode("LedgerKey", k))]),
    );
    const ledger = s.ledgerResponse;
    const sim = s.simulation;
    const latestLedger = integer(ledger?.latestLedger, "ledger");
    integer(sim?.latestLedger, "simulation ledger");
    if (Math.abs(latestLedger - sim.latestLedger) > 8)
      throw new Error("Stale simulation evidence");
    if (sim.error)
      throw new Error("Failed simulation is not a cost projection");
    const invoked = footprint(sim.transactionData, codec);
    const restore = sim.restorePreamble
      ? footprint(sim.restorePreamble.transactionData, codec)
      : { keys: [], archived: [] };
    if ([...invoked.keys, ...restore.keys].some((k) => !types.has(k)))
      throw new Error(
        "Simulation touched unrecorded keys; record the entire footprint",
      );
    if (restore.readOnlyCount)
      throw new Error("Restore preamble must use only read-write keys");
    const coveredKeys = new Set([...invoked.keys, ...restore.keys]);
    const archived = new Set([...invoked.archived, ...restore.keys]);
    if (!Array.isArray(ledger.entries) || ledger.entries.length > keys.length)
      throw new Error("Invalid ledger entries");
    const entries = new Map();
    for (const e of ledger.entries) {
      if (!types.has(e.key) || entries.has(e.key))
        throw new Error("Unrequested or duplicate ledger entry");
      const value = xdr(e.xdr);
      codec.decode("LedgerEntryData", value);
      integer(e.liveUntilLedgerSeq, "live-until ledger");
      if (e.liveUntilLedgerSeq < latestLedger || archived.has(e.key))
        throw new Error("Contradictory live/archive evidence");
      entries.set(e.key, {
        xdrBytes:
          Buffer.from(e.key, "base64").length +
          Buffer.from(value, "base64").length,
        remainingTtl: e.liveUntilLedgerSeq - latestLedger,
      });
    }
    const rows = keys.map((key) => ({
      key,
      storage: types.get(key),
      state: archived.has(key)
        ? "archived"
        : entries.has(key)
          ? "live"
          : "unavailable",
      xdrBytes: entries.get(key)?.xdrBytes ?? null,
      remainingTtl: entries.get(key)?.remainingTtl ?? null,
    }));
    const costs = {
      instance: { entries: 0, recordedXdrBytes: 0 },
      persistent: { entries: 0, recordedXdrBytes: 0 },
      code: { entries: 0, recordedXdrBytes: 0 },
      archived: { entries: 0, recordedXdrBytes: null },
      unavailable: { entries: 0, recordedXdrBytes: null },
    };
    for (const row of rows) {
      const c = costs[row.state === "live" ? row.storage : row.state];
      c.entries++;
      if (row.xdrBytes !== null) c.recordedXdrBytes += row.xdrBytes;
    }
    const maintenanceFee = fee(sim.minResourceFee);
    const restorationFee = sim.restorePreamble
      ? fee(sim.restorePreamble.minResourceFee)
      : null;
    return {
      name: s.name,
      latestLedger,
      simulationLedger: sim.latestLedger,
      categories: costs,
      records: rows,
      resources: invoked.resources,
      fees: {
        maintenanceResourceFeeStroops: maintenanceFee.toString(),
        restorationResourceFeeStroops: restorationFee?.toString() ?? null,
        projectedAnnualMaintenanceResourceFeeStroops: (
          maintenanceFee * BigInt(Math.ceil(annual / cycle))
        ).toString(),
      },
      automaticRestorationIncluded: invoked.archived.length > 0,
      footprintCoverageComplete: keys.every((k) => coveredKeys.has(k)),
      complete:
        rows.every((r) => r.state !== "unavailable") &&
        keys.every((k) => coveredKeys.has(k)),
    };
  });
  return {
    version: 2,
    network: record.network,
    assumptions: record.assumptions,
    scenarios,
    notes: [
      "Fees are exact recorded simulation resource fees, excluding inclusion bids.",
      "Annual projection repeats the recorded footprint and prices; resimulate as state or network settings change.",
      "Archived bytes remain null until restored; RPC absence never proves deletion.",
      "Instance rent uses persistent durability; category separation does not invent a separate price.",
    ],
  };
}
export async function captureStorageCosts(request, rpc) {
  if (
    !Array.isArray(request?.scenarios) ||
    !request.scenarios.length ||
    request.scenarios.length > 16
  )
    throw new Error("Supply bounded scenarios");
  const network = await rpc("getNetwork", {});
  const scenarios = [];
  for (const s of request.scenarios) {
    if (!Array.isArray(s.keys) || !s.keys.length || s.keys.length > MAX_KEYS)
      throw new Error("Supply 1–32 recorded keys per scenario");
    const keys = s.keys.map(xdr);
    const transaction = xdr(s.transaction);
    const simulation = await rpc("simulateTransaction", { transaction });
    const ledgerResponse = await rpc("getLedgerEntries", { keys });
    scenarios.push({ ...s, keys, simulation, ledgerResponse });
  }
  return { version: 2, network, assumptions: request.assumptions, scenarios };
}
function readRecord(file) {
  const fd = openSync(file, "r"),
    buffer = Buffer.alloc(1048577);
  let length = 0;
  try {
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
  } finally {
    closeSync(fd);
  }
  if (length > 1048576) throw new Error("Record exceeds 1MiB");
  return JSON.parse(buffer.subarray(0, length).toString("utf8"));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = process.argv.slice(2);
    let record;
    if (args.length === 2 && args[0] === "--record")
      record = readRecord(args[1]);
    else if (
      args.length === 4 &&
      args[0] === "--rpc" &&
      args[2] === "--request"
    )
      record = await captureStorageCosts(
        readRecord(args[3]),
        rpcClient(args[1]),
      );
    else
      throw new Error(
        "Usage: storage-cost.mjs --record recorded-rpc.json OR --rpc URL --request recorded-keysets.json",
      );
    process.stdout.write(
      JSON.stringify({ record, report: projectStorageCosts(record) }, null, 2) +
        "\n",
    );
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  }
}
