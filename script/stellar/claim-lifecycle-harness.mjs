#!/usr/bin/env node
/** Run the real WASM upgrade/ledger restoration fixture and report public contract snapshots. */
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--old-wasm" || args[2] !== "--new-wasm")
  throw new Error(
    "usage: claim-lifecycle-harness.mjs --old-wasm RELEASED.wasm --new-wasm CANDIDATE.wasm",
  );
const oldPath = realpathSync(args[1]);
const newPath = realpathSync(args[3]);
const sha256 = (file) => {
  const bytes = readFileSync(file);
  if (
    bytes.length < 8 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))
  )
    throw new Error("expected a real WASM artifact");
  return createHash("sha256").update(bytes).digest("hex");
};
const artifacts = { oldSha256: sha256(oldPath), newSha256: sha256(newPath) };
const child = spawn(
  "cargo",
  [
    "test",
    "--locked",
    "-p",
    "hyperion-router",
    "storage_maintenance::actual_wasm_upgrade_preserves_state_and_failure_retains_executable",
    "--",
    "--ignored",
    "--nocapture",
  ],
  {
    cwd: fileURLToPath(new URL("../../soroban", import.meta.url)),
    env: {
      ...process.env,
      HYPERION_UPGRADE_OLD_WASM: oldPath,
      HYPERION_UPGRADE_NEW_WASM: newPath,
    },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
let output = "";
const timer = setTimeout(() => child.kill("SIGTERM"), 1800000);
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
  if (Buffer.byteLength(output) > 16777216) child.kill("SIGTERM");
});
try {
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0)
    throw new Error(
      "real contract lifecycle fixture failed; no success evidence was produced",
    );
  const reports = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("CLAIM_LIFECYCLE_REPORT "));
  if (reports.length !== 1)
    throw new Error("expected exactly one real WASM lifecycle report");
  const report = JSON.parse(reports[0].slice("CLAIM_LIFECYCLE_REPORT ".length));
  if (
    report.fixture !== "actual-wasm-upgrade-and-ledger-restoration" ||
    report.snapshots?.length !== 6 ||
    Object.values(report.invariants ?? {}).length !== 3 ||
    Object.values(report.invariants).some((value) => value !== true)
  )
    throw new Error("incomplete contract lifecycle evidence");
  console.log(
    JSON.stringify(
      { ...report, artifacts, evidenceOrigin: "local-wasm-contract-fixture" },
      null,
      2,
    ),
  );
} finally {
  clearTimeout(timer);
}
