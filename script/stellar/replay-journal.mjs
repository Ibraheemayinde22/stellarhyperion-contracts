#!/usr/bin/env node
// Read-only bounded replay-event export. Persist each entire page before its cursor.
import { pathToFileURL } from "node:url";
import { cliCodec, rpcClient } from "./restore-plan.mjs";

export async function replayJournal(request, rpc, codec = cliCodec) {
  const { contract, cursor, startLedger, limit = 32 } = request ?? {};
  if (typeof contract !== "string" || !/^C[A-Z2-7]{55}$/.test(contract))
    throw new Error("Expected a Stellar contract address");
  if (!Number.isInteger(limit) || limit < 1 || limit > 32)
    throw new Error("Journal limit must be 1–32");
  if (
    cursor !== undefined &&
    (typeof cursor !== "string" || !/^[0-9-]{1,100}$/.test(cursor))
  )
    throw new Error("Invalid journal cursor");
  if (
    cursor === undefined &&
    (!Number.isInteger(startLedger) ||
      startLedger < 1 ||
      startLedger > 4294967295)
  )
    throw new Error("Supply a start ledger or saved cursor");
  const topics = ["hyperion", "replay"].map((symbol) =>
    codec.encode("ScVal", { symbol }),
  );
  const result = await rpc("getEvents", {
    ...(cursor === undefined ? { startLedger } : {}),
    filters: [{ type: "contract", contractIds: [contract], topics: [topics] }],
    pagination: { ...(cursor === undefined ? {} : { cursor }), limit },
  });
  if (
    !Array.isArray(result.events) ||
    result.events.length > limit ||
    !Number.isInteger(result.latestLedger) ||
    result.latestLedger < 1
  )
    throw new Error("Invalid journal response");
  const seen = new Set();
  const records = result.events.map((event) => {
    if (
      event.contractId !== contract ||
      event.type !== "contract" ||
      event.inSuccessfulContractCall !== true ||
      !Array.isArray(event.topic) ||
      event.topic.length !== 4 ||
      !Number.isInteger(event.ledger) ||
      event.ledger < 1 ||
      event.ledger > result.latestLedger ||
      typeof event.pagingToken !== "string" ||
      !/^[0-9-]{1,100}$/.test(event.pagingToken) ||
      seen.has(event.pagingToken)
    )
      throw new Error("Invalid replay event provenance");
    seen.add(event.pagingToken);
    const decoded = event.topic.map((topic) => codec.decode("ScVal", topic));
    const route = decoded[2]?.u32;
    const bytes = decoded[3]?.bytes;
    if (
      decoded[0]?.symbol !== "hyperion" ||
      decoded[1]?.symbol !== "replay" ||
      !Number.isInteger(route) ||
      route < 0 ||
      route > 3 ||
      typeof bytes !== "string" ||
      !/^[a-fA-F0-9]{64}$/.test(bytes)
    )
      throw new Error("Invalid route-scoped replay identity");
    const data = codec.decode("ScVal", event.value)?.map;
    if (
      !Array.isArray(data) ||
      data.length !== 3 ||
      new Set(data.map((item) => item.key?.symbol)).size !== 3
    )
      throw new Error("Invalid replay event data");
    const fields = Object.fromEntries(
      data.map((item) => [item.key?.symbol, item.val]),
    );
    if (
      fields.version?.u32 !== 1 ||
      fields.ledger?.u32 !== event.ledger ||
      (typeof fields.timestamp?.u64 !== "number" &&
        typeof fields.timestamp?.u64 !== "string") ||
      !/^[0-9]{1,20}$/.test(String(fields.timestamp?.u64)) ||
      BigInt(fields.timestamp.u64) > 18446744073709551615n ||
      (typeof fields.timestamp.u64 === "number" &&
        !Number.isSafeInteger(fields.timestamp.u64))
    )
      throw new Error("Unsupported replay event version or exact timestamp");
    const ledgerKey = codec.encode("LedgerKey", {
      contract_data: {
        contract,
        durability: "persistent",
        key: { vec: [{ symbol: "Processed" }, decoded[2], decoded[3]] },
      },
    });
    return {
      contract,
      route,
      messageIdHex: bytes.toLowerCase(),
      ledger: event.ledger,
      timestamp: String(fields.timestamp.u64),
      ledgerKey,
      event,
    };
  });
  const nextCursor = records.length
    ? records.at(-1).event.pagingToken
    : (cursor ?? null);
  return {
    version: 1,
    contract,
    records,
    latestLedger: result.latestLedger,
    nextCursor,
    caughtUp: records.length < limit,
    nextStep:
      "Atomically persist this complete page before its cursor; archive events before RPC retention expires. Never recreate a tombstone from an event; restore its original ledger entry and re-simulate.",
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [url, contract, position, ...extra] = process.argv.slice(2);
    if (!url || !position || extra.length)
      throw new Error(
        "Usage: replay-journal.mjs RPC_URL CONTRACT ledger:NUMBER|cursor:TOKEN",
      );
    const request = position.startsWith("ledger:")
      ? { contract, startLedger: Number(position.slice(7)) }
      : position.startsWith("cursor:")
        ? { contract, cursor: position.slice(7) }
        : null;
    process.stdout.write(
      JSON.stringify(await replayJournal(request, rpcClient(url)), null, 2) +
        "\n",
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
