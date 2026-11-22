#!/usr/bin/env node
/** Compare recorded read-only observations to exactly one locally available Git registry commit. */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  openSync,
  closeSync,
  readFileSync,
  fstatSync,
  constants,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(
  path.join(ROOT, "packages/protocol/package.json"),
);
const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
export async function loadRegistry(revision, root = ROOT) {
  if (typeof revision !== "string" || !/^git:[a-f0-9]{40}$/.test(revision))
    throw new Error("--revision requires git:<full 40-character commit SHA>");
  const git = (args, maxBuffer = 1048576) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
    });
  const commit = git([
    "rev-parse",
    "--verify",
    `${revision.slice(4)}^{commit}`,
  ]).trim();
  if (commit !== revision.slice(4))
    throw new Error("selected registry commit did not resolve exactly");
  const entries = git([
    "ls-tree",
    "-rz",
    "--full-tree",
    commit,
    "--",
    "packages/protocol/src",
  ])
    .split("\0")
    .filter(Boolean);
  if (!entries.length || entries.length > 256)
    throw new Error("selected source tree is missing or exceeds 256 files");
  const directory = mkdtempSync(path.join(tmpdir(), "hyperion-registry-"));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  try {
    const ts = require("typescript");
    const digest = createHash("sha256");
    writeFileSync(path.join(directory, "package.json"), '{"type":"module"}\n');
    for (const entry of entries) {
      const match =
        /^100644 blob ([a-f0-9]{40})\t(packages\/protocol\/src\/[A-Za-z0-9_./-]+\.ts)$/.exec(
          entry,
        );
      if (!match || match[2].split("/").includes(".."))
        throw new Error(
          "selected registry source contains unsupported file modes or paths",
        );
      const filename = match[2];
      const source = git(["show", `${commit}:${filename}`], 524288);
      digest.update(filename).update("\0").update(source).update("\0");
      const output = path.join(
        directory,
        filename.slice("packages/protocol/src/".length).replace(/\.ts$/, ".js"),
      );
      mkdirSync(path.dirname(output), { recursive: true });
      const transpiled = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        reportDiagnostics: true,
      });
      if (
        transpiled.diagnostics?.some(
          (d) => d.category === ts.DiagnosticCategory.Error,
        )
      )
        throw new Error(`selected source cannot compile: ${filename}`);
      writeFileSync(output, transpiled.outputText);
    }
    const registry = await import(
      pathToFileURL(path.join(directory, "registry/index.js")).href
    );
    for (const name of [
      "chainByKey",
      "assetsOn",
      "railContracts",
      "assetIdentity",
      "assetIdentityKey",
    ])
      if (typeof registry[name] !== "function")
        throw new Error(`selected registry does not expose ${name}`);
    return { registry, commit, sourceSha256: digest.digest("hex"), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
function same(left, right) {
  if (typeof left !== typeof right) return false;
  if (
    typeof left === "string" &&
    /^0x[a-f0-9]{40}$/i.test(left) &&
    /^0x[a-f0-9]{40}$/i.test(right)
  )
    return left.toLowerCase() === right.toLowerCase();
  return left === right;
}
export function compareRegistry(live, network, selected) {
  if (!plain(live) || live.network !== network)
    throw new Error("snapshot must name the selected network");
  const { registry, commit, sourceSha256 } = selected;
  const chain = registry.chainByKey(network);
  if (!chain) throw new Error(`unknown selected registry chain ${network}`);
  const results = [];
  const compare = (field, observed, expected, provenance) => {
    if (expected === null || expected === undefined) return;
    const unavailable =
      observed === undefined ||
      observed === null ||
      (plain(observed) && observed.status === "unavailable");
    results.push({
      field,
      state: unavailable
        ? "unknown"
        : same(observed, expected)
          ? provenance.confirmed
            ? "verified"
            : "inferred"
          : "drift",
      live: unavailable ? null : observed,
      expected,
      provenance,
    });
  };
  const chainSource = {
    confirmed: true,
    source: "selected protocol chain registry",
  };
  compare(
    "network.passphrase",
    live.networkPassphrase,
    chain.networkPassphrase,
    chainSource,
  );
  compare("network.axelarName", live.axelarName, chain.axelarName, chainSource);
  compare("network.cctpDomain", live.cctpDomain, chain.cctpDomain, chainSource);
  if (live.tokens !== undefined && !Array.isArray(live.tokens))
    throw new Error(
      "snapshot tokens must be an array with explicit asset identity fields",
    );
  const seen = new Set();
  for (const asset of registry.assetsOn(network)) {
    const identity = registry.assetIdentity(asset);
    const identityKey = registry.assetIdentityKey(identity);
    if (seen.has(identityKey))
      throw new Error("selected registry contains duplicate asset identities");
    seen.add(identityKey);
    const matches = (live.tokens ?? []).filter(
      (entry) =>
        plain(entry) &&
        Object.keys(identity).every((field) =>
          same(entry[field], identity[field]),
        ),
    );
    if (matches.length > 1)
      throw new Error(`snapshot has ambiguous token identity ${identityKey}`);
    const actual = matches[0];
    const provenance = { confirmed: asset.confirmed, source: asset.source };
    const prefix = `token.${identityKey}`;
    compare(`${prefix}.decimals`, actual?.decimals, asset.decimals, provenance);
    compare(`${prefix}.symbol`, actual?.symbol, asset.symbol, provenance);
    if (asset.family === "stellar") {
      compare(`${prefix}.code`, actual?.code, asset.code, provenance);
      compare(`${prefix}.issuer`, actual?.issuer, asset.issuer, provenance);
      compare(`${prefix}.sacId`, actual?.sacId, asset.sacId, provenance);
    } else
      compare(`${prefix}.address`, actual?.address, asset.address, provenance);
  }
  const rails = registry.railContracts(network);
  if (rails) {
    const provenance = { confirmed: rails.confirmed, source: rails.source };
    for (const [family, values] of [
      ["axelar-its", rails.axelar],
      ["cctp", rails.cctp],
    ]) {
      if (!values) continue;
      for (const [field, expected] of Object.entries(values))
        compare(
          `provider.${family}.${field}`,
          live.providers?.[family]?.[field],
          expected,
          provenance,
        );
    }
  }
  const states = ["verified", "inferred", "unknown", "drift"];
  return {
    registryRevision: `git:${commit}`,
    registrySourceSha256: sourceSha256,
    evidenceOrigin: "recorded-read-only-observations",
    network,
    results,
    counts: Object.fromEntries(
      states.map((state) => [
        state,
        results.filter((r) => r.state === state).length,
      ]),
    ),
    healthy: results.length > 0 && results.every((r) => r.state === "verified"),
  };
}
function readSnapshot(filename) {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1048576)
      throw new Error("snapshot must be a regular file below 1MiB");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let selected;
  try {
    const args = process.argv.slice(2);
    if (
      args.length !== 6 ||
      args[0] !== "--live" ||
      args[2] !== "--network" ||
      args[4] !== "--revision"
    )
      throw new Error(
        "usage: verify-registry.mjs --live SNAPSHOT.json --network CHAIN --revision git:COMMIT",
      );
    selected = await loadRegistry(args[5]);
    const report = compareRegistry(readSnapshot(args[1]), args[3], selected);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.healthy) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`verify-registry: ${error.message}\n`);
    process.exitCode = 2;
  } finally {
    selected?.cleanup();
  }
}
