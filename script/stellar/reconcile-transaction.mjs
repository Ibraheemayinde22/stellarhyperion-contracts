#!/usr/bin/env node
/** Read-only transaction and configuration evidence. Unknown outcomes never authorize retry. */
import { execFileSync } from "node:child_process";
import {
  openSync,
  closeSync,
  readFileSync,
  fstatSync,
  constants,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { cliCodec, rpcClient } from "./restore-plan.mjs";
const HASH = /^[a-f0-9]{64}$/i;
const plain = (v) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
function canonical(v, depth = 0) {
  if (depth > 16) throw new Error("configuration is too deeply nested");
  if (Array.isArray(v)) return v.map((entry) => canonical(entry, depth + 1));
  if (plain(v))
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((key) => [key, canonical(v[key], depth + 1)]),
    );
  if (
    v === null ||
    typeof v === "string" ||
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isSafeInteger(v))
  )
    return v;
  throw new Error("invalid configuration value");
}
function sameConfig(expected, actual) {
  return (
    validConfig(expected) &&
    validConfig(actual) &&
    Object.keys(expected).every(
      (key) =>
        JSON.stringify(canonical(expected[key])) ===
        JSON.stringify(canonical(actual[key])),
    )
  );
}
function validConfig(value) {
  const keys = [
    "admin",
    "guardian",
    "treasury",
    "fee_bps",
    "flow_window_ledgers",
    "timelock_delay",
    "paused",
  ];
  if (
    !plain(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    return false;
  if (
    !["admin", "guardian", "treasury"].every(
      (key) =>
        typeof value[key] === "string" && /^[GC][A-Z2-7]{55}$/.test(value[key]),
    )
  )
    return false;
  if (
    !Number.isSafeInteger(value.fee_bps) ||
    value.fee_bps < 0 ||
    value.fee_bps > 100 ||
    !Number.isSafeInteger(value.flow_window_ledgers) ||
    value.flow_window_ledgers < 1 ||
    value.flow_window_ledgers > 4294967295 ||
    typeof value.paused !== "boolean"
  )
    return false;
  const delay = value.timelock_delay;
  if (!(
    (typeof delay === "number" && Number.isSafeInteger(delay)) ||
    (typeof delay === "string" && /^[0-9]{1,20}$/.test(delay))
  ))
    return false;
  return BigInt(delay) >= 3600n && BigInt(delay) <= 18446744073709551615n;
}
function validate(evidence) {
  if (
    !plain(evidence) ||
    typeof evidence.expectedHash !== "string" ||
    !HASH.test(evidence.expectedHash)
  )
    throw new Error("expectedHash must be a transaction hash");
  if (
    typeof evidence.expectedNetwork !== "string" ||
    !evidence.expectedNetwork.length ||
    evidence.expectedNetwork.length > 256
  )
    throw new Error("expectedNetwork must be the exact network passphrase");
  if (
    typeof evidence.expectedSender !== "string" ||
    !/^G[A-Z2-7]{55}$/.test(evidence.expectedSender)
  )
    throw new Error("expectedSender must be a public account");
  if (!validConfig(evidence.expectedConfig))
    throw new Error(
      "expectedConfig must contain the complete validated router get_config schema",
    );
  canonical(evidence.expectedConfig);
}
export function verifyEnvelope(envelopeXdr, passphrase) {
  if (
    typeof envelopeXdr !== "string" ||
    envelopeXdr.length > 262144 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(envelopeXdr) ||
    Buffer.from(envelopeXdr, "base64").toString("base64") !== envelopeXdr
  )
    throw new Error("invalid transaction envelope XDR");
  const envelope = cliCodec.decode("TransactionEnvelope", envelopeXdr);
  const tx = envelope?.tx?.tx ?? envelope?.tx_fee_bump?.tx?.inner_tx?.tx?.tx;
  if (!plain(tx) || typeof tx.source_account !== "string")
    throw new Error("unsupported transaction envelope or source");
  const hash = execFileSync(
    "stellar",
    ["tx", "hash", "--network-passphrase", passphrase],
    {
      input: envelopeXdr,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024,
      stdio: ["pipe", "pipe", "ignore"],
    },
  )
    .trim()
    .toLowerCase();
  if (!HASH.test(hash)) throw new Error("invalid envelope hash result");
  return { hash, source: tx.source_account };
}
export function reconcileTransaction(
  evidence,
  { envelopeVerifier = verifyEnvelope } = {},
) {
  validate(evidence);
  const unknown = (reason) => ({
    status: "unknown",
    reason,
    retryAllowed: false,
  });
  const tx = evidence.transaction;
  if (tx === null || tx === undefined || tx.status === "NOT_FOUND")
    return unknown("transaction-not-found-or-outside-retention");
  if (!plain(tx)) throw new Error("malformed transaction response");
  if (evidence.observedNetwork !== evidence.expectedNetwork)
    return unknown("network-mismatch-or-unavailable");
  let decoded;
  try {
    decoded = envelopeVerifier(tx.envelopeXdr, evidence.expectedNetwork);
  } catch {
    return unknown("envelope-evidence-unavailable-or-invalid");
  }
  if (decoded.hash !== evidence.expectedHash.toLowerCase())
    return unknown("envelope-hash-mismatch");
  if (decoded.source !== evidence.expectedSender)
    return unknown("envelope-sender-mismatch");
  if (tx.status === "FAILED")
    return {
      status: "failed",
      reason: "matching-transaction-failed",
      retryAllowed: false,
    };
  if (tx.status !== "SUCCESS") return unknown("unfinalized-status");
  if (!sameConfig(evidence.expectedConfig, evidence.liveConfig))
    return unknown("configuration-mismatch-or-unavailable");
  return {
    status: "confirmed",
    reason: "envelope-network-sender-and-live-configuration-match",
    retryAllowed: false,
    transactionHash: decoded.hash,
  };
}
export async function reconcileLive(
  request,
  { rpc, envelopeVerifier, configReader } = {},
) {
  validate(request);
  if (!/^C[A-Z2-7]{55}$/.test(request.contractId ?? ""))
    throw new Error("contractId must be the configuration contract");
  const endpoint = new URL(request.rpcUrl);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      "RPC credentials belong in secure provider configuration, not evidence files",
    );
  const client = rpc ?? rpcClient(endpoint.href);
  let network;
  try {
    network = await client("getNetwork", {});
  } catch {
    return {
      status: "unknown",
      reason: "network-read-unavailable",
      retryAllowed: false,
      evidenceOrigin: "live-rpc",
    };
  }
  if (network.passphrase !== request.expectedNetwork)
    return {
      status: "unknown",
      reason: "network-mismatch",
      retryAllowed: false,
      evidenceOrigin: "live-rpc",
    };
  let transaction, liveConfig;
  try {
    transaction = await client("getTransaction", {
      hash: request.expectedHash.toLowerCase(),
    });
  } catch {
    transaction = null;
  }
  if (transaction?.status === "SUCCESS") {
    try {
      liveConfig = configReader
        ? await configReader(request)
        : JSON.parse(
            execFileSync(
              "stellar",
              [
                "contract",
                "invoke",
                "--id",
                request.contractId,
                "--rpc-url",
                endpoint.href,
                "--network-passphrase",
                request.expectedNetwork,
                "--source-account",
                request.expectedSender,
                "--is-view",
                "--",
                "get_config",
              ],
              {
                encoding: "utf8",
                timeout: 20000,
                maxBuffer: 32768,
                stdio: ["ignore", "pipe", "ignore"],
              },
            ),
          );
    } catch {
      liveConfig = null;
    }
  }
  return {
    ...reconcileTransaction(
      {
        ...request,
        observedNetwork: network.passphrase,
        transaction,
        liveConfig,
      },
      { envelopeVerifier },
    ),
    evidenceOrigin: "live-rpc",
  };
}
function readEvidence(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 1048576)
      throw new Error("evidence must be a regular file below 1MiB");
    return JSON.parse(readFileSync(descriptor, "utf8"));
  } finally {
    closeSync(descriptor);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [mode, file, ...extra] = process.argv.slice(2);
    if (!["--rpc", "--recorded"].includes(mode) || !file || extra.length)
      throw new Error(
        "usage: reconcile-transaction.mjs --rpc REQUEST.json | --recorded EVIDENCE.json",
      );
    const request = readEvidence(file);
    const result =
      mode === "--rpc"
        ? await reconcileLive(request)
        : {
            ...reconcileTransaction(request),
            evidenceOrigin: "recorded-rpc-evidence",
          };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "confirmed") process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`reconcile-transaction: ${error.message}\n`);
    process.exitCode = 1;
  }
}
