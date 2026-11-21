import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toHex } from "../src/bytes.js";
import type { Hex } from "../src/bytes.js";
import { encodeInboundNote, reconcileAxelarPayment } from "../src/notes.js";
import type {
  AxelarCandidatePayment,
  AxelarReconciliationReport,
  AxelarSourceIntent,
} from "../src/notes.js";
import { BAD_ADDRESSES, C_ADDR, G_ADDR, M_ADDR, ZERO_ACCOUNT } from "./fixtures.js";

const cli = fileURLToPath(new URL("../../../script/stellar/reconcile-axelar.mjs", import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../script/stellar/test/fixtures/reconciliation/verified/evidence.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  sourceIntent: AxelarSourceIntent;
  candidatePayment: AxelarCandidatePayment;
};

function compare(
  source: AxelarSourceIntent,
  candidate: AxelarCandidatePayment | null,
  verified: boolean,
) {
  const report = reconcileAxelarPayment(source, candidate);
  const run = spawnSync(process.execPath, [cli, "--strict", "--no-pretty"], {
    input: JSON.stringify({ sourceIntent: source, candidatePayment: candidate }),
    encoding: "utf8",
  });
  expect(run.error).toBeUndefined();
  expect(run.status, run.stderr).toBe(verified ? 0 : 1);
  const standalone = JSON.parse(run.stdout) as AxelarReconciliationReport;
  expect(report.verified).toBe(verified);
  expect(standalone.verified).toBe(verified);
  expect(report.evidenceOnly).toBe(true);
  expect(report.executionProofVerified).toBe(false);
  expect(standalone.evidenceOnly).toBe(true);
  expect(standalone.executionProofVerified).toBe(false);
  // Decoders use different error wording; acceptance and normalized evidence must agree.
  expect(standalone.agreements).toEqual(report.agreements);
  expect(standalone.details).toEqual(JSON.parse(JSON.stringify(report.details)));
  expect(standalone.sourceRawReferences).toEqual(report.sourceRawReferences);
  expect(standalone.candidateRawReferences).toEqual(report.candidateRawReferences);
  return report;
}

describe("Axelar evidence reconciliation, SDK and standalone CLI", () => {
  it("accepts the complete independently recorded outbound tuple without claiming execution proof", () => {
    const report = compare(fixture.sourceIntent, fixture.candidatePayment, true);
    expect(report.agreements).toEqual(["recipient", "tokenId", "amount", "commandId"]);
  });

  it.each([undefined, "", "0x01", `0x${"0".repeat(64)}`, `0x${"g".repeat(64)}`])(
    "refuses incomplete source command identity %s",
    (commandId) => {
      const source = { ...fixture.sourceIntent };
      if (commandId === undefined) delete (source as { commandId?: string }).commandId;
      else source.commandId = commandId;
      compare(source, fixture.candidatePayment, false);
    },
  );

  it.each(["", "0x01", `0x${"0".repeat(64)}`, `0x${"a".repeat(63)}g`])(
    "refuses malformed source token binding %s",
    (tokenId) => {
      compare(
        { ...fixture.sourceIntent, tokenId },
        { ...fixture.candidatePayment, tokenId },
        false,
      );
    },
  );

  it.each([
    0,
    -1,
    9007199254740992,
    1.5,
    "9007199254740992.0",
    "1e6",
    " 5000000000",
    "0x12",
    (1n << 256n).toString(),
  ])("refuses matching invalid or unsafe amount %s", (amount) => {
    compare({ ...fixture.sourceIntent, amount }, { ...fixture.candidatePayment, amount }, false);
  });

  it("preserves integer precision beyond JavaScript's safe number range", () => {
    const amount = "9007199254740993";
    compare({ ...fixture.sourceIntent, amount }, { ...fixture.candidatePayment, amount }, true);
    compare(
      { ...fixture.sourceIntent, amount },
      { ...fixture.candidatePayment, amount: "9007199254740992" },
      false,
    );
  });

  it.each([undefined, "", "0x", "0x1g1111111111111111111111111111111111111111000000000000002a"])(
    "requires a valid complete encoded source note %s",
    (note) => {
      const source = {
        ...fixture.sourceIntent,
        recipient: fixture.candidatePayment.recipient ?? "",
      };
      if (note === undefined) delete (source as { note?: Hex }).note;
      else source.note = note as Hex;
      compare(source, fixture.candidatePayment, false);
    },
  );

  it("requires explicit direction and rejects a source label that disagrees with the encoded note", () => {
    const source = { ...fixture.sourceIntent };
    delete (source as { direction?: string }).direction;
    compare(source, fixture.candidatePayment, false);
    compare(
      { ...fixture.sourceIntent, recipient: `0x${"2".repeat(40)}` },
      fixture.candidatePayment,
      false,
    );
  });

  it("refuses a different complete command even when the display nonce agrees", () => {
    const report = compare(
      fixture.sourceIntent,
      { ...fixture.candidatePayment, commandId: `0x${"c".repeat(64)}` },
      false,
    );
    expect(report.details.displayNonce).toBe("42");
    expect(report.discrepancies.some((value) => value.includes("command ID mismatch"))).toBe(true);
  });

  it("refuses partial and excessive receipts and missing candidates", () => {
    compare(fixture.sourceIntent, { ...fixture.candidatePayment, amount: "4999999999" }, false);
    compare(fixture.sourceIntent, { ...fixture.candidatePayment, amount: "5000000001" }, false);
    compare(fixture.sourceIntent, null, false);
  });

  it("retains both unmodified raw reference records when keys overlap", () => {
    const source = {
      ...fixture.sourceIntent,
      rawReferences: { txHash: "stellar-original", commandId: "source-raw", nested: { ledger: 7 } },
    };
    const candidate = {
      ...fixture.candidatePayment,
      rawReferences: { txHash: "evm-original", commandId: "candidate-raw", nested: { block: 8 } },
    };
    const before = JSON.stringify({ source, candidate });
    const report = compare(source, candidate, true);
    expect(report.sourceRawReferences).toEqual(source.rawReferences);
    expect(report.candidateRawReferences).toEqual(candidate.rawReferences);
    expect(JSON.stringify({ source, candidate })).toBe(before);
  });

  it.each([G_ADDR, C_ADDR, M_ADDR])(
    "checks inbound Strkey kind and checksum for %s",
    (recipient) => {
      const source: AxelarSourceIntent = {
        ...fixture.sourceIntent,
        direction: "inbound",
        note: toHex(encodeInboundNote(recipient, 99n)),
        commandId: "ethereum-0xfeed-17",
      };
      const candidate = { ...fixture.candidatePayment, recipient, commandId: "ethereum-0xfeed-17" };
      compare(source, candidate, true);
      compare(source, { ...candidate, commandId: "ethereum-0xfeed-18" }, false);
      const bytes = encodeInboundNote(recipient, 99n);
      bytes[1] = ((bytes[1] ?? 0) + 1) % 3;
      compare({ ...source, note: toHex(bytes) }, candidate, false);
    },
  );

  it.each([...BAD_ADDRESSES.map(({ value }) => value), ZERO_ACCOUNT])(
    "refuses malformed inbound recipients %s",
    (recipient) => {
      const source: AxelarSourceIntent = {
        ...fixture.sourceIntent,
        direction: "inbound",
        note: toHex(encodeInboundNote(G_ADDR, 99n)),
      };
      compare(source, { ...fixture.candidatePayment, recipient }, false);
    },
  );

  it("supports opaque inbound message IDs while rejecting conflicting aliases", () => {
    const source = {
      ...fixture.sourceIntent,
      direction: "inbound" as const,
      note: toHex(encodeInboundNote(G_ADDR, 99n)),
      messageId: "stellar-transaction-44",
    };
    delete (source as { commandId?: string }).commandId;
    const candidate = {
      ...fixture.candidatePayment,
      recipient: G_ADDR,
      messageId: source.messageId,
    };
    delete (candidate as { commandId?: string }).commandId;
    compare(source, candidate, true);
    compare({ ...source, commandId: "unrelated-command" }, candidate, false);
  });

  it.each([null, [], 123, { recipient: 123 }, { note: {} }, { rawReferences: "not-a-record" }])(
    "reports malformed runtime inputs as unverified: %j",
    (invalid) => {
      compare(
        {
          ...fixture.sourceIntent,
          ...(invalid !== null && typeof invalid === "object" && !Array.isArray(invalid)
            ? invalid
            : {}),
        } as AxelarSourceIntent,
        invalid as AxelarCandidatePayment | null,
        false,
      );
    },
  );
});
