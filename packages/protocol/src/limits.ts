/**
 * Input-size budgets for the public byte and message parsers.
 *
 * Every codec in this package reads bytes somebody else produced: a CCTP attestation, a note on a
 * rail, an XDR event from a public RPC, a wire schema set from another build. A parser that
 * allocates in proportion to whatever it was handed turns a 200 MB response from a hostile or
 * broken endpoint into a 100 MB heap allocation before it has read a single field. Browsers are
 * where that hurts most, because the tab dies rather than the request failing.
 *
 * So each public parser takes the same optional budget and checks it before it allocates. The
 * defaults are far above every message the routers actually emit (the largest registered wire
 * layout is a few hundred bytes), so ordinary input is unaffected. A provider that attaches larger
 * hook data raises `maxBytes` at the call site: that is a local parsing decision, not a wire-format
 * or deployment change, and it does not activate a rail.
 *
 * These budgets sit next to the format checks rather than replacing them. A note is still exactly
 * twenty nine bytes, a hook is still thirty four or forty two, and a schema still refuses a field
 * that runs past its message. The budget only decides how much input is worth looking at.
 */
import { fromHex } from "./bytes.js";
import type { Hex } from "./bytes.js";

/** The default cap for a public byte parser, in decoded bytes. */
export const DEFAULT_MAX_MESSAGE_BYTES = 65_535;

/** Largest quote-snapshot document, in characters, before JSON parsing. */
export const MAX_SNAPSHOT_CHARACTERS = 1_048_576;

/** Largest number of schemas in an externally supplied wire schema set. */
export const MAX_WIRE_SCHEMAS = 256;

/** Largest number of fields in one externally supplied message schema. */
export const MAX_WIRE_FIELDS = 512;

/** Largest number of entries in one externally supplied error table. */
export const MAX_WIRE_ERROR_ENTRIES = 1_024;

/** Largest number of token entries read from one deployment record. */
export const MAX_DEPLOYMENT_TOKENS = 512;

/** Largest number of wasm hash entries read from one deployment record. */
export const MAX_DEPLOYMENT_WASM_HASHES = 256;

/** The documented defaults, exported so a provider extension can start from them. */
export const PROTOCOL_INPUT_LIMITS = Object.freeze({
  messageBytes: DEFAULT_MAX_MESSAGE_BYTES,
  snapshotCharacters: MAX_SNAPSHOT_CHARACTERS,
  wireSchemas: MAX_WIRE_SCHEMAS,
  wireFields: MAX_WIRE_FIELDS,
  wireErrorEntries: MAX_WIRE_ERROR_ENTRIES,
  deploymentTokens: MAX_DEPLOYMENT_TOKENS,
  deploymentWasmHashes: MAX_DEPLOYMENT_WASM_HASHES,
});

/** Optional byte budget for a parser. Omitted fields use the documented default. */
export interface ByteParserLimits {
  /** Largest accepted input, in decoded bytes. */
  readonly maxBytes?: number;
}

/** Optional character budget for a text parser. */
export interface CharacterParserLimits {
  /** Largest accepted input, in characters. */
  readonly maxCharacters?: number;
}

/** Optional collection budgets for an externally supplied wire schema set. */
export interface WireSchemaLimits {
  readonly maxSchemas?: number;
  readonly maxFields?: number;
  readonly maxErrorEntries?: number;
}

function configured(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

/** Resolve a parser's byte budget, refusing a nonsensical override rather than guessing. */
export function byteLimit(limits?: ByteParserLimits, fallback = DEFAULT_MAX_MESSAGE_BYTES): number {
  return configured(limits?.maxBytes, fallback, "maxBytes");
}

/** Resolve a text parser's character budget. */
export function characterLimit(
  limits?: CharacterParserLimits,
  fallback = MAX_SNAPSHOT_CHARACTERS,
): number {
  return configured(limits?.maxCharacters, fallback, "maxCharacters");
}

/**
 * The decoded length of a hex string, without allocating the bytes.
 *
 * Odd-length input is left to `fromHex` to refuse in its own words; a fractional byte count only
 * ever compares smaller than the budget, so the order of those two checks does not matter.
 */
export function hexByteLength(value: string): number {
  const prefix = value.startsWith("0x") || value.startsWith("0X") ? 2 : 0;
  return (value.length - prefix) / 2;
}

/**
 * Check a byte or hex input against a budget before turning it into bytes.
 *
 * The hex path is the point: `fromHex` allocates `length / 2` bytes, so a budget checked after
 * conversion has already paid the allocation it was meant to prevent. `over` reports in the error
 * vocabulary of the calling codec.
 */
export function boundedBytes(
  input: Uint8Array | Hex,
  maxBytes: number,
  over: (actual: number, max: number) => never,
): Uint8Array {
  const actual = typeof input === "string" ? hexByteLength(input) : input.length;
  if (actual > maxBytes) over(actual, maxBytes);
  return typeof input === "string" ? fromHex(input) : input;
}
