#!/usr/bin/env node
/** Durable journal for unsigned Stellar deployment operations. */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const JOURNAL_VERSION = 1;

function load(path) {
  if (!existsSync(path)) return { version: JOURNAL_VERSION, operations: [] };
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value?.version !== JOURNAL_VERSION || !Array.isArray(value.operations)) {
    throw new Error("unsupported or malformed operation journal");
  }
  return value;
}

function save(path, journal) {
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function operationKey(phase, intent) {
  return `${phase}:${JSON.stringify(intent)}`;
}

/** Begin an operation or return the existing entry for the same public intent. */
export function beginOperation(path, phase, intent, transactionReference = null) {
  const journal = load(path);
  const key = operationKey(phase, intent);
  const existing = journal.operations.find((operation) => operation.key === key);
  if (existing) return existing;
  const operation = {
    key,
    phase,
    intent,
    transactionReference,
    status: "uncertain",
    startedAt: new Date().toISOString(),
    confirmedAt: null,
  };
  journal.operations.push(operation);
  save(path, journal);
  return operation;
}

/** Mark an operation confirmed without changing its original intent. */
export function confirmOperation(path, phase, intent, transactionReference, outcome = "confirmed") {
  const journal = load(path);
  const operation = journal.operations.find((entry) => entry.key === operationKey(phase, intent));
  if (!operation) throw new Error("cannot confirm an operation that was not journaled");
  operation.transactionReference = transactionReference;
  operation.outcome = outcome;
  operation.status = "confirmed";
  operation.confirmedAt = new Date().toISOString();
  save(path, journal);
  return operation;
}

export function reconcileOperations(path) {
  return load(path).operations.map((operation) => ({ ...operation }));
}

if (process.argv[1]?.endsWith("operation-journal.mjs")) {
  const [command, path, phase, intentJson, transactionReference] = process.argv.slice(2);
  if (!command || !path || !phase || !intentJson) {
    throw new Error("usage: operation-journal.mjs begin|confirm|reconcile PATH PHASE INTENT_JSON [TX_REF]");
  }
  const intent = JSON.parse(intentJson);
  const result = command === "begin"
    ? beginOperation(path, phase, intent, transactionReference ?? null)
    : command === "confirm"
      ? confirmOperation(path, phase, intent, transactionReference ?? null)
      : command === "reconcile"
        ? reconcileOperations(path)
        : (() => { throw new Error(`unknown journal command: ${command}`); })();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
