#!/usr/bin/env node
/**
 * Print the canonical hostile-message corpus in a machine-readable form.
 *
 * The Rust, Solidity and TypeScript suites consume the same rows. Keeping the
 * bytes and expected classification in one small file makes a mismatch point
 * to an implementation and an exact case instead of only saying "parity failed".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(
  new URL("../testdata/malformed-message-corpus.tsv", import.meta.url),
);
const rows = readFileSync(path, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.length > 0 && !line.startsWith("#"))
  .map((line) => {
    const columns = line.split("|");
    const [id, direction, payload, expected] = columns;
    if (
      columns.length !== 4 ||
      !/^[a-z0-9_-]+$/.test(id) ||
      direction !== "outbound" ||
      !["ok", "MalformedMessage", "UnsupportedHookVersion"].includes(
        expected,
      ) ||
      !/^0x(?:[0-9a-f]{2})+$/.test(payload)
    ) {
      throw new Error(`malformed corpus row: ${line}`);
    }
    return { id, direction, payload, expected };
  });

if (new Set(rows.map((row) => row.id)).size !== rows.length) {
  throw new Error("malformed corpus contains duplicate case IDs");
}

process.stdout.write(`${JSON.stringify({ version: 1, cases: rows })}\n`);
