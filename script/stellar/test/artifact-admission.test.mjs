import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { artifactAdmission, WASM_LIMIT_BYTES } from "../artifact-admission.mjs";

test("reports headroom and prior size deltas and refuses oversize artifacts", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hyperion-admission-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "router.wasm");
  writeFileSync(file, Buffer.from("0061736d01000000", "hex"));
  const prior = { artifacts: { "router.wasm": { bytes: 12 } } };
  const result = artifactAdmission([file], prior);
  assert.deepEqual(result.artifacts["router.wasm"], {
    bytes: 8,
    limitBytes: WASM_LIMIT_BYTES,
    headroomBytes: WASM_LIMIT_BYTES - 8,
    previousBytes: 12,
    deltaBytes: -4,
  });
  assert.equal(result.resourceDiagnostics, null);
  assert.throws(() => artifactAdmission([file, file]), /duplicate artifact/);

  const record = JSON.parse(
    readFileSync(
      new URL("../fixtures/storage-cost-rpc-v2.json", import.meta.url),
      "utf8",
    ),
  );
  record.scenarios = record.scenarios.slice(0, 1);
  assert.throws(
    () => artifactAdmission([file], null, record, "other network"),
    /does not match the selected Stellar network/,
  );
  const diagnostics = artifactAdmission(
    [file],
    null,
    record,
    record.network.passphrase,
  ).resourceDiagnostics;
  assert.equal(
    diagnostics.network.protocolVersion,
    record.network.protocolVersion,
  );
  assert.equal(
    diagnostics.scenarios[0].simulationLedger,
    record.scenarios[0].simulation.latestLedger,
  );
  assert.equal(diagnostics.scenarios[0].complete, true);

  writeFileSync(file, Buffer.alloc(WASM_LIMIT_BYTES + 1));
  assert.throws(() => artifactAdmission([file]), /65536 bytes/);
});
