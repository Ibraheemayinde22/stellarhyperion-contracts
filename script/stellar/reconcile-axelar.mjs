#!/usr/bin/env node
/**
 * Axelar source-note and destination-payment reconciliation CLI.
 *
 * Joins encoded note intent with candidate ITS payment events for development evidence.
 * Verifies exact agreement on recipient, token ID, amount, and full command identity.
 * Partial or mismatched receipts are reported unverified.
 * Reports retain original raw references without relying on a display nonce.
 *
 * Active deployment is Stellar Testnet outbound ITS/CCTP; EVM and other rail development
 * remain explicitly gated until independently validated.
 */

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

// Self-contained note parsing and reconciliation helpers
const NOTE_VERSION = 1;
const OUTBOUND_NOTE_LEN = 29;
const INBOUND_NOTE_MIN = 1 + 3 + 8;

export function fromHex(hex) {
  if (typeof hex !== "string") throw new Error("Expected hex text");
  const clean = hex.replace(/^0x/i, "");
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean))
    throw new Error("Invalid hex payload");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function toHex(bytes) {
  let hex = "0x";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function bytesToBigInt(bytes) {
  let val = 0n;
  for (let i = 0; i < bytes.length; i++) {
    val = (val << 8n) | BigInt(bytes[i]);
  }
  return val;
}

export function bytesToAscii(bytes) {
  let str = "";
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return str;
}

export function decodeOutboundNote(payload) {
  const bytes = typeof payload === "string" ? fromHex(payload) : payload;
  if (bytes.length !== OUTBOUND_NOTE_LEN) {
    throw new Error(
      `Outbound note must be exactly ${OUTBOUND_NOTE_LEN} bytes, got ${bytes.length}`,
    );
  }
  if (bytes[0] !== NOTE_VERSION) {
    throw new Error(
      `Unsupported note version: ${bytes[0]}, expected ${NOTE_VERSION}`,
    );
  }
  const recipient = toHex(bytes.slice(1, 21));
  if (bytesToBigInt(bytes.slice(1, 21)) === 0n) {
    throw new Error("ZeroAddressKey: recipient cannot be zero address");
  }
  const nonce = bytesToBigInt(bytes.slice(21, 29));
  return { recipient, nonce };
}

// Independent SEP-23 decoding for the standalone Node CLI; SDK parity fixtures cover both paths.
function validStellarRecipient(value) {
  if (typeof value !== "string" || ![56, 69].includes(value.length))
    throw new Error("invalid strkey length");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let accumulator = 0,
    bits = 0;
  const bytes = [];
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("invalid strkey character");
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 255);
    }
  }
  if ((accumulator & ((1 << bits) - 1)) !== 0)
    throw new Error("noncanonical strkey padding");
  const kind = { 48: 0, 16: 1, 96: 2 }[bytes[0]];
  if (kind === undefined || (kind === 2) !== (value.length === 69))
    throw new Error("invalid strkey version");
  if (bytes.slice(1, 33).every((byte) => byte === 0))
    throw new Error("ZeroAddressKey");
  const body = bytes.length - 2;
  let checksum = 0;
  for (let i = 0; i < body; ++i) {
    checksum ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; ++bit)
      checksum = ((checksum << 1) ^ (checksum & 0x8000 ? 0x1021 : 0)) & 65535;
  }
  if (checksum !== (bytes[body] | (bytes[body + 1] << 8)))
    throw new Error("invalid strkey checksum");
  return kind;
}

export function decodeInboundNote(payload) {
  const bytes = typeof payload === "string" ? fromHex(payload) : payload;
  if (bytes.length < INBOUND_NOTE_MIN) {
    throw new Error(`Inbound note is too short: ${bytes.length} bytes`);
  }
  if (bytes[0] !== NOTE_VERSION) {
    throw new Error(
      `Unsupported note version: ${bytes[0]}, expected ${NOTE_VERSION}`,
    );
  }
  const kind = bytes[1];
  const len = bytes[2];
  if (bytes.length !== 3 + len + 8) {
    throw new Error(
      `Length byte (${len}) does not match note length (${bytes.length})`,
    );
  }
  const strkey = bytesToAscii(bytes.slice(3, 3 + len));
  if (validStellarRecipient(strkey) !== kind)
    throw new Error("note kind disagrees with strkey");
  const nonce = bytesToBigInt(bytes.slice(3 + len, 3 + len + 8));
  return { kind, strkey, nonce };
}

function normalizeHex32(value) {
  if (typeof value !== "string") return "";
  const clean = value.replace(/^0x/i, "");
  return /^[0-9a-fA-F]{64}$/.test(clean) && !/^0{64}$/.test(clean)
    ? clean.toLowerCase()
    : "";
}
function paymentIdentity(value, direction) {
  if (direction === "outbound") return normalizeHex32(value);
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    /^[!-~]+$/.test(value)
    ? value
    : "";
}

export function parseIntegerAmount(value) {
  const maximum = (1n << 256n) - 1n;
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    return null;
  if (
    typeof value !== "bigint" &&
    typeof value !== "number" &&
    typeof value !== "string"
  )
    return null;
  if (typeof value === "string" && (!/^\d+$/.test(value) || value.length > 78))
    return null;
  try {
    const amount = BigInt(value);
    return amount >= 0n && amount <= maximum ? amount : null;
  } catch {
    return null;
  }
}

/**
 * Reconcile Axelar source note intent against candidate ITS payment evidence.
 *
 * @param {object} source Source note intent
 * @param {object|null} candidate Candidate ITS payment event
 * @returns {object} Reconciliation report
 */
export function reconcileAxelarPayment(source, candidate) {
  const discrepancies = [];
  const agreements = [];
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    discrepancies.push("malformed source intent");
    source = { tokenId: "", amount: "" };
  }
  if (
    candidate !== null &&
    candidate !== undefined &&
    (typeof candidate !== "object" || Array.isArray(candidate))
  ) {
    discrepancies.push("malformed candidate payment");
    candidate = null;
  }
  if (source.direction !== "outbound" && source.direction !== "inbound")
    discrepancies.push("missing or unsupported explicit direction");
  const direction = source.direction === "inbound" ? "inbound" : "outbound";
  let expectedRecipient = "";
  let displayNonce;
  try {
    if (typeof source.note !== "string" && !(source.note instanceof Uint8Array))
      throw new Error("missing encoded source note");
    if (
      typeof source.note === "string" &&
      !/^(?:0x)?(?:[0-9a-fA-F]{2})+$/i.test(source.note)
    )
      throw new Error("invalid complete hex source note");
    const decoded =
      direction === "inbound"
        ? decodeInboundNote(source.note)
        : decodeOutboundNote(source.note);
    expectedRecipient =
      "strkey" in decoded ? decoded.strkey : decoded.recipient.toLowerCase();
    displayNonce = decoded.nonce.toString();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    discrepancies.push(`malformed note payload: ${message}`);
  }
  if (!expectedRecipient)
    discrepancies.push("missing expected recipient in encoded source note");

  if (
    source.recipient !== undefined &&
    expectedRecipient &&
    (direction === "outbound"
      ? String(source.recipient).toLowerCase()
      : source.recipient) !== expectedRecipient
  )
    discrepancies.push("source recipient label disagrees with encoded note");
  if (candidate?.recipient !== undefined) {
    try {
      if (direction === "outbound") {
        if (
          typeof candidate.recipient !== "string" ||
          !/^0x[0-9a-fA-F]{40}$/.test(candidate.recipient) ||
          /^0x0{40}$/.test(candidate.recipient)
        )
          throw new Error("invalid EVM recipient");
      } else {
        validStellarRecipient(candidate.recipient);
      }
    } catch {
      discrepancies.push("malformed candidate recipient");
    }
  }
  for (const references of [source.rawReferences, candidate?.rawReferences]) {
    if (
      references !== undefined &&
      (references === null ||
        typeof references !== "object" ||
        Array.isArray(references))
    )
      discrepancies.push("malformed raw references");
  }
  const expectedToken = normalizeHex32(source.tokenId);
  if (!expectedToken)
    discrepancies.push("missing or malformed complete source token ID");
  const expectedAmount = parseIntegerAmount(source.amount);
  const expectedCommandId = paymentIdentity(
    source.commandId ?? source.messageId,
    direction,
  );
  if (!expectedCommandId)
    discrepancies.push("missing or malformed complete source command ID");
  for (const identity of [source, candidate]) {
    if (
      identity?.commandId !== undefined &&
      identity.messageId !== undefined &&
      paymentIdentity(identity.commandId, direction) !==
        paymentIdentity(identity.messageId, direction)
    )
      discrepancies.push("conflicting command/message identity aliases");
  }

  if (expectedAmount === null || expectedAmount <= 0n) {
    discrepancies.push(
      `invalid or non-positive source amount: ${String(source.amount)}`,
    );
  }

  let candidateRecipient;
  let candidateToken;
  let candidateAmount = null;
  let candidateCommandId;

  if (!candidate) {
    discrepancies.push("missing candidate payment");
  } else {
    // 1. Recipient check
    if (typeof candidate.recipient !== "string" || !candidate.recipient) {
      discrepancies.push("missing recipient on candidate payment");
    } else {
      candidateRecipient =
        direction === "outbound"
          ? candidate.recipient.toLowerCase()
          : candidate.recipient;
      if (expectedRecipient && candidateRecipient !== expectedRecipient) {
        discrepancies.push(
          `recipient mismatch: expected ${expectedRecipient} but candidate received ${candidateRecipient}`,
        );
      } else if (expectedRecipient) {
        agreements.push("recipient");
      }
    }

    // 2. Token ID check
    if (!candidate.tokenId) {
      discrepancies.push("missing token ID on candidate payment");
    } else {
      candidateToken = normalizeHex32(candidate.tokenId);
      if (expectedToken && candidateToken !== expectedToken) {
        discrepancies.push(
          `token ID mismatch: expected ${expectedToken} but candidate received ${candidateToken}`,
        );
      } else if (expectedToken) {
        agreements.push("tokenId");
      }
    }

    // 3. Exact integer amount check
    candidateAmount = parseIntegerAmount(candidate.amount);
    if (candidateAmount === null) {
      discrepancies.push(
        `missing or invalid candidate amount: ${String(candidate.amount)}`,
      );
    } else if (expectedAmount !== null) {
      if (candidateAmount < expectedAmount) {
        discrepancies.push(
          `partial receipt detected: expected amount ${expectedAmount.toString()} but candidate received ${candidateAmount.toString()}`,
        );
      } else if (candidateAmount > expectedAmount) {
        discrepancies.push(
          `amount mismatch: expected ${expectedAmount.toString()} but candidate received ${candidateAmount.toString()}`,
        );
      } else {
        agreements.push("amount");
      }
    }

    // 4. Full command identity check
    if (
      !paymentIdentity(candidate.commandId ?? candidate.messageId, direction)
    ) {
      discrepancies.push(
        "missing candidate command ID (command identity must be non-empty and retained)",
      );
    } else {
      candidateCommandId = paymentIdentity(
        candidate.commandId ?? candidate.messageId,
        direction,
      );
      if (expectedCommandId && candidateCommandId !== expectedCommandId) {
        discrepancies.push(
          `command ID mismatch: expected ${expectedCommandId} but candidate received ${candidateCommandId}`,
        );
      } else {
        agreements.push("commandId");
      }
    }
  }

  const sourceRawReferences =
    source.rawReferences !== null &&
    typeof source.rawReferences === "object" &&
    !Array.isArray(source.rawReferences)
      ? { ...source.rawReferences }
      : {};
  const candidateRawReferences =
    candidate?.rawReferences !== null &&
    typeof candidate?.rawReferences === "object" &&
    !Array.isArray(candidate.rawReferences)
      ? { ...candidate.rawReferences }
      : {};
  // Legacy flattened references remain available. The separated records preserve collisions.
  const rawReferences = { ...sourceRawReferences, ...candidateRawReferences };
  if (source.commandId && !rawReferences.sourceCommandId) {
    rawReferences.sourceCommandId = source.commandId;
  }
  if (candidate?.commandId && !rawReferences.candidateCommandId) {
    rawReferences.candidateCommandId = candidate.commandId;
  }
  if (source.tokenId && !rawReferences.tokenId) {
    rawReferences.tokenId = source.tokenId;
  }
  if (
    (typeof source.note === "string" || source.note instanceof Uint8Array) &&
    !rawReferences.rawNote
  ) {
    rawReferences.rawNote =
      typeof source.note === "string" ? source.note : toHex(source.note);
  }

  const verified =
    discrepancies.length === 0 &&
    ["recipient", "tokenId", "amount", "commandId"].every((key) =>
      agreements.includes(key),
    );
  return {
    verified,
    evidenceOnly: true,
    executionProofVerified: false,
    sourceRawReferences,
    candidateRawReferences,
    status: verified ? "verified" : "unverified",
    direction,
    discrepancies,
    agreements,
    rawReferences,
    details: {
      expectedRecipient,
      candidateRecipient,
      expectedTokenId: expectedToken,
      candidateTokenId: candidateToken,
      expectedAmount:
        expectedAmount !== null
          ? expectedAmount.toString()
          : String(source.amount),
      candidateAmount:
        candidateAmount !== null ? candidateAmount.toString() : undefined,
      expectedCommandId,
      candidateCommandId,
      displayNonce,
    },
  };
}

/**
 * Reconcile evidence payload containing source and candidate objects.
 *
 * @param {object} evidence Object with { sourceIntent, candidatePayment } or { source, candidate }
 * @returns {object} Reconciliation report
 */
export function reconcileAxelarEvidence(evidence) {
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence)
  )
    return reconcileAxelarPayment(null, null);
  const source = evidence.sourceIntent ?? evidence.source;
  const candidate = evidence.candidatePayment ?? evidence.candidate;
  if (!source) {
    return {
      verified: false,
      evidenceOnly: true,
      executionProofVerified: false,
      sourceRawReferences: {},
      candidateRawReferences: {},
      status: "unverified",
      direction: "outbound",
      discrepancies: ["missing source intent in evidence"],
      agreements: [],
      rawReferences: evidence.rawReferences ?? {},
      details: {},
    };
  }
  return reconcileAxelarPayment(source, candidate);
}

function printUsage() {
  console.log(`
Usage:
  node script/stellar/reconcile-axelar.mjs [options]

Options:
  --evidence <path>      Path to JSON file containing source and candidate payment
  --source <path>        Path to source intent JSON file
  --candidate <path>     Path to candidate payment JSON file
  --fixture <dir>        Path to fixture directory containing evidence.json (or source.json and candidate.json)
  --strict               Exit with code 1 if reconciliation is unverified
  --pretty               Output formatted JSON (default: true)
  -h, --help             Show this help message

Input Format (JSON):
  {
    "sourceIntent": {
      "direction": "outbound",
      "note": "0x01...",
      "tokenId": "0x...",
      "amount": "10000000",
      "commandId": "0x...",
      "rawReferences": { "txHash": "...", "block": 12345 }
    },
    "candidatePayment": {
      "recipient": "0x...",
      "tokenId": "0x...",
      "amount": "10000000",
      "commandId": "0x...",
      "rawReferences": { "txHash": "...", "block": 67890 }
    }
  }
`);
}

function parseCliArgs(argv) {
  const args = {
    evidencePath: null,
    sourcePath: null,
    candidatePath: null,
    fixtureDir: null,
    strict: false,
    pretty: true,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg === "--evidence" && i + 1 < argv.length) {
      args.evidencePath = argv[++i];
    } else if (arg === "--source" && i + 1 < argv.length) {
      args.sourcePath = argv[++i];
    } else if (arg === "--candidate" && i + 1 < argv.length) {
      args.candidatePath = argv[++i];
    } else if (arg === "--fixture" && i + 1 < argv.length) {
      args.fixtureDir = argv[++i];
    } else if (arg === "--strict") {
      args.strict = true;
    } else if (arg === "--pretty") {
      args.pretty = true;
    } else if (arg === "--no-pretty") {
      args.pretty = false;
    }
  }
  return args;
}

export function runCli(argv = process.argv) {
  const args = parseCliArgs(argv);

  let evidence = null;

  if (args.fixtureDir) {
    const fixturePath = resolve(args.fixtureDir);
    const evidenceFile = join(fixturePath, "evidence.json");
    try {
      evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
    } catch {
      const srcFile = join(fixturePath, "source.json");
      const candFile = join(fixturePath, "candidate.json");
      const source = JSON.parse(readFileSync(srcFile, "utf8"));
      let candidate = null;
      try {
        candidate = JSON.parse(readFileSync(candFile, "utf8"));
      } catch {
        // candidate file may be omitted or empty
      }
      evidence = { sourceIntent: source, candidatePayment: candidate };
    }
  } else if (args.evidencePath) {
    const content = readFileSync(resolve(args.evidencePath), "utf8");
    evidence = JSON.parse(content);
  } else if (args.sourcePath) {
    const source = JSON.parse(readFileSync(resolve(args.sourcePath), "utf8"));
    let candidate = null;
    if (args.candidatePath) {
      candidate = JSON.parse(readFileSync(resolve(args.candidatePath), "utf8"));
    }
    evidence = { sourceIntent: source, candidatePayment: candidate };
  } else if (!process.stdin.isTTY) {
    // Read from stdin
    const input = readFileSync(0, "utf8");
    evidence = JSON.parse(input);
  } else {
    printUsage();
    process.exit(1);
  }

  const report = reconcileAxelarEvidence(evidence);
  const jsonOutput = args.pretty
    ? JSON.stringify(report, null, 2)
    : JSON.stringify(report);
  console.log(jsonOutput);

  if (args.strict && !report.verified) {
    process.exit(1);
  }
  return report;
}

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runCli(process.argv);
}
