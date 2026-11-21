/**
 * Asset identity, route scoping and symbol ambiguity.
 *
 * The fixtures here are deliberately synthetic where the published registry has only one
 * representation: a second USDC entry is how the registry will look once an ITS representation is
 * recorded, and the point of these tests is that no lookup settles that ambiguity by choosing.
 */
import { describe, expect, it } from "vitest";
import type { EvmAsset, StellarAsset } from "../src/registry/assets.js";
import {
  assetByIdentity,
  assetIdentity,
  assetIdentityKey,
  assetOn,
  assetsMatching,
  pairExists,
  resolveAsset,
  resolveAssetForRoute,
  routesForPair,
  sameAssetIdentity,
} from "../src/registry/assets.js";
import {
  DEPLOYMENT_SCHEMA_VERSION,
  DeploymentFormatError,
  parseDeploymentSet,
  resolveToken,
  tokenByIdentity,
  tokenFor,
  tokenIdentity,
} from "../src/deployments.js";
import type { RouterSnapshot } from "../src/quotes.js";
import {
  MAX_QUOTE_AMOUNT,
  QuoteBlocker,
  planQuoteForAsset,
  planQuotesForAsset,
  quoteBatch,
} from "../src/quotes.js";
import { RouteKind } from "../src/routes.js";
import { C_ADDR, G_ADDR, USDC_MAINNET_ISSUER } from "./fixtures.js";

const NATIVE_BASE: EvmAsset = {
  family: "evm",
  chain: "base",
  symbol: "USDC",
  representation: "native",
  name: "USD Coin",
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  decimals: 6,
  routes: [RouteKind.Cctp, RouteKind.AxelarIts],
  source: "fixture",
  confirmed: true,
};

const ITS_BASE: EvmAsset = {
  family: "evm",
  chain: "base",
  symbol: "USDC",
  representation: "its",
  name: "USD Coin (Axelar ITS)",
  // A representation lives at its own address. Invented here, and labelled as a fixture.
  address: "0x9999999999999999999999999999999999999999",
  decimals: 6,
  routes: [RouteKind.AxelarIts],
  source: "fixture",
  confirmed: false,
};

const NATIVE_STELLAR: StellarAsset = {
  family: "stellar",
  chain: "stellar-testnet",
  symbol: "USDC",
  representation: "native",
  name: "USD Coin",
  code: "USDC",
  issuer: G_ADDR,
  sacId: C_ADDR,
  decimals: 7,
  routes: [RouteKind.Cctp, RouteKind.AxelarIts],
  source: "fixture",
  confirmed: true,
};

const ITS_STELLAR: StellarAsset = {
  ...NATIVE_STELLAR,
  representation: "its",
  name: "USD Coin (Axelar ITS)",
  sacId: "CAGR5KFYMZYI7WWQ6TWYYZ346T7GNZLKER4DOJTAG3SOB46QLR5RAPSN",
  routes: [RouteKind.AxelarIts],
  confirmed: false,
};

describe("asset identity keys", () => {
  it("keeps native USDC and its ITS representation apart", () => {
    const native = assetIdentity(NATIVE_BASE);
    const its = assetIdentity(ITS_BASE);
    expect(assetIdentityKey(native)).not.toBe(assetIdentityKey(its));
    expect(sameAssetIdentity(native, its)).toBe(false);
  });

  it("carries chain, representation and address for an EVM asset", () => {
    expect(assetIdentity(NATIVE_BASE)).toEqual({
      family: "evm",
      chain: "base",
      representation: "native",
      address: NATIVE_BASE.address,
    });
  });

  it("carries chain, representation, code and issuer for a Stellar asset", () => {
    expect(assetIdentity(NATIVE_STELLAR)).toEqual({
      family: "stellar",
      chain: "stellar-testnet",
      representation: "native",
      code: "USDC",
      issuer: G_ADDR,
    });
  });

  it("compares EVM addresses case insensitively and Stellar identities exactly", () => {
    expect(
      sameAssetIdentity(assetIdentity(NATIVE_BASE), {
        family: "evm",
        chain: "base",
        representation: "native",
        address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      }),
    ).toBe(true);
    expect(
      sameAssetIdentity(assetIdentity(NATIVE_STELLAR), {
        family: "stellar",
        chain: "stellar-testnet",
        representation: "native",
        code: "USDC",
        issuer: USDC_MAINNET_ISSUER,
      }),
    ).toBe(false);
  });
});

describe("resolving an asset without settling a symbol tie", () => {
  const registry = [NATIVE_BASE, ITS_BASE, NATIVE_STELLAR, ITS_STELLAR];

  it("reports a duplicate symbol as ambiguous instead of returning the first entry", () => {
    const resolution = resolveAsset({ chain: "base", symbol: "USDC" }, registry);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.reason).toBe("ambiguous");
      expect(resolution.candidates).toEqual([NATIVE_BASE, ITS_BASE]);
    }
  });

  it("answers null from the legacy symbol lookup where two assets share a ticker", () => {
    // The pre-identity API. It must not pick one; callers have to name a representation.
    expect(assetOn("base", "USDC", registry)).toBeNull();
    expect(assetsMatching("base", "USDC", registry).length).toBe(2);
  });

  it("resolves each representation once the caller names it", () => {
    const native = resolveAsset(
      { chain: "base", symbol: "USDC", representation: "native" },
      registry,
    );
    const its = resolveAsset({ chain: "base", symbol: "USDC", representation: "its" }, registry);
    expect(native.ok && native.asset).toBe(NATIVE_BASE);
    expect(its.ok && its.asset).toBe(ITS_BASE);
  });

  it("resolves by address, which needs no symbol at all", () => {
    const resolution = resolveAsset(
      { chain: "base", address: ITS_BASE.address.toLowerCase() },
      registry,
    );
    expect(resolution.ok && resolution.asset).toBe(ITS_BASE);
  });

  it("resolves by Stellar code, issuer and representation", () => {
    const resolution = resolveAsset(
      {
        chain: "stellar-testnet",
        code: "USDC",
        issuer: G_ADDR,
        representation: "its",
      },
      registry,
    );
    expect(resolution.ok && resolution.asset).toBe(ITS_STELLAR);
  });

  it("refuses a query that mixes an EVM address with a Stellar code", () => {
    const resolution = resolveAsset(
      { chain: "base", address: NATIVE_BASE.address, code: "USDC" },
      registry,
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.reason).toBe("not-found");
  });

  it("says not-found, with no candidates, when nothing matches", () => {
    const resolution = resolveAsset({ chain: "arc", symbol: "USDC" }, registry);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.reason).toBe("not-found");
      expect(resolution.candidates).toEqual([]);
    }
  });
});

describe("route-specific resolution", () => {
  const registry = [NATIVE_BASE, ITS_BASE, NATIVE_STELLAR, ITS_STELLAR];

  it("picks the native representation where only it supports CCTP", () => {
    const resolution = resolveAssetForRoute("base", RouteKind.Cctp, "USDC", registry);
    expect(resolution.ok && resolution.asset).toBe(NATIVE_BASE);
  });

  it("reports both representations as ambiguous on a rail they both carry", () => {
    const resolution = resolveAssetForRoute("base", RouteKind.AxelarIts, "USDC", registry);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.reason).toBe("ambiguous");
  });

  it("returns not-found for a rail neither representation lists", () => {
    const resolution = resolveAssetForRoute("base", RouteKind.Allbridge, "USDC", registry);
    expect(resolution.ok).toBe(false);
  });

  it("looks an asset up by identity, and refuses a family mismatch", () => {
    expect(assetByIdentity(assetIdentity(ITS_BASE), registry)).toBe(ITS_BASE);
    expect(
      assetByIdentity(
        {
          family: "evm",
          chain: "stellar-testnet",
          representation: "its",
          address: ITS_BASE.address,
        },
        registry,
      ),
    ).toBeNull();
  });

  it("makes symbol-only pair helpers fail shut on an ambiguous end", () => {
    // With two USDC entries on base, the legacy helpers report no pair rather than guessing.
    const nativeStellarAgain: StellarAsset = {
      ...NATIVE_STELLAR,
      representation: "its",
      routes: [RouteKind.Cctp, RouteKind.AxelarIts],
    };
    const duplicated = [NATIVE_BASE, ITS_BASE, NATIVE_STELLAR, nativeStellarAgain];
    expect(assetOn("stellar-testnet", "USDC", duplicated)).toBeNull();
    expect(pairExists("stellar-testnet", "base", "USDC", duplicated)).toBe(false);
    expect(routesForPair("stellar-testnet", "base", "USDC", duplicated)).toEqual([]);
  });
});

function evmRecord(tokens: Record<string, unknown>): Record<string, unknown> {
  return {
    family: "evm",
    chainId: 8453,
    router: "0x1111111111111111111111111111111111111111",
    adapters: { cctp: "0x2222222222222222222222222222222222222222" },
    tokens,
    treasury: "0x3333333333333333333333333333333333333333",
    admin: "0x4444444444444444444444444444444444444444",
    guardian: "0x5555555555555555555555555555555555555555",
    feeBps: 30,
    flowWindow: 3600,
    timelockDelay: 172_800,
    deployedAt: {
      blockNumber: "21000000",
      timestamp: "2026-09-30T12:00:00.000Z",
      txHash: `0x${"ab".repeat(32)}`,
    },
    commit: "0123456789abcdef0123456789abcdef01234567",
  };
}

function tokenRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: NATIVE_BASE.address,
    decimals: 6,
    flowLimit: "1000000000000",
    routes: ["cctp", "axelar-its"],
    ...overrides,
  };
}

function set(networks: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    generatedAt: "2026-09-30T12:00:00.000Z",
    networks,
  };
}

describe("deployment tokens by identity", () => {
  it("defaults an omitted representation to native and an omitted symbol to the key", () => {
    const parsed = parseDeploymentSet(set({ base: evmRecord({ USDC: tokenRecord() }) }));
    const token = tokenFor(parsed, "base", "USDC");
    expect(token?.representation).toBe("native");
    expect(token?.symbol).toBe("USDC");
  });

  it("records two representations of one ticker under distinct keys", () => {
    const parsed = parseDeploymentSet(
      set({
        base: evmRecord({
          USDC: tokenRecord(),
          "USDC.its": tokenRecord({
            symbol: "USDC",
            representation: "its",
            address: ITS_BASE.address,
            routes: ["axelar-its"],
            flowLimit: (2n ** 256n - 1n).toString(),
          }),
        }),
      }),
    );

    // The legacy symbol lookup cannot choose between them.
    expect(tokenFor(parsed, "base", "USDC")).toBeNull();

    const its = resolveToken(parsed, "base", {
      symbol: "USDC",
      representation: "its",
    });
    expect(its.ok).toBe(true);
    if (its.ok) {
      expect(tokenIdentity("base", its.token)).toEqual(assetIdentity(ITS_BASE));
      // The integer boundary survives the record and the hidden representation field.
      expect(BigInt(its.token.flowLimit)).toBe(MAX_QUOTE_AMOUNT * (1n << 128n) + MAX_QUOTE_AMOUNT);
    }

    const cctp = resolveToken(parsed, "base", { symbol: "USDC", route: RouteKind.Cctp });
    expect(cctp.ok && tokenIdentity("base", cctp.token)).toEqual(assetIdentity(NATIVE_BASE));
  });

  it("derives a token identity that matches the registry identity", () => {
    const parsed = parseDeploymentSet(
      set({
        base: evmRecord({
          USDC: tokenRecord(),
          "USDC.its": tokenRecord({
            symbol: "USDC",
            representation: "its",
            address: ITS_BASE.address,
            routes: ["axelar-its"],
          }),
        }),
      }),
    );
    const its = resolveToken(parsed, "base", { representation: "its" });
    expect(its.ok).toBe(true);
    if (!its.ok) return;
    expect(tokenIdentity("base", its.token)).toEqual(assetIdentity(ITS_BASE));
    expect(tokenByIdentity(parsed, assetIdentity(ITS_BASE))).toBe(its.token);
    expect(tokenByIdentity(parsed, assetIdentity(NATIVE_BASE))?.symbol).toBe("USDC");
  });

  it("refuses a representation it does not know, naming the field", () => {
    try {
      parseDeploymentSet(
        set({ base: evmRecord({ USDC: tokenRecord({ representation: "wrapped" }) }) }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentFormatError);
      expect((error as DeploymentFormatError).path).toBe(
        "$.networks.base.tokens.USDC.representation",
      );
    }
  });

  it("resolves a Stellar token by code, issuer and representation", () => {
    const stellarToken = {
      sacId: C_ADDR,
      code: "USDC",
      issuer: G_ADDR,
      decimals: 7,
      flowLimit: "10000000000000",
      routes: ["cctp", "axelar-its"],
    };
    const parsed = parseDeploymentSet(
      set({
        "stellar-testnet": {
          family: "stellar",
          networkPassphrase: "Test SDF Network ; September 2015",
          router: C_ADDR,
          adapters: { cctp: C_ADDR },
          tokens: {
            USDC: stellarToken,
            "USDC.its": {
              ...stellarToken,
              symbol: "USDC",
              representation: "its",
              sacId: "CAGR5KFYMZYI7WWQ6TWYYZ346T7GNZLKER4DOJTAG3SOB46QLR5RAPSN",
              routes: ["axelar-its"],
            },
          },
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
      }),
    );

    expect(tokenFor(parsed, "stellar-testnet", "USDC")).toBeNull();
    const resolved = resolveToken(parsed, "stellar-testnet", {
      code: "USDC",
      issuer: G_ADDR,
      representation: "its",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok && "sacId" in resolved.token) {
      expect(resolved.token.sacId).toBe("CAGR5KFYMZYI7WWQ6TWYYZ346T7GNZLKER4DOJTAG3SOB46QLR5RAPSN");
      expect(tokenByIdentity(parsed, assetIdentity(ITS_STELLAR))).toBe(resolved.token);
    }
  });
});

function snapshot(overrides: Partial<RouterSnapshot> = {}): RouterSnapshot {
  const all = <T>(value: T): Record<RouteKind, T> => ({
    [RouteKind.Cctp]: value,
    [RouteKind.AxelarIts]: value,
    [RouteKind.AxelarGmp]: value,
    [RouteKind.Allbridge]: value,
  });
  return {
    paused: false,
    feeBps: 0,
    routeEnabled: all(true),
    adapterSet: all(true),
    tokenRegistered: true,
    tokenEnabled: true,
    tokenDecimals: 6,
    tokenIdentity: assetIdentity(NATIVE_BASE),
    flowAvailable: all(1_000_000_000n),
    chainSupported: all(true),
    ...overrides,
  };
}

describe("quoting a named asset representation", () => {
  const registry = [NATIVE_BASE, ITS_BASE];
  const baseRequest = {
    amount: 1_000_000n,
    strkey: G_ADDR,
    destinationDecimals: 6,
  } as const;

  it("blocks missing or mismatched token observations before quoting any rail", () => {
    const unqualified = { ...snapshot() };
    delete unqualified.tokenIdentity;
    for (const observed of [
      unqualified,
      snapshot({ tokenIdentity: assetIdentity(ITS_BASE) }),
      snapshot({ tokenDecimals: 18 }),
    ]) {
      const quote = planQuoteForAsset(
        { ...baseRequest, route: RouteKind.Cctp, asset: assetIdentity(NATIVE_BASE) },
        observed,
        registry,
      );
      expect(quote.reason).toBe(QuoteBlocker.TokenNotRegistered);
      const batch = quoteBatch([baseRequest.amount], {
        ...baseRequest,
        snapshot: observed,
        asset: assetIdentity(NATIVE_BASE),
        registry,
      });
      expect(batch[0]!.available).toBe(false);
    }
  });

  it("prices the native representation on CCTP", () => {
    const quote = planQuoteForAsset(
      {
        ...baseRequest,
        route: RouteKind.Cctp,
        asset: assetIdentity(NATIVE_BASE),
      },
      snapshot(),
      registry,
    );
    expect(quote.available).toBe(true);
    expect(quote.reason).toBe(QuoteBlocker.None);
    expect(quote.netAmount).toBe(1_000_000n);
  });

  it("refuses an ITS representation on a rail it is not registered for", () => {
    const quote = planQuoteForAsset(
      { ...baseRequest, route: RouteKind.Cctp, asset: assetIdentity(ITS_BASE) },
      snapshot(),
      registry,
    );
    expect(quote.available).toBe(false);
    expect(quote.reason).toBe(QuoteBlocker.TokenNotRegistered);
  });

  it("refuses an identity the registry does not carry", () => {
    const quote = planQuoteForAsset(
      {
        ...baseRequest,
        route: RouteKind.Cctp,
        asset: {
          family: "evm",
          chain: "base",
          representation: "native",
          address: "0x0000000000000000000000000000000000000001",
        },
      },
      snapshot(),
      registry,
    );
    expect(quote.reason).toBe(QuoteBlocker.TokenNotRegistered);
  });

  it("plans every rail while leaving the unregistered ones blocked", () => {
    const quotes = planQuotesForAsset(
      { ...baseRequest, asset: assetIdentity(ITS_BASE) },
      snapshot({ tokenIdentity: assetIdentity(ITS_BASE) }),
      registry,
    );
    expect(quotes.length).toBe(4);
    for (const quote of quotes) {
      expect(quote.available).toBe(quote.route === RouteKind.AxelarIts);
    }
  });

  it("preserves an integer above the safe number range exactly", () => {
    const amount = 9_007_199_254_740_993n;
    const quote = planQuoteForAsset(
      {
        amount,
        strkey: G_ADDR,
        destinationDecimals: 6,
        route: RouteKind.Cctp,
        asset: assetIdentity(NATIVE_BASE),
      },
      snapshot({ flowAvailable: { [RouteKind.Cctp]: amount } }),
      registry,
    );
    expect(quote.available).toBe(true);
    expect(quote.destinationAmount).toBe(amount);
    expect(quote.grossAmount).toBe(amount);
  });

  it("scopes a batch to one representation and reports it", () => {
    const results = quoteBatch([1_000_000n], {
      strkey: G_ADDR,
      destinationDecimals: 6,
      snapshot: snapshot({ tokenIdentity: assetIdentity(ITS_BASE) }),
      asset: assetIdentity(ITS_BASE),
      registry,
    });
    const result = results[0]!;
    expect(result.asset).toEqual(assetIdentity(ITS_BASE));
    expect(result.winningRail).toBe(RouteKind.AxelarIts);
    const blocked = result.quotes.filter((quote) => quote.route !== RouteKind.AxelarIts);
    expect(blocked.every((quote) => quote.reason === QuoteBlocker.TokenNotRegistered)).toBe(true);
    expect(result.netAmount).toBe(1_000_000n);
  });

  it("keeps the legacy batch shape when no identity is supplied", () => {
    const results = quoteBatch([1_000_000n], {
      strkey: G_ADDR,
      destinationDecimals: 6,
      snapshot: snapshot(),
    });
    expect(results[0]!.asset).toBeNull();
    expect(results[0]!.available).toBe(true);
    expect(results[0]!.winningRail).toBe(RouteKind.Cctp);
  });
});
