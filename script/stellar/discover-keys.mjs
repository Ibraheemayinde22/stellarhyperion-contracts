#!/usr/bin/env node
// Read-only numeric-key discovery uses the router's rollback-safe monotonic sequence indexes.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const U64 = 18446744073709551615n;
function unsigned(value, maximum = U64) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(value) ||
    BigInt(value) > maximum
  )
    throw new Error("Expected exact unsigned decimal integer");
  return BigInt(value);
}
export async function discoverKeys(request, view) {
  const family = request?.family;
  if (!["claim", "transfer"].includes(family))
    throw new Error("Choose claim or transfer keys");
  if (
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 32
  )
    throw new Error("Discovery limit must be 1–32");
  const start = unsigned(request.cursor ?? "0", U64 + 1n) || 1n;
  const raw = String(
    await view(family === "claim" ? "claim_count" : "last_out_nonce", {}),
  ).trim();
  const high = unsigned(raw.startsWith('"') ? JSON.parse(raw) : raw);
  const end =
    start + BigInt(request.limit) > high + 1n
      ? high + 1n
      : start + BigInt(request.limit);
  const keys = [];
  for (let id = start; id < end; id++) {
    const item = { id: id.toString(), family, state: "unavailable" };
    try {
      const rawRecord = await view(
        family === "claim" ? "get_claim" : "get_transfer",
        family === "claim" ? { id: id.toString() } : { nonce: id.toString() },
      );
      // Only boolean settlement is used; token amounts remain in the authoritative contract.
      const record = JSON.parse(rawRecord);
      if (family === "claim") {
        if (typeof record.settled !== "boolean")
          throw new Error("Invalid claim response");
        item.state = record.settled ? "settled" : "open";
      } else item.state = "recorded";
    } catch {
      item.reason =
        "A failed view does not prove deletion or archival; use RPC footprint inspection";
    }
    keys.push(item);
  }
  return {
    version: 1,
    family,
    keys,
    observedHighWatermark: high.toString(),
    nextCursor: (end > start ? end : start).toString(),
    exhausted: end > high,
    nextStep:
      "Persist nextCursor; continue from that monotonic ID when new records arrive",
  };
}
export function cliView(contract, network = "testnet") {
  if (typeof contract !== "string" || !/^C[A-Z2-7]{55}$/.test(contract))
    throw new Error("Expected a Stellar contract address");
  if (!["testnet", "futurenet", "mainnet", "local"].includes(network))
    throw new Error("Unsupported named network");
  return async (method, values) =>
    execFileSync(
      "stellar",
      [
        "contract",
        "invoke",
        "--id",
        contract,
        "--network",
        network,
        "--is-view",
        "--",
        method,
        ...Object.entries(values).flatMap(([key, value]) => [
          `--${key}`,
          value,
        ]),
      ],
      { encoding: "utf8", timeout: 20000, maxBuffer: 1048576 },
    );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [
      contract,
      family,
      cursor = "0",
      rawLimit = "10",
      network = "testnet",
      ...extra
    ] = process.argv.slice(2);
    if (extra.length || !/^[1-9][0-9]?$/.test(rawLimit))
      throw new Error(
        "Usage: node script/stellar/discover-keys.mjs CONTRACT claim|transfer CURSOR LIMIT NETWORK",
      );
    process.stdout.write(
      JSON.stringify(
        await discoverKeys(
          { family, cursor, limit: Number(rawLimit) },
          cliView(contract, network),
        ),
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
