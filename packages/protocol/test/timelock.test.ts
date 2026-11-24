import { describe, expect, it } from "vitest";
import {
  MAX_CANCELLATION_NOTE_LEN,
  MAX_QUEUED_ACTION_CHAIN_LEN,
  validateCancellationNote,
  validateQueuedActionChain,
} from "../src/timelock.js";

describe("queued-action cancellation note limits", () => {
  it("accepts exactly the shared maximum printable-ASCII length", () => {
    expect(MAX_CANCELLATION_NOTE_LEN).toBe(128);
    expect(() => {
      validateCancellationNote("a".repeat(MAX_CANCELLATION_NOTE_LEN));
    }).not.toThrow();
  });

  it("rejects oversized and non-printable notes", () => {
    expect(() => {
      validateCancellationNote("a".repeat(MAX_CANCELLATION_NOTE_LEN + 1));
    }).toThrow(/InvalidLimit/);
    expect(() => {
      validateCancellationNote("non-ascii é");
    }).toThrow(/InvalidLimit/);
    expect(() => {
      validateCancellationNote("line\nbreak");
    }).toThrow(/InvalidLimit/);
  });
});

describe("queued-action chain limits", () => {
  it("accepts exactly the shared maximum UTF-8 byte length", () => {
    expect(MAX_QUEUED_ACTION_CHAIN_LEN).toBe(64);
    expect(() => {
      validateQueuedActionChain("a".repeat(MAX_QUEUED_ACTION_CHAIN_LEN));
    }).not.toThrow();
    expect(() => {
      validateQueuedActionChain("é".repeat(MAX_QUEUED_ACTION_CHAIN_LEN / 2));
    }).not.toThrow();
  });

  it("rejects a chain identifier whose encoded bytes exceed the maximum", () => {
    expect(() => {
      validateQueuedActionChain("a".repeat(MAX_QUEUED_ACTION_CHAIN_LEN + 1));
    }).toThrow(/InvalidLimit/);
    expect(() => {
      validateQueuedActionChain("é".repeat(33));
    }).toThrow(/InvalidLimit/);
  });
});
