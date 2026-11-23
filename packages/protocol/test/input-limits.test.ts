/**
 * Input-size budgets on the public byte and message parsers.
 *
 * The interesting property is not that a huge input is refused; it is that it is refused before a
 * proportional allocation happens. The oversized fixtures below are deliberately filled with
 * characters that are not valid hex or base64, so a parser that decoded first would fail with a
 * character error instead of the budget error. The tests assert the budget error.
 */
import { describe, expect, it } from "vitest";

import { fromHex, toHex } from "../src/bytes.js";
import type { Hex } from "../src/bytes.js";
import {
  BURN_HOOK_DATA,
  MSG_BODY,
  cctpBody,
  cctpHookData,
  parseCctpBurnMessage,
  parseCctpMessage,
} from "../src/cctp.js";
import { DEPLOYMENT_SCHEMA_VERSION, parseDeploymentSet } from "../src/deployments.js";
import { decodeBase64, decodeScVal } from "../src/events.js";
import {
  DEFAULT_MAX_MESSAGE_BYTES,
  MAX_DEPLOYMENT_TOKENS,
  MAX_SNAPSHOT_CHARACTERS,
} from "../src/limits.js";
import {
  decodeCctpHook,
  decodeInboundNote,
  decodeOutboundNote,
  encodeCctpHook,
  encodeInboundNote,
  encodeOutboundNote,
} from "../src/notes.js";
import { parseQuoteSnapshot } from "../src/quotes.js";
import {
  WIRE_SCHEMAS,
  parseWireSchemaSet,
  readWireMessage,
  serializeWireSchemaSet,
} from "../src/wire-compat.js";
import { G_ADDR, G_KEY } from "./fixtures.js";

const ROUTER_C = "CAGR5KFYMZYI7WWQ6TWYYZ346T7GNZLKER4DOJTAG3SOB46QLR5RAPSN";
const EVM_ADDRESS = `0x${"11".repeat(20)}` as const;

/** Two invalid hex digits more than the default budget allows, so decoding would fail differently. */
const OVERSIZED_HEX: Hex = `0x${"zz".repeat(DEFAULT_MAX_MESSAGE_BYTES + 1)}`;

/** Base64 that decodes to more than the default budget; the characters are valid so only a budget refuses it. */
const OVERSIZED_BASE64 = "A".repeat(4 * (DEFAULT_MAX_MESSAGE_BYTES + 1));

describe("public parser budgets", () => {
  it("refuses oversized CCTP input before decoding it", () => {
    expect(() => parseCctpMessage(OVERSIZED_HEX)).toThrow(/byte input limit/);
    expect(() => cctpBody(OVERSIZED_HEX)).toThrow(/byte input limit/);
    expect(() => parseCctpBurnMessage(OVERSIZED_HEX)).toThrow(/byte input limit/);
    expect(() => cctpHookData(OVERSIZED_HEX)).toThrow(/byte input limit/);
  });

  it("decodes accepted CCTP messages identically with and without an explicit budget", () => {
    const header = new Uint8Array(MSG_BODY);
    header[3] = 1;
    expect(parseCctpMessage(header)).toEqual(
      parseCctpMessage(toHex(header), { maxBytes: MSG_BODY }),
    );
    expect(parseCctpMessage(header).version).toBe(1);
    expect(cctpBody(header)).toEqual(new Uint8Array(0));

    const burn = new Uint8Array(BURN_HOOK_DATA);
    expect(parseCctpBurnMessage(burn)).toEqual(
      parseCctpBurnMessage(toHex(burn), { maxBytes: BURN_HOOK_DATA }),
    );
    expect(cctpHookData(burn)).toEqual(new Uint8Array(0));
  });

  it("lets a caller tighten the CCTP budget at an exact boundary", () => {
    const header = new Uint8Array(MSG_BODY);
    expect(() => parseCctpMessage(header, { maxBytes: MSG_BODY - 1 })).toThrow(/byte input limit/);
    expect(parseCctpMessage(header, { maxBytes: MSG_BODY }).version).toBe(0);
  });

  it("bounds note and CCTP hook payloads without changing valid results", () => {
    const outbound = encodeOutboundNote(EVM_ADDRESS, 9n);
    expect(decodeOutboundNote(outbound)).toEqual({ recipient: EVM_ADDRESS, nonce: 9n });
    expect(decodeOutboundNote(toHex(outbound), { maxBytes: 29 })).toEqual(
      decodeOutboundNote(outbound),
    );
    expect(() => decodeOutboundNote(outbound, { maxBytes: 28 })).toThrow(/byte input limit/);
    expect(() => decodeOutboundNote(OVERSIZED_HEX)).toThrow(/byte input limit/);

    const inbound = encodeInboundNote(G_ADDR, 5n);
    expect(decodeInboundNote(inbound).nonce).toBe(5n);
    expect(decodeInboundNote(toHex(inbound), { maxBytes: inbound.length })).toEqual(
      decodeInboundNote(inbound),
    );

    const hook = encodeCctpHook(G_ADDR);
    expect(decodeCctpHook(hook).key).toBe(G_KEY);
    expect(() => decodeCctpHook(hook, { maxBytes: hook.length - 1 })).toThrow(/byte input limit/);
  });

  it("checks base64's decoded size before allocating it", () => {
    expect(Array.from(decodeBase64("AQI="))).toEqual([1, 2]);
    expect(() => decodeBase64(OVERSIZED_BASE64)).toThrow(/byte input limit/);
    expect(() => decodeBase64("AQI=", "topic[0]", { maxBytes: 1 })).toThrow(/byte input limit/);
    expect(Array.from(decodeBase64("AQI=", "topic[0]", { maxBytes: 2 }))).toEqual([1, 2]);
  });

  it("bounds ScVal input in both its base64 and raw forms", () => {
    expect(decodeScVal(fromHex("0x0000000000000001"))).toEqual({ type: "bool", value: true });
    expect(() => decodeScVal(OVERSIZED_BASE64)).toThrow(/byte input limit/);
    expect(() => decodeScVal(new Uint8Array(DEFAULT_MAX_MESSAGE_BYTES + 1))).toThrow(
      /byte input limit/,
    );
    expect(() => decodeScVal(new Uint8Array(8), "value", { maxBytes: 7 })).toThrow(
      /byte input limit/,
    );
  });

  it("refuses a wire message over budget before reading any field", () => {
    const schema = WIRE_SCHEMAS.schemas.find(
      (candidate) => candidate.kind === "message" && candidate.id === "note.outbound",
    );
    if (schema?.kind !== "message") {
      throw new Error("the registered outbound note layout is missing");
    }
    const note = encodeOutboundNote(EVM_ADDRESS, 1n);
    const accepted = readWireMessage(schema, note);
    expect(accepted).toEqual(readWireMessage(schema, note, { maxBytes: 29 }));
    expect(accepted.ok).toBe(true);

    const oversized = readWireMessage(schema, new Uint8Array(DEFAULT_MAX_MESSAGE_BYTES + 1));
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.field).toBeNull();
      expect(oversized.detail).toMatch(/byte input limit/);
    }
    expect(readWireMessage(schema, note, { maxBytes: 28 }).ok).toBe(false);
  });

  it("keeps the registered schema set identical under the default budgets", () => {
    const document: unknown = JSON.parse(serializeWireSchemaSet(WIRE_SCHEMAS));
    expect(parseWireSchemaSet(document)).toEqual(WIRE_SCHEMAS);
    expect(() => parseWireSchemaSet(document, { maxSchemas: 1 })).toThrow(/schema input limit/);
    expect(() => parseWireSchemaSet(document, { maxFields: 1 })).toThrow(/schema input limit/);
    expect(() => parseWireSchemaSet(document, { maxErrorEntries: 1 })).toThrow(
      /schema input limit/,
    );
  });

  it("refuses an oversized quote snapshot before parsing JSON", () => {
    expect(() => parseQuoteSnapshot(" ".repeat(MAX_SNAPSHOT_CHARACTERS + 1))).toThrow(
      /input limit/,
    );
    expect(() => parseQuoteSnapshot("{}", { maxCharacters: 1 })).toThrow(/input limit/);
    expect(() => parseQuoteSnapshot("{}")).toThrow(/unsupported quote snapshot version/);
  });
});

const token = (): Record<string, unknown> => ({
  sacId: ROUTER_C,
  code: "USDC",
  issuer: G_ADDR,
  decimals: 7,
  flowLimit: "10000000000000",
  routes: ["cctp"],
});

function deploymentSet(tokens: Record<string, unknown>): unknown {
  return {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    generatedAt: "2026-09-30T12:00:00.000Z",
    networks: {
      stellar: {
        family: "stellar",
        networkPassphrase: "Public Global Stellar Network ; September 2015",
        router: ROUTER_C,
        adapters: { cctp: ROUTER_C },
        tokens,
        treasury: G_ADDR,
        admin: G_ADDR,
        guardian: G_ADDR,
        feeBps: 30,
        flowWindow: 720,
        timelockDelay: 34_560,
        wasmHashes: { router: "a".repeat(64) },
        deployedAt: { ledger: 55_000_000, timestamp: "2026-09-30T12:00:00.000Z" },
        commit: "0123456789abcdef0123456789abcdef01234567",
      },
    },
  };
}

describe("deployment record collection budgets", () => {
  it("accepts the documented number of token entries and refuses one more", () => {
    const atLimit: Record<string, unknown> = {};
    for (let i = 0; i < MAX_DEPLOYMENT_TOKENS; i += 1) atLimit[`T${String(i)}`] = token();
    expect(() => parseDeploymentSet(deploymentSet(atLimit))).not.toThrow();

    const overLimit: Record<string, unknown> = {
      ...atLimit,
      [`T${String(MAX_DEPLOYMENT_TOKENS)}`]: token(),
    };
    expect(() => parseDeploymentSet(deploymentSet(overLimit))).toThrow(/record input limit/);
  });
});
