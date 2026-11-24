import { fail } from "./errors.js";

/** Maximum printable-ASCII byte length of a timelock cancellation note. */
export const MAX_CANCELLATION_NOTE_LEN = 128;

/** Maximum UTF-8 byte length of a chain identifier stored in a queued action. */
export const MAX_QUEUED_ACTION_CHAIN_LEN = 64;

/** Validate the bounded chain identifier in a queued destination-flow-limit action. */
export function validateQueuedActionChain(chain: string): void {
  if (
    chain.length > MAX_QUEUED_ACTION_CHAIN_LEN ||
    new TextEncoder().encode(chain).length > MAX_QUEUED_ACTION_CHAIN_LEN
  ) {
    fail(
      "InvalidLimit",
      `a queued-action chain identifier must be at most ${String(MAX_QUEUED_ACTION_CHAIN_LEN)} bytes`,
    );
  }
}

/** Validate the bounded audit note attached to a queued-action cancellation. */
export function validateCancellationNote(note: string): void {
  if (note.length > MAX_CANCELLATION_NOTE_LEN || !/^[\x20-\x7e]*$/.test(note)) {
    fail(
      "InvalidLimit",
      `a cancellation note must be at most ${String(MAX_CANCELLATION_NOTE_LEN)} printable ASCII bytes`,
    );
  }
}
