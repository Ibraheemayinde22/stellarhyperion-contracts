import { describe, expect, it } from "vitest";
import { laneKey, parseLaneKey, type LaneKeyInput } from "../src/lanes.js";

const lane: LaneKeyInput = {
  network: "testnet",
  sourceChain: "stellar-testnet",
  sourceAsset: 'native:USDC:issuer:%:["a", "b"]',
  destinationChain: "base-sepolia",
  destinationAsset: "native:0x1234",
  provider: "cctp",
};

describe("canonical lane identities", () => {
  it("round trips exact field boundaries and distinguishes representations and issuers", () => {
    const key = laneKey(lane);
    expect(parseLaneKey(key)).toEqual(lane);
    expect(laneKey(parseLaneKey(key))).toBe(key);
    for (const change of [
      { sourceAsset: "its:USDC:issuer" },
      { sourceAsset: "native:USDC:other-issuer" },
      { destinationAsset: "its:0x1234" },
      { provider: "axelar-its" as const },
    ])
      expect(laneKey({ ...lane, ...change })).not.toBe(key);
  });

  it("rejects chain, network and provider combinations unavailable for execution", () => {
    for (const invalid of [
      { network: "unknown" },
      { sourceChain: "unknown" },
      { sourceChain: "stellar" },
      { destinationChain: "stellar-testnet" },
      { provider: "unknown" },
      { sourceChain: "local" },
      { sourceAsset: "" },
      { sourceAsset: undefined },
    ])
      expect(() => laneKey({ ...lane, ...invalid } as LaneKeyInput)).toThrow(RangeError);
    expect(() =>
      laneKey({
        ...lane,
        network: "mainnet",
        sourceChain: "arc",
        destinationChain: "ethereum",
        provider: "axelar-its",
      }),
    ).toThrow(/provider is unavailable/);
  });

  it("rejects malformed, oversized and unsupported serialized inputs", () => {
    for (const key of [
      "unknown:v1:x",
      "hyperion-lane:v1:%",
      "hyperion-lane:v1:" + "x".repeat(20_000),
      "hyperion-lane:v1:" + encodeURIComponent(JSON.stringify(["testnet", 1])),
      "hyperion-lane:v1:" + encodeURIComponent(JSON.stringify(["testnet"])),
    ])
      expect(() => parseLaneKey(key)).toThrow(RangeError);
  });
});
