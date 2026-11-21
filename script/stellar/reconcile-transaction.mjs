#!/usr/bin/env node
/** Reconcile a public transaction evidence record without proposing a replacement operation. */

const HASH = /^[a-fA-F0-9]{64}$/;

function sameConfig(expected, actual) {
  if (!expected || !actual || typeof expected !== "object" || typeof actual !== "object") return false;
  const keys = Object.keys(expected);
  return keys.length > 0 && keys.every((key) => JSON.stringify(expected[key]) === JSON.stringify(actual[key]));
}

/**
 * Classify an RPC result. Unknown is deliberately non-actionable: callers must not resubmit it.
 * The RPC adapter is injected so this function remains read-only and easy to use with Stellar RPC.
 */
export function reconcileTransaction(evidence) {
  if (!evidence || typeof evidence !== "object") throw new TypeError("transaction evidence must be an object");
  const { expectedHash, expectedNetwork, expectedSender, expectedConfig, transaction, liveConfig } = evidence;
  if (typeof expectedHash !== "string" || !HASH.test(expectedHash)) throw new TypeError("expectedHash is invalid");
  if (typeof expectedNetwork !== "string" || expectedNetwork.length === 0) throw new TypeError("expectedNetwork is required");
  if (typeof expectedSender !== "string" || expectedSender.length === 0) throw new TypeError("expectedSender is required");
  if (transaction === null || transaction === undefined) return { status: "unknown", reason: "transaction-not-found" };
  if (typeof transaction !== "object") throw new TypeError("transaction response is invalid");
  if (transaction.hash !== expectedHash) return { status: "unknown", reason: "hash-mismatch" };
  if (transaction.network !== expectedNetwork) return { status: "unknown", reason: "network-mismatch" };
  if (transaction.source !== expectedSender) return { status: "unknown", reason: "sender-mismatch" };
  if (transaction.status === "FAILED") return { status: "failed", reason: "transaction-failed" };
  if (transaction.status !== "SUCCESS") return { status: "unknown", reason: "unfinalized-status" };
  if (!sameConfig(expectedConfig, liveConfig)) return { status: "unknown", reason: "configuration-mismatch" };
  return { status: "confirmed", reason: "hash-network-sender-and-configuration-match" };
}

if (process.argv[1]?.endsWith("reconcile-transaction.mjs")) {
  const path = process.argv[2];
  if (!path) throw new Error("usage: reconcile-transaction.mjs EVIDENCE.json");
  const evidence = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
  process.stdout.write(`${JSON.stringify(reconcileTransaction(evidence), null, 2)}\n`);
}
