#!/usr/bin/env node
/** Validate an unsigned transfer intent against public source and independent destination evidence. */
import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readBoundedText } from "./record-evidence.mjs";
import { validStellarRecipient } from "./reconcile-axelar.mjs";

const PASS_PHRASE = "Test SDF Network ; September 2015";
const DESTINATIONS = Object.freeze({
  sepolia: "11155111",
  "base-sepolia": "84532",
  "arc-testnet": "5042002",
});
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const HASH = /^[a-f0-9]{64}$/i;
const ADDRESS = /^0x[a-f0-9]{40}$/i;
const ACCOUNT = /^G[A-Z2-7]{55}$/;
const CONTRACT = /^C[A-Z2-7]{55}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const UINT256_MAX = (1n << 256n) - 1n;

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value;
}

function exactKeys(value, keys, name) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    throw new Error(`${name} must contain exactly: ${expected.join(", ")}`);
}

function text(value, name, pattern = null) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (pattern && !pattern.test(value))
  )
    throw new Error(`${name} is invalid`);
  return value;
}

function amount(value, name) {
  text(value, name, DECIMAL);
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > UINT256_MAX)
    throw new Error(`${name} must be a positive uint256 decimal string`);
  return value;
}

function checkedAt(value, name) {
  text(value, name, ISO_DATE);
  if (!Number.isFinite(Date.parse(value)))
    throw new Error(`${name} must be an ISO-8601 UTC timestamp`);
}

function canonicalIntent(input) {
  const intent = object(input, "intent");
  exactKeys(
    intent,
    [
      "schemaVersion",
      "rail",
      "source",
      "destination",
      "recipient",
      ...(Object.hasOwn(intent, "intentId") ? ["intentId"] : []),
    ],
    "intent",
  );
  if (intent.schemaVersion !== 1)
    throw new Error("intent.schemaVersion must be 1");
  if (!["axelar-its", "cctp"].includes(intent.rail))
    throw new Error("intent.rail must be axelar-its or cctp");
  const source = object(intent.source, "intent.source");
  exactKeys(
    source,
    ["network", "networkPassphrase", "sender", "asset", "decimals", "amount"],
    "intent.source",
  );
  if (source.network !== "stellar-testnet")
    throw new Error("intent.source.network must be stellar-testnet");
  if (source.networkPassphrase !== PASS_PHRASE)
    throw new Error("intent.source.networkPassphrase is not Stellar Testnet");
  text(source.sender, "intent.source.sender", ACCOUNT);
  if (validStellarRecipient(source.sender) !== 0)
    throw new Error("intent.source.sender must be a valid Stellar account");
  text(source.asset, "intent.source.asset", CONTRACT);
  if (validStellarRecipient(source.asset) !== 1)
    throw new Error("intent.source.asset must be a valid Stellar contract ID");
  if (source.decimals !== 7)
    throw new Error("intent.source.decimals must be 7 for Stellar assets");
  amount(source.amount, "intent.source.amount");

  const destination = object(intent.destination, "intent.destination");
  exactKeys(
    destination,
    ["network", "chainId", "asset", "decimals", "amount"],
    "intent.destination",
  );
  if (!Object.hasOwn(DESTINATIONS, destination.network))
    throw new Error("intent.destination.network is not an admitted testnet");
  if (destination.chainId !== DESTINATIONS[destination.network])
    throw new Error("intent.destination.chainId does not match its network");
  if (!ADDRESS.test(destination.asset) || /^0x0{40}$/i.test(destination.asset))
    throw new Error("intent.destination.asset must be a nonzero token address");
  if (
    !Number.isInteger(destination.decimals) ||
    destination.decimals < 0 ||
    destination.decimals > 36
  )
    throw new Error("intent.destination.decimals must be an integer from 0 to 36");
  amount(destination.amount, "intent.destination.amount");
  if (intent.rail === "axelar-its" && destination.network !== "sepolia")
    throw new Error("the active ITS lane is only admitted for Sepolia");
  text(intent.recipient, "intent.recipient", ADDRESS);
  if (/^0x0{40}$/i.test(intent.recipient))
    throw new Error("intent.recipient must not be the zero address");

  return {
    schemaVersion: 1,
    rail: intent.rail,
    source: {
      network: source.network,
      networkPassphrase: source.networkPassphrase,
      sender: source.sender,
      asset: source.asset,
      decimals: source.decimals,
      amount: source.amount,
    },
    destination: {
      network: destination.network,
      chainId: destination.chainId,
      asset: destination.asset.toLowerCase(),
      decimals: destination.decimals,
      amount: destination.amount,
    },
    recipient: intent.recipient.toLowerCase(),
  };
}

export function createIntent(input) {
  const canonical = canonicalIntent(input);
  return {
    ...canonical,
    intentId: createHash("sha256")
      .update(JSON.stringify(canonical))
      .digest("hex"),
  };
}

function validateIntent(input) {
  const canonical = canonicalIntent(input);
  const expected = createIntent(canonical).intentId;
  if (input.intentId !== expected)
    throw new Error("intent.intentId does not match the canonical intent");
  return { ...canonical, intentId: expected };
}

function validateObservation(value, name, kind) {
  const observation = object(value, name);
  exactKeys(observation, ["kind", "provider", "checkedAt"], name);
  if (observation.kind !== kind)
    throw new Error(`${name}.kind must be ${kind}`);
  text(observation.provider, `${name}.provider`);
  if (
    /mock|fixture|local|localhost|127\.0\.0\.1|test-double/i.test(
      observation.provider,
    )
  )
    throw new Error(`${name}.provider must identify a public independent provider`);
  checkedAt(observation.checkedAt, `${name}.checkedAt`);
  return observation;
}

function validateSource(intent, input) {
  const source = object(input, "source evidence");
  exactKeys(
    source,
    [
      "intentId",
      "network",
      "networkPassphrase",
      "transactionHash",
      "status",
      "ledger",
      "sender",
      "recipient",
      "asset",
      "amount",
      "observation",
    ],
    "source evidence",
  );
  if (source.intentId !== intent.intentId)
    throw new Error("source evidence belongs to a different intent");
  if (
    source.network !== intent.source.network ||
    source.networkPassphrase !== intent.source.networkPassphrase
  )
    throw new Error("source evidence network binding mismatch");
  text(source.transactionHash, "source.transactionHash", HASH);
  if (source.status !== "SUCCESS")
    throw new Error("source transaction is not confirmed successful");
  text(source.ledger, "source.ledger", DECIMAL);
  if (BigInt(source.ledger) < 1n || BigInt(source.ledger) > 0xffffffffn)
    throw new Error("source.ledger must be a positive u32");
  if (source.sender !== intent.source.sender)
    throw new Error("source sender does not match the intent");
  if (
    text(source.recipient, "source.recipient", ADDRESS).toLowerCase() !==
    intent.recipient
  )
    throw new Error("source recipient does not match the intent");
  if (source.asset !== intent.source.asset)
    throw new Error("source asset does not match the intent");
  if (amount(source.amount, "source.amount") !== intent.source.amount)
    throw new Error("source amount does not match the intent");
  const observation = validateObservation(
    source.observation,
    "source.observation",
    "public-rpc",
  );
  return { transactionHash: source.transactionHash.toLowerCase(), observation };
}

function validateDestination(intent, source, input) {
  const destination = object(input, "destination evidence");
  exactKeys(
    destination,
    [
      "intentId",
      "network",
      "chainId",
      "transactionHash",
      "status",
      "block",
      "confirmations",
      "sourceHash",
      "recipient",
      "asset",
      "amount",
      "receiptStatus",
      "observation",
    ],
    "destination evidence",
  );
  if (destination.intentId !== intent.intentId)
    throw new Error("destination evidence belongs to a different intent");
  if (
    destination.network !== intent.destination.network ||
    destination.chainId !== intent.destination.chainId
  )
    throw new Error("destination network binding mismatch");
  text(
    destination.transactionHash,
    "destination.transactionHash",
    /^0x[a-f0-9]{64}$/i,
  );
  if (
    destination.status !== "success" ||
    destination.receiptStatus !== "success"
  )
    throw new Error("destination transaction receipt is not successful");
  text(destination.block, "destination.block", DECIMAL);
  if (BigInt(destination.block) < 1n || BigInt(destination.block) > UINT256_MAX)
    throw new Error("destination.block must be a positive uint256");
  if (
    !Number.isSafeInteger(destination.confirmations) ||
    destination.confirmations < 1
  )
    throw new Error("destination.confirmations must be a positive safe integer");
  if (
    text(destination.sourceHash, "destination.sourceHash", HASH).toLowerCase() !==
    source.transactionHash
  )
    throw new Error("destination evidence references a different source transaction");
  if (
    text(destination.recipient, "destination.recipient", ADDRESS).toLowerCase() !==
    intent.recipient
  )
    throw new Error("destination recipient does not match the intent");
  if (
    text(destination.asset, "destination.asset", ADDRESS).toLowerCase() !==
    intent.destination.asset
  )
    throw new Error("destination asset does not match the intent");
  if (
    amount(destination.amount, "destination.amount") !==
    intent.destination.amount
  )
    throw new Error("destination amount does not match the intent");
  const observation = validateObservation(
    destination.observation,
    "destination.observation",
    "independent-rpc",
  );
  if (observation.provider === source.observation.provider)
    throw new Error("destination verification must use an independent provider");
  return {
    transactionHash: destination.transactionHash.toLowerCase(),
    observation,
  };
}

export function validateTransferEvidence(
  intentInput,
  sourceInput,
  destinationInput = null,
) {
  const intent = validateIntent(intentInput);
  const source = validateSource(intent, sourceInput);
  const result = {
    schemaVersion: 1,
    intentId: intent.intentId,
    status: "source-confirmed",
    delivered: false,
    bindings: {
      sourceNetwork: intent.source.network,
      sourceAsset: intent.source.asset,
      sourceAmount: intent.source.amount,
      destinationNetwork: intent.destination.network,
      destinationChainId: intent.destination.chainId,
      destinationAsset: intent.destination.asset,
      destinationAmount: intent.destination.amount,
      recipient: intent.recipient,
    },
    source: { transactionHash: source.transactionHash },
  };
  if (destinationInput === null || destinationInput === undefined) {
    result.reason = "destination-evidence-missing";
    return result;
  }
  const destination = validateDestination(intent, source, destinationInput);
  result.status = "delivered";
  result.delivered = true;
  result.destination = { transactionHash: destination.transactionHash };
  return result;
}

function jsonFile(path) {
  return JSON.parse(readBoundedText(path));
}

function writeNewFile(path, contents) {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function usage() {
  throw new Error(
    "usage: transfer-evidence.mjs --plan INTENT.json [--out FILE] | --verify --intent INTENT.json --source SOURCE.json [--destination DESTINATION.json] | --record RECORD.json --network NETWORK_KEY",
  );
}

export function runCli(argv = process.argv.slice(2)) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (
      ![
        "--plan",
        "--out",
        "--verify",
        "--intent",
        "--source",
        "--destination",
        "--record",
        "--network",
      ].includes(key)
    )
      usage();
    if (key === "--verify") {
      if (values.verify) usage();
      values.verify = true;
      continue;
    }
    if (values[key]) usage();
    values[key] = argv[++i];
    if (!values[key] || values[key].startsWith("--")) usage();
  }

  if (values["--plan"]) {
    if (
      values.verify ||
      values["--intent"] ||
      values["--source"] ||
      values["--destination"] ||
      values["--record"] ||
      values["--network"]
    )
      usage();
    const intent = createIntent(jsonFile(values["--plan"]));
    const output = `${JSON.stringify(intent, null, 2)}\n`;
    if (values["--out"]) writeNewFile(resolve(values["--out"]), output);
    process.stdout.write(output);
    return { status: "planned", intentId: intent.intentId };
  }

  let result;
  if (values.verify) {
    if (
      !values["--intent"] ||
      !values["--source"] ||
      values["--out"] ||
      values["--record"] ||
      values["--network"]
    )
      usage();
    result = validateTransferEvidence(
      jsonFile(values["--intent"]),
      jsonFile(values["--source"]),
      values["--destination"] ? jsonFile(values["--destination"]) : null,
    );
  } else if (values["--record"]) {
    if (
      !values["--network"] ||
      values["--intent"] ||
      values["--source"] ||
      values["--destination"] ||
      values["--out"]
    )
      usage();
    const record = jsonFile(values["--record"]);
    const deployment = record.networks?.[values["--network"]];
    if (!deployment || typeof deployment !== "object")
      throw new Error("record does not contain the requested network");
    const transfer = deployment.transferEvidence;
    if (!transfer) {
      result = { status: "not-provided", delivered: false };
    } else {
      result = validateTransferEvidence(
        transfer.intent,
        transfer.source,
        transfer.destination ?? null,
      );
    }
  } else {
    usage();
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.delivered && result.status !== "not-provided") process.exitCode = 2;
  return result;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`transfer-evidence: ${error.message}\n`);
    process.exitCode = 1;
  }
}
