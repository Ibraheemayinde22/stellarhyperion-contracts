#!/usr/bin/env node
/** Public receipts for deployment commands. Uncertain attempts are never submitted again. */
import {
  constants,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  fsyncSync,
  fstatSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const JOURNAL_VERSION = 2;
const MAX_BYTES = 1048576;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const plain = (value) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
function canonical(value, depth = 0) {
  if (depth > 16) throw new Error("intent is too deeply nested");
  if (Array.isArray(value))
    return value.map((entry) => canonical(entry, depth + 1));
  if (plain(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => {
          if (
            /secret|private|password|mnemonic|credential|signature|envelope|token/i.test(
              key,
            ) &&
            key !== "wasmHash"
          )
            throw new Error("journal accepts public intent fields only");
          return [key, canonical(value[key], depth + 1)];
        }),
    );
  if (typeof value === "string") {
    if (
      value.length > 16384 ||
      /S[A-Z2-7]{55}|-----BEGIN|gh[pousr]_/.test(value)
    )
      throw new Error("invalid public intent text");
    return value;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  )
    return value;
  throw new Error("unsupported intent value");
}
export function operationKey(phase, intent) {
  if (
    typeof phase !== "string" ||
    !/^[a-z0-9-]{1,64}$/.test(phase) ||
    !plain(intent) ||
    !Object.keys(intent).length
  )
    throw new Error("invalid operation intent");
  const encoded = JSON.stringify(canonical(intent));
  if (Buffer.byteLength(encoded) > 32768)
    throw new Error("intent exceeds 32KiB");
  return `${phase}:${hash(encoded)}`;
}
function load(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT")
      return { version: JOURNAL_VERSION, operations: [] };
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_BYTES)
      throw new Error("journal must be a bounded regular file");
    const value = JSON.parse(readFileSync(descriptor, "utf8"));
    if (value?.version !== JOURNAL_VERSION || !Array.isArray(value.operations))
      throw new Error(
        "unsupported or malformed journal; preserve and reconcile older records first",
      );
    const keys = new Set();
    for (const entry of value.operations) {
      if (
        !plain(entry) ||
        entry.key !== operationKey(entry.phase, entry.intent) ||
        keys.has(entry.key) ||
        !["uncertain", "confirmed"].includes(entry.status)
      )
        throw new Error("malformed journal operation");
      if (entry.status === "confirmed") validateReceipt(entry.receipt);
      keys.add(entry.key);
    }
    return value;
  } finally {
    closeSync(descriptor);
  }
}
function save(path, journal) {
  const data = `${JSON.stringify(journal, null, 2)}\n`;
  if (Buffer.byteLength(data) > MAX_BYTES)
    throw new Error(
      "journal exceeds 1MiB; archive confirmed records before continuing",
    );
  const temporary = `${path}.tmp-${randomUUID()}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
function locked(path, action) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  let descriptor;
  try {
    descriptor = openSync(`${target}.lock`, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "journal is locked; after a crash, inspect uncertain operations before removing its lock",
      );
    throw error;
  }
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    fsyncSync(descriptor);
    return action(target);
  } finally {
    closeSync(descriptor);
    unlinkSync(`${target}.lock`);
  }
}
function begin(journal, phase, intent) {
  const key = operationKey(phase, intent);
  const existing = journal.operations.find((entry) => entry.key === key);
  if (existing) return { operation: existing, created: false };
  const operation = {
    key,
    phase,
    intent: canonical(intent),
    status: "uncertain",
    startedAt: new Date().toISOString(),
    confirmedAt: null,
    receipt: null,
  };
  journal.operations.push(operation);
  return { operation, created: true };
}
function validateReceipt(receipt) {
  if (
    !plain(receipt) ||
    !["transaction", "cli-success"].includes(receipt.kind) ||
    typeof receipt.reference !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.reference)
  )
    throw new Error("confirmation needs a positive public receipt");
  if (typeof receipt.result !== "string" || receipt.result.length > 32768)
    throw new Error("receipt result must be bounded public output");
  canonical(receipt.result);
  if (
    receipt.kind === "cli-success" &&
    hash(receipt.result) !== receipt.reference
  )
    throw new Error("CLI receipt digest does not match result");
}
function confirm(operation, receipt) {
  validateReceipt(receipt);
  if (operation.status === "confirmed") {
    if (JSON.stringify(operation.receipt) !== JSON.stringify(receipt))
      throw new Error("cannot overwrite confirmed evidence");
    return operation;
  }
  operation.receipt = receipt;
  operation.status = "confirmed";
  operation.confirmedAt = new Date().toISOString();
  return operation;
}
export function beginOperation(path, phase, intent) {
  return locked(path, (target) => {
    const journal = load(target);
    const { operation, created } = begin(journal, phase, intent);
    if (created) save(target, journal);
    return operation;
  });
}
export function confirmOperation(path, phase, intent, receipt) {
  return locked(path, (target) => {
    const journal = load(target);
    const operation = journal.operations.find(
      (entry) => entry.key === operationKey(phase, intent),
    );
    if (!operation) throw new Error("operation was not journaled");
    confirm(operation, receipt);
    save(target, journal);
    return operation;
  });
}
export function reconcileOperations(path) {
  return load(resolve(path)).operations;
}
export function runOperation(path, phase, intent, execute) {
  return locked(path, (target) => {
    const journal = load(target);
    const { operation, created } = begin(journal, phase, intent);
    if (!created) {
      if (operation.status === "confirmed") return operation.receipt.result;
      throw new Error(
        `uncertain operation ${operation.key}; reconcile its transaction and live state before continuing`,
      );
    }
    save(target, journal); // Durable before the first signing/submission side effect.
    const result = execute();
    if (typeof result !== "string")
      throw new Error("command returned no public result");
    confirm(operation, {
      kind: "cli-success",
      reference: hash(result),
      result,
    });
    save(target, journal);
    return result;
  });
}
/** The command's identity alias and local WASM pathname do not define its public intent. */
export function stellarIntent(network, source, args, networkPassphrase) {
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(network) ||
    !/^G[A-Z2-7]{55}$/.test(source) ||
    typeof networkPassphrase !== "string" ||
    !networkPassphrase.length
  )
    throw new Error("network and public source are required");
  if (
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string") ||
    args[0] !== "contract" ||
    !["upload", "deploy", "invoke"].includes(args[1])
  )
    throw new Error("journal only runs contract upload, deploy and invoke");
  const normalized = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source-account") {
      i++;
      continue;
    }
    if (args[i] === "--wasm") {
      normalized.push("--wasm-sha256", hash(readFileSync(args[++i])));
      continue;
    }
    if (/--secret|--seed|--sign-with-key|--rpc-header/.test(args[i]))
      throw new Error(
        "only named CLI identities and public arguments are supported",
      );
    normalized.push(args[i]);
  }
  return canonical({ network, networkPassphrase, source, command: normalized });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [command, path, phase, ...rest] = process.argv.slice(2);
    if (!path)
      throw new Error(
        "usage: operation-journal.mjs reconcile PATH | begin PATH PHASE INTENT_JSON | run|lookup PATH PHASE NETWORK SOURCE -- STELLAR_ARGS",
      );
    if (command === "reconcile") {
      if (phase || rest.length) throw new Error("reconcile takes only PATH");
      process.stdout.write(`${JSON.stringify(reconcileOperations(path))}\n`);
    } else if (command === "begin") {
      if (rest.length !== 1)
        throw new Error("begin requires public INTENT_JSON");
      process.stdout.write(
        `${JSON.stringify(beginOperation(path, phase, JSON.parse(rest[0])))}\n`,
      );
    } else if (command === "confirm") {
      if (rest.length !== 2)
        throw new Error(
          "confirm requires original INTENT_JSON and positive RECEIPT_JSON after read-only reconciliation",
        );
      process.stdout.write(
        `${JSON.stringify(confirmOperation(path, phase, JSON.parse(rest[0]), JSON.parse(rest[1])))}\n`,
      );
    } else if (command === "run" || command === "lookup") {
      const [network, source, separator, ...args] = rest;
      if (separator !== "--")
        throw new Error("expected -- before Stellar arguments");
      const accountIndex = args.indexOf("--source-account");
      const networkIndex = args.indexOf("--network");
      if (
        accountIndex < 0 ||
        networkIndex < 0 ||
        args[networkIndex + 1] !== network ||
        args.filter((v) => v === "--source-account").length !== 1 ||
        args.filter((v) => v === "--network").length !== 1 ||
        args.includes("--network-passphrase")
      )
        throw new Error(
          "command network and named identity must match the journal scope",
        );
      const identity = args[accountIndex + 1];
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(identity ?? ""))
        throw new Error("source account must be a named CLI identity");
      const actualSource = execFileSync(
        "stellar",
        ["keys", "address", identity],
        {
          encoding: "utf8",
          timeout: 10000,
          maxBuffer: 1024,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      if (actualSource !== source)
        throw new Error(
          "named signing identity differs from public journal source",
        );
      const info = JSON.parse(
        execFileSync(
          "stellar",
          ["network", "info", "--network", network, "--output", "json"],
          {
            encoding: "utf8",
            timeout: 20000,
            maxBuffer: MAX_BYTES,
            stdio: ["ignore", "pipe", "ignore"],
          },
        ),
      );
      const networkPassphrase = info.passphrase;
      const known = {
        testnet: "Test SDF Network ; September 2015",
        mainnet: "Public Global Stellar Network ; September 2015",
        futurenet: "Test SDF Future Network ; October 2022",
        local: "Standalone Network ; February 2017",
      };
      const expectedPassphrase =
        process.env.STELLAR_NETWORK_PASSPHRASE ?? known[network];
      if (expectedPassphrase && networkPassphrase !== expectedPassphrase)
        throw new Error(
          "live network passphrase differs from the selected network; no signing attempt was made",
        );
      const intent = stellarIntent(network, source, args, networkPassphrase);
      // Bind CLI signing to the same observed passphrase included in the public intent.
      const separatorIndex = args.indexOf("--");
      const executionArgs = [...args];
      executionArgs.splice(
        separatorIndex < 0 ? args.length : separatorIndex,
        0,
        "--network-passphrase",
        networkPassphrase,
      );
      if (command === "lookup") {
        const entry = reconcileOperations(path).find(
          (operation) => operation.key === operationKey(phase, intent),
        );
        process.stdout.write(`${entry?.status ?? "absent"}\n`);
      } else
        process.stdout.write(
          runOperation(path, phase, intent, () => {
            const result = spawnSync("stellar", executionArgs, {
              encoding: "utf8",
              timeout: 180000,
              maxBuffer: 32768,
            });
            if (result.status !== 0 || result.error)
              throw new Error(
                "Stellar command did not confirm success; operation remains uncertain (inspect the journal and RPC)",
              );
            return result.stdout;
          }),
        );
    } else throw new Error("unsupported journal command");
  } catch (error) {
    process.stderr.write(`operation-journal: ${error.message}\n`);
    process.exitCode = 1;
  }
}
