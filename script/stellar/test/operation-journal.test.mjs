import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  beginOperation,
  confirmOperation,
  operationKey,
  reconcileOperations,
  runOperation,
} from "../operation-journal.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "hyperion-journal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "operations.json") };
}
test("semantic field ordering reserves one operation and confirmed public output is replayed", (t) => {
  const { path } = fixture(t);
  const left = {
    source: "public",
    network: "local",
    parameters: { b: 2, a: 1 },
  };
  const right = {
    parameters: { a: 1, b: 2 },
    network: "local",
    source: "public",
  };
  assert.equal(operationKey("phase1", left), operationKey("phase1", right));
  let submissions = 0;
  assert.equal(
    runOperation(path, "phase1", left, () => {
      submissions++;
      return "public contract result";
    }),
    "public contract result",
  );
  assert.equal(
    runOperation(path, "phase1", right, () => {
      submissions++;
      return "duplicate";
    }),
    "public contract result",
  );
  assert.equal(submissions, 1);
  assert.equal(reconcileOperations(path).length, 1);
});
test("a crash after submission leaves uncertainty and prevents a second submission", (t) => {
  const { path } = fixture(t);
  const intent = { network: "local", source: "public", command: ["invoke"] };
  let submissions = 0;
  assert.throws(
    () =>
      runOperation(path, "phase2", intent, () => {
        submissions++;
        throw new Error("crash after broadcast");
      }),
    /crash/,
  );
  assert.equal(reconcileOperations(path)[0].status, "uncertain");
  assert.throws(
    () =>
      runOperation(path, "phase2", intent, () => {
        submissions++;
        return "second";
      }),
    /uncertain operation/,
  );
  assert.equal(submissions, 1);
});
test("confirmation requires evidence and cannot overwrite a confirmed receipt", (t) => {
  const { path } = fixture(t);
  const intent = { network: "local" };
  beginOperation(path, "phase1", intent);
  assert.throws(
    () => confirmOperation(path, "phase1", intent, null),
    /positive public receipt/,
  );
  const result = "public result";
  const receipt = {
    kind: "cli-success",
    reference: createHash("sha256").update(result).digest("hex"),
    result,
  };
  confirmOperation(path, "phase1", intent, receipt);
  assert.throws(
    () =>
      confirmOperation(path, "phase1", intent, {
        kind: "transaction",
        reference: "a".repeat(64),
        result,
      }),
    /overwrite/,
  );
});
test("public-intent validation refuses secret-shaped values and malformed persisted state", (t) => {
  const { path } = fixture(t);
  assert.throws(
    () => beginOperation(path, "phase1", { privateKey: "no" }),
    /public intent/,
  );
  assert.throws(
    () => beginOperation(path, "phase1", { command: ["S" + "A".repeat(55)] }),
    /public intent/,
  );
  writeFileSync(
    path,
    JSON.stringify({
      version: 2,
      operations: [
        { key: "fake", phase: "phase1", intent: { a: 1 }, status: "uncertain" },
      ],
    }),
  );
  assert.throws(() => reconcileOperations(path), /malformed/);
});
test("concurrent processes cannot submit or lose distinct intents while a writer holds the lock", async (t) => {
  const { dir, path } = fixture(t);
  const count = join(dir, "submissions");
  const ready = join(dir, "ready");
  const module = new URL("../operation-journal.mjs", import.meta.url).href;
  const script = `import {runOperation} from ${JSON.stringify(module)}; import {writeFileSync} from 'node:fs'; runOperation(process.argv[1], 'phase1', {network:'local'}, ()=>{writeFileSync(process.argv[2], 'one');writeFileSync(process.argv[3], 'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);return 'done';});`;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", script, path, count, ready],
    { stdio: "ignore" },
  );
  const completion = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      readFileSync(ready);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("writer did not start");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.throws(
    () => beginOperation(path, "phase1", { network: "other" }),
    /locked/,
  );
  assert.equal(await completion, 0);
  beginOperation(path, "phase1", { network: "other" });
  assert.equal(readFileSync(count, "utf8"), "one");
  assert.equal(reconcileOperations(path).length, 2);
});

function cliFixture(t) {
  const base = fixture(t);
  const source = "G" + "A".repeat(55);
  const sends = join(base.dir, "sends.jsonl");
  const passphrase = "Standalone Network ; February 2017";
  writeFileSync(
    join(base.dir, "stellar"),
    String.raw`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'keys') { process.stdout.write(process.env.FAKE_SOURCE); }
else if (args[0] === 'network') { process.stdout.write(JSON.stringify({passphrase: process.env.FAKE_PASSPHRASE})); }
else {
  const journal = JSON.parse(fs.readFileSync(process.env.FAKE_JOURNAL, 'utf8'));
  if (!journal.operations.some(op => op.status === 'uncertain')) process.exit(91);
  const separator = args.indexOf('--');
  const binding = args.indexOf('--network-passphrase');
  if (binding < 0 || (separator >= 0 && binding > separator) || args[binding + 1] !== process.env.FAKE_PASSPHRASE) process.exit(92);
  fs.appendFileSync(process.env.FAKE_SENDS, JSON.stringify(args) + '\n');
  if (process.env.FAKE_CRASH === 'yes') process.exit(1);
  process.stdout.write('public-result\n');
}
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    PATH: base.dir + ":" + process.env.PATH,
    FAKE_SOURCE: source,
    FAKE_PASSPHRASE: passphrase,
    FAKE_JOURNAL: base.path,
    FAKE_SENDS: sends,
  };
  const command = [
    "contract",
    "invoke",
    "--id",
    "C" + "A".repeat(55),
    "--source-account",
    "identity",
    "--network",
    "local",
    "--send",
    "yes",
    "--",
    "execute_action",
    "--id",
    "1",
  ];
  const invoke = (mode = "run", extra = {}, args = command) =>
    spawnSync(
      process.execPath,
      [
        new URL("../operation-journal.mjs", import.meta.url).pathname,
        mode,
        base.path,
        "phase2",
        "local",
        source,
        "--",
        ...args,
      ],
      { env: { ...env, ...extra }, encoding: "utf8" },
    );
  return { ...base, source, sends, env, command, invoke };
}

test("real CLI wiring binds identity and passphrase before signing, and wrapper reruns replay the receipt", (t) => {
  const f = cliFixture(t);
  const lib = new URL("../lib.sh", import.meta.url).pathname;
  const result = spawnSync(
    "bash",
    [
      "-c",
      `source "$1"; export PATH="$2:$PATH"; JOURNAL="$3"; JOURNAL_PHASE=phase2; invoke "$4" execute_action --id 1; invoke "$4" execute_action --id 1; confirmed_invoke "$4" execute_action --id 1`,
      "fixture",
      lib,
      f.dir,
      f.path,
      "C" + "A".repeat(55),
    ],
    {
      env: { ...f.env, STELLAR_NETWORK: "local", STELLAR_IDENTITY: "identity" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "public-result\npublic-result\n");
  assert.equal(readFileSync(f.sends, "utf8").trim().split("\n").length, 1);
  assert.equal(reconcileOperations(f.path)[0].intent.source, f.source);
  assert.equal(f.invoke("lookup").stdout, "confirmed\n");
  const changedAlias = f.command.map((arg) =>
    arg === "identity" ? "renamed-identity" : arg,
  );
  assert.equal(f.invoke("run", {}, changedAlias).stdout, "public-result\n");
  assert.equal(readFileSync(f.sends, "utf8").trim().split("\n").length, 1);
});

test("CLI scope mismatches never sign, and a failed submission cannot launch a retry", (t) => {
  const f = cliFixture(t);
  const wrongIdentity = f.invoke("run", { FAKE_SOURCE: "G" + "B".repeat(55) });
  assert.equal(wrongIdentity.status, 1);
  assert.match(wrongIdentity.stderr, /identity differs/);
  const wrongNetwork = f.invoke("run", { FAKE_PASSPHRASE: "wrong network" });
  assert.equal(wrongNetwork.status, 1);
  assert.match(wrongNetwork.stderr, /passphrase differs/);
  assert.equal(reconcileOperations(f.path).length, 0);
  assert.equal(f.invoke("run", { FAKE_CRASH: "yes" }).status, 1);
  assert.equal(reconcileOperations(f.path)[0].status, "uncertain");
  const retry = f.invoke();
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /uncertain operation/);
  assert.equal(readFileSync(f.sends, "utf8").trim().split("\n").length, 1);
});
