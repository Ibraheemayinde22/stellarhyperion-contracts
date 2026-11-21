import { describe, expect, it } from "vitest";
import {
  describeError,
  HyperionProtocolError,
  SOROBAN_ERROR_NAMES,
  EVM_ERROR_NAMES,
} from "../src/errors.js";

describe("stable protocol recovery guidance", () => {
  it("classifies both chain vocabularies and keeps uncertain future errors conservative", () => {
    for (const name of [...SOROBAN_ERROR_NAMES, ...EVM_ERROR_NAMES]) {
      expect(["transient", "user_correctable", "operator_action", "unknown_outcome"]).toContain(
        describeError(name).recovery,
      );
    }
    for (const name of ["SubmissionUncertain", "FutureContractError", ""]) {
      expect(describeError(name)).toMatchObject({ recovery: "unknown_outcome", retryable: false });
    }
  });

  it("exposes the same recovery guidance on the thrown error", () => {
    expect(describeError("Paused").recovery).toBe("transient");
    expect(new HyperionProtocolError("Paused").recovery).toBe("transient");
    expect(describeError("TokenTransferFailed").recovery).toBe("unknown_outcome");
  });
});
