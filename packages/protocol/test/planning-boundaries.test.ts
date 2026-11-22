import { describe, expect, it } from "vitest";
import {
  maximumSend,
  searchBoundedQuotes,
  quoteBatch,
  quoteBatchWithSharedFlow,
  planQuote,
  planQuotes,
  parseQuoteSnapshot,
  serializeQuoteSnapshot,
  MAX_QUOTE_AMOUNT,
  QuoteBlocker,
  type RouterSnapshot,
  type QuoteSnapshot,
} from "../src/quotes.js";
import { applyRouteHealth, parseRouteHealthSnapshot } from "../src/route-health.js";
import { ROUTE_KINDS, RouteKind } from "../src/routes.js";
import { G_ADDR } from "./fixtures.js";

const all = <T>(value: T): Record<RouteKind, T> => ({ 0: value, 1: value, 2: value, 3: value });
const state = (overrides: Partial<RouterSnapshot> = {}): RouterSnapshot => ({
  paused: false,
  feeBps: 30,
  tokenRegistered: true,
  tokenEnabled: true,
  tokenDecimals: 6,
  routeEnabled: all(true),
  adapterSet: all(true),
  chainSupported: all(true),
  flowAvailable: all(1_000_000n),
  ...overrides,
});
const request = { strkey: G_ADDR, destinationDecimals: 7 };

describe("bounded maximum-send search", () => {
  it("matches exhaustive router arithmetic across fee, precision and flow boundaries", () => {
    for (const feeBps of [0, 30, 100])
      for (const decimals of [0, 1, 2])
        for (const flow of [0n, 1n, 9n, 10n, 11n, 40n]) {
          const snapshot = state({ feeBps, tokenDecimals: 2, flowAvailable: all(flow) });
          const input = {
            ...request,
            destinationDecimals: decimals,
            route: RouteKind.Cctp,
            snapshot,
            balance: 230n,
          };
          let expected = 0n;
          for (let amount = 1n; amount <= input.balance; amount++)
            if (planQuote({ ...input, amount }, snapshot).available) expected = amount;
          const actual = maximumSend(input);
          expect(actual.executable, `${String(feeBps)}/${String(decimals)}/${String(flow)}`).toBe(
            expected > 0n,
          );
          expect(actual.requestAmount).toBe(expected);
          if (actual.quote) {
            expect(actual.quote).toEqual(
              planQuote({ ...input, amount: actual.requestAmount }, snapshot),
            );
            expect(actual.quote.netAmount).toBeLessThanOrEqual(flow);
            expect(actual.precisionDust + actual.quote.grossAmount).toBe(actual.requestAmount);
            expect(actual.balanceDust + actual.requestAmount).toBe(input.balance);
          }
        }
  });

  it("does not reject a valid large transfer because one unit rounds to zero", () => {
    const result = maximumSend({
      ...request,
      destinationDecimals: 6,
      snapshot: state({ tokenDecimals: 18, flowAvailable: all(10n ** 18n) }),
      route: RouteKind.Cctp,
      balance: 10n ** 18n,
    });
    expect(result.executable).toBe(true);
    expect(result.quote?.netAmount).toBeGreaterThan(0n);
  });

  it("clips arbitrary integer ranges and destination conversion to real word limits", () => {
    const snapshot = state({ feeBps: 0, tokenDecimals: 0, flowAvailable: all((1n << 256n) - 1n) });
    const result = maximumSend({
      ...request,
      destinationDecimals: 38,
      route: RouteKind.Cctp,
      snapshot,
      balance: 10n ** 1000n,
    });
    expect(result.executable).toBe(true);
    expect(result.requestAmount).toBeLessThanOrEqual(MAX_QUOTE_AMOUNT);
    expect(result.quote?.destinationAmount).toBeLessThan(1n << 256n);
    expect(result.requestAmount).toBe(MAX_QUOTE_AMOUNT);
  });

  it("returns static blockers and explains every excluded route without mutating inputs", () => {
    const snapshot = state({
      flowAvailable: { 0: 4n, 1: 10n },
      routeEnabled: { 0: true, 1: true },
    });
    const before = structuredClone(snapshot);
    const results = searchBoundedQuotes({
      ...request,
      snapshot,
      balance: 100n,
      maxAmount: 40n,
      minDestinationAmount: 60n,
      allowedRoutes: [0, 1, 2],
    });
    expect(results.map((r) => r.reason)).toEqual([
      "DestinationMinimumNotMet",
      QuoteBlocker.None,
      QuoteBlocker.RouteDisabled,
      "RouteNotAllowed",
    ]);
    expect(results[1]?.requestAmount).toBeLessThanOrEqual(40n);
    expect(snapshot).toEqual(before);
    expect(
      maximumSend({ ...request, snapshot: state({ paused: true }), balance: 100n, route: 0 })
        .reason,
    ).toBe(QuoteBlocker.Paused);
  });

  it("rejects malformed bounds, routes and arithmetic state", () => {
    const input = {
      ...request,
      snapshot: state(),
      balance: 10n,
      maxAmount: 10n,
      minDestinationAmount: 0n,
    };
    expect(() => searchBoundedQuotes({ ...input, maxAmount: -1n })).toThrow("maxAmount");
    expect(() => searchBoundedQuotes({ ...input, allowedRoutes: [8 as RouteKind] })).toThrow(
      "allowedRoutes",
    );
    expect(() => searchBoundedQuotes({ ...input, snapshot: state({ feeBps: NaN }) })).toThrow(
      "feeBps",
    );
    expect(() => maximumSend({ ...input, route: 0, destinationDecimals: -1 })).toThrow(
      "destinationDecimals",
    );
  });
});

describe("shared virtual flow", () => {
  it("uses the winning rail's net once and excludes failed items without consuming", () => {
    const snapshot = state({
      feeBps: 0,
      flowAvailable: { 0: 100n, 1: 100n },
      routeEnabled: { 0: true, 1: true },
    });
    const before = structuredClone(snapshot);
    const params = { ...request, snapshot };
    const result = quoteBatchWithSharedFlow([80n, 200n, 80n, 30n], params);
    expect(result.results.map((r) => r.winningRail)).toEqual([0, null, 1, null]);
    expect(result.consumedFlow).toEqual({ 0: 80n, 1: 80n });
    expect(result.remainingFlow).toEqual({ 0: 20n, 1: 20n });
    expect(quoteBatchWithSharedFlow([80n], params).results).toEqual(quoteBatch([80n], params));
    expect(snapshot).toEqual(before);
  });
});

const historical = (): QuoteSnapshot => {
  const router = state({ feeBps: 0, flowAvailable: all((1n << 256n) - 1n) });
  const input = { ...request, amount: 9_007_199_254_740_993n };
  return {
    capturedAt: 9_007_199_254_740_993n,
    amountUnit: "source-token-base-units",
    destinationUnit: "destination-token-base-units",
    router,
    request: input,
    quotes: planQuotes(input, router),
  };
};

describe("historical quote schema", () => {
  it("round trips wide integers without a live-price claim", () => {
    const snapshot = historical();
    const serialized = serializeQuoteSnapshot(snapshot);
    expect(parseQuoteSnapshot(serialized)).toEqual(snapshot);
    expect(JSON.parse(serialized)).toMatchObject({
      source: "router-snapshot",
      schemaVersion: 1,
      capturedAt: "9007199254740993",
    });
  });

  it.each([
    ["schemaVersion", 2],
    ["amountUnit", ""],
    ["capturedAt", "-1"],
    ["request.amount", "01"],
    ["request.amount", 9007199254740992],
    ["request.destinationDecimals", 39],
    ["router.paused", "false"],
    ["router.feeBps", 101],
    ["router.tokenDecimals", -1],
    ["router.routeEnabled.0", "true"],
    ["router.flowAvailable.00", "1"],
    ["router.flowAvailable.0", (1n << 256n).toString()],
    ["quotes.0.available", "true"],
    ["quotes.0.reason", 12],
    ["quotes.0.fee", "1e3"],
    ["quotes.0", null],
  ])("rejects malformed field %s", (path, value) => {
    const raw = JSON.parse(serializeQuoteSnapshot(historical())) as Record<string, unknown>;
    const keys = path.split(".");
    let parent = raw;
    for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    parent[keys.at(-1)!] = value;
    expect(() => parseQuoteSnapshot(JSON.stringify(raw))).toThrow(
      path === "schemaVersion" ? "version" : path,
    );
  });

  it("rejects duplicate routes and validates values when serializing too", () => {
    const input = historical();
    expect(() =>
      serializeQuoteSnapshot({ ...input, quotes: [input.quotes[0]!, input.quotes[0]!] }),
    ).toThrow("duplicated");
    expect(() => serializeQuoteSnapshot({ ...input, capturedAt: -1n })).toThrow("capturedAt");
    expect(() =>
      serializeQuoteSnapshot({
        ...input,
        request: { ...input.request, amount: 9007199254740992 as unknown as bigint },
      }),
    ).toThrow("request.amount");
  });
});

describe("conservative external health", () => {
  const healthy = () => ({
    schemaVersion: 1,
    capturedAt: "100",
    records: ROUTE_KINDS.map((route) => ({
      route,
      status: "healthy",
      measuredAt: "90",
      scope: "testnet:usdc",
      provider: "fixture",
    })),
  });

  it("never enables unsupported routes and treats absent or unknown health as blocked", () => {
    const input = healthy();
    input.records.pop();
    input.records[1]!.status = "unknown";
    const snapshot = state({ chainSupported: { 0: false, 1: true, 2: true, 3: true } });
    const before = structuredClone(snapshot);
    const result = applyRouteHealth(snapshot, parseRouteHealthSnapshot(input));
    expect(result.chainSupported).toEqual({ 0: false, 1: false, 2: true, 3: false });
    expect(snapshot).toEqual(before);
  });

  it("requires matching provider, scope and fresh measured times when a context is supplied", () => {
    const health = parseRouteHealthSnapshot(healthy());
    const context = { now: 101n, maxAge: 11n, scope: "testnet:usdc", provider: "fixture" };
    expect(applyRouteHealth(state(), health, context).chainSupported).toEqual(all(true));
    for (const change of [
      { provider: "other" },
      { scope: "mainnet:usdc" },
      { maxAge: 10n },
      { now: 99n },
    ]) {
      expect(applyRouteHealth(state(), health, { ...context, ...change }).chainSupported).toEqual(
        all(false),
      );
    }
  });

  it("rejects field-specific invalid times, statuses and duplicate identities", () => {
    const input = healthy();
    for (const patch of [
      { status: "ready" },
      { measuredAt: "101" },
      { measuredAt: "01" },
      { scope: " " },
      { provider: "" },
    ]) {
      expect(() =>
        parseRouteHealthSnapshot({ ...input, records: [{ ...input.records[0], ...patch }] }),
      ).toThrow(Object.keys(patch)[0]);
    }
    expect(() =>
      parseRouteHealthSnapshot({ ...input, records: [input.records[0], input.records[0]] }),
    ).toThrow("duplicates");
    expect(() => parseRouteHealthSnapshot([])).toThrow("object");
    expect(() =>
      applyRouteHealth(state(), {
        ...parseRouteHealthSnapshot(input),
        capturedAt: 100 as unknown as bigint,
      }),
    ).toThrow("capturedAt");
  });
});
