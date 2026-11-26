import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { readBoundedText } from "./record-evidence.mjs";
import { projectStorageCosts } from "./storage-cost.mjs";

// The same Soroban WASM size ceiling applies to every artifact in one upload.
export const WASM_LIMIT_BYTES = 64 * 1024;

export function describeArtifact(size, previousBytes = null) {
  return {
    bytes: size,
    limitBytes: WASM_LIMIT_BYTES,
    headroomBytes: WASM_LIMIT_BYTES - size,
    previousBytes,
    deltaBytes: previousBytes === null ? null : size - previousBytes,
  };
}

export function artifactAdmission(
  files,
  previous = null,
  resourceRecord = null,
  expectedPassphrase = null,
) {
  const artifacts = Object.create(null);
  for (const file of files) {
    const name = basename(file);
    if (Object.hasOwn(artifacts, name))
      throw new Error(`${name}: duplicate artifact name`);
    const descriptor = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let size;
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size < 8 || stat.size > WASM_LIMIT_BYTES)
        throw new Error(
          `${name}: expected a WASM file between 8 and ${WASM_LIMIT_BYTES} bytes`,
        );
      const bytes = Buffer.alloc(WASM_LIMIT_BYTES + 1);
      size = 0;
      while (size < bytes.length) {
        const count = readSync(
          descriptor,
          bytes,
          size,
          bytes.length - size,
          null,
        );
        if (count === 0) break;
        size += count;
      }
      if (size !== stat.size || !WebAssembly.validate(bytes.subarray(0, size)))
        throw new Error(`${name}: invalid or changed WASM`);
    } finally {
      closeSync(descriptor);
    }
    const prior = previous?.artifacts?.[name]?.bytes ?? null;
    if (
      prior !== null &&
      (!Number.isSafeInteger(prior) || prior < 8 || prior > WASM_LIMIT_BYTES)
    ) {
      throw new Error(`${name}: invalid previous artifact size`);
    }
    artifacts[name] = describeArtifact(size, prior);
  }
  if (!Object.keys(artifacts).length)
    throw new Error("No WASM artifacts supplied");
  if (
    resourceRecord &&
    expectedPassphrase !== null &&
    resourceRecord.network?.passphrase !== expectedPassphrase
  )
    throw new Error(
      "Resource record does not match the selected Stellar network",
    );
  const projection = resourceRecord
    ? projectStorageCosts(resourceRecord)
    : null;
  return {
    artifacts,
    resourceDiagnostics: projection
      ? {
          network: {
            passphrase: projection.network.passphrase,
            protocolVersion: projection.network.protocolVersion,
          },
          scenarios: projection.scenarios.map(
            ({ name, simulationLedger, resources, fees, complete }) => ({
              name,
              simulationLedger,
              resources,
              fees,
              complete,
            }),
          ),
        }
      : null,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const previous = process.env.HYPERION_PREVIOUS_ARTIFACT_REPORT;
  const resourceRecord = process.env.HYPERION_RESOURCE_RECORD;
  try {
    const report = artifactAdmission(
      process.argv.slice(2),
      previous ? JSON.parse(readBoundedText(previous)) : null,
      resourceRecord ? JSON.parse(readBoundedText(resourceRecord)) : null,
      process.env.HYPERION_ADMISSION_PASSPHRASE ?? null,
    );
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
