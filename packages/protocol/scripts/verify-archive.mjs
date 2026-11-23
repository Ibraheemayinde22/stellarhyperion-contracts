#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_ARCHIVE_BYTES,
  cleanPackageBuild,
  collectPackageFiles,
  comparePackageFiles,
  parsePackageArchive,
  sha256,
  smokeTestPackage,
} from "./archive.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runBuild() {
  if (process.env.npm_execpath) {
    execFileSync(process.execPath, [process.env.npm_execpath, "--ignore-scripts", "run", "build"], {
      cwd: packageRoot,
      stdio: "inherit",
      timeout: 180000,
    });
  } else {
    execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["--ignore-scripts", "run", "build"],
      {
        cwd: packageRoot,
        stdio: "inherit",
        timeout: 180000,
        shell: process.platform === "win32",
      },
    );
  }
}

function readSuppliedArchive(path) {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ARCHIVE_BYTES) {
      throw new Error("supplied archive must be a non-empty bounded regular file");
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function reportDifferences(differences) {
  for (const { path, expectedSha256, actualSha256 } of differences.changed) {
    process.stderr.write(`changed ${path}: expected ${expectedSha256}, got ${actualSha256}\n`);
  }
  for (const { path, sha256: digest } of differences.missing) {
    process.stderr.write(`missing ${path}: expected ${digest}\n`);
  }
  for (const { path, sha256: digest } of differences.extra) {
    process.stderr.write(`extra ${path}: got ${digest}\n`);
  }
}

function main(args) {
  const [path, ...extra] = args;
  if (!path || extra.length) throw new Error("usage: verify-archive.mjs ARCHIVE_PATH");

  const actual = parsePackageArchive(readSuppliedArchive(resolve(path)));
  cleanPackageBuild(packageRoot);
  runBuild();
  const expected = collectPackageFiles(packageRoot);
  const differences = comparePackageFiles(actual, expected);
  if (differences.changed.length || differences.missing.length || differences.extra.length) {
    reportDifferences(differences);
    throw new Error("archive differs from a clean SDK build");
  }
  smokeTestPackage(expected);
  process.stdout.write(
    `verified ${String(expected.size)} packaged files; archive sha256 ${sha256(readSuppliedArchive(resolve(path)))}\n`,
  );
  process.stdout.write(
    'isolated imports succeeded: "@hyperion/protocol" and "@hyperion/protocol/abi"\n',
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`archive verification failed: ${error.message}\n`);
  process.exitCode = 1;
}
