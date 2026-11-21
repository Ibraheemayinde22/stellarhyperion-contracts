/**
 * The assets Hyperion carries, per chain.
 *
 * The same dollar has a different address, a different precision and a different way of being held
 * on every chain it exists on, and a bridge that treats those as interchangeable is a bridge that
 * eventually sends six decimals of something into a seven decimal slot. So each side is described
 * on its own terms and the two are tied together by a symbol rather than by an assumption.
 *
 * Provenance works the same way it does for the rail contracts: `confirmed` means a primary source
 * was read for that exact entry during this build. The deploy script reads `symbol()` and
 * `decimals()` on chain before registering anything regardless, because an address that is correct
 * today and a token that behaves as expected are two different claims.
 */
import type { ChainKey } from "../chains.js";
import type { Hex } from "../bytes.js";
import { RouteKind } from "../routes.js";

/**
 * How an asset is issued on the chain it lives on.
 *
 * `native` is the chain's own issuance of the ticker: Circle's USDC, or a Stellar classic asset
 * with an issuer. `its` is an Axelar Interchain Token Service representation of the same
 * underlying asset: a different contract, with its own address and sometimes its own precision.
 *
 * Two entries sharing a symbol and differing here are two different assets. A lookup that returns
 * "USDC" without saying which one it means is a lookup that can send the wrong token, so the
 * identity functions below carry the representation as part of the key rather than as a comment.
 */
export type AssetRepresentation = "native" | "its";

/** What every asset entry says about itself, whichever chain it lives on. */
interface AssetBase {
  readonly chain: ChainKey;
  /** The ticker, and the key that ties the two sides of a hop together. */
  readonly symbol: string;
  /** Native issuance versus an Interchain Token Service representation of the same asset. */
  readonly representation: AssetRepresentation;
  readonly name: string;
  readonly decimals: number;
  /** Which rails can carry this asset out of this chain. */
  readonly routes: readonly RouteKind[];
  readonly source: string;
  readonly confirmed: boolean;
}

export interface EvmAsset extends AssetBase {
  readonly family: "evm";
  readonly address: Hex;
}

export interface StellarAsset extends AssetBase {
  readonly family: "stellar";
  /** The classic asset code, four or twelve characters. */
  readonly code: string;
  /** The issuing account. Half of what makes a Stellar asset unique; the code is the other half. */
  readonly issuer: string;
  /**
   * The Stellar Asset Contract id, which Soroban actually calls into.
   *
   * Null here on purpose. It is derived from the code, the issuer and the network passphrase, so
   * the deploy script computes it with `stellar contract id asset` and writes it into the
   * deployment record rather than anybody typing it.
   */
  readonly sacId: string | null;
  readonly decimals: 7;
}

export type Asset = EvmAsset | StellarAsset;

const STELLAR_DOCS = "developers.stellar.org, read during this build";
const ARC_DOCS = "docs.arc.io, read during this build";
const CIRCLE_PUBLISHED =
  "Circle's published USDC deployment for this chain. The deploy script reads symbol and decimals on chain before registering it.";

/** Everything Hyperion can move. USDC first, because USDC is why CCTP exists. */
export const ASSETS: readonly Asset[] = [
  {
    family: "stellar",
    chain: "stellar",
    symbol: "USDC",
    representation: "native",
    name: "USD Coin",
    code: "USDC",
    issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sacId: null,
    decimals: 7,
    routes: [RouteKind.Cctp, RouteKind.AxelarIts, RouteKind.Allbridge],
    source: STELLAR_DOCS,
    confirmed: true,
  },
  {
    family: "stellar",
    chain: "stellar-testnet",
    symbol: "USDC",
    representation: "native",
    name: "USD Coin",
    code: "USDC",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    sacId: null,
    decimals: 7,
    routes: [RouteKind.Cctp, RouteKind.AxelarIts],
    source: STELLAR_DOCS,
    confirmed: true,
  },
  {
    family: "evm",
    chain: "arc",
    symbol: "USDC",
    representation: "native",
    name: "USD Coin",
    // Arc's USDC lives at a fixed system address rather than a deployed contract, and it is also
    // the gas token. Six decimals on the ERC-20 even though the chain accounts for gas in
    // eighteen, which is the single most expensive detail on this chain to get wrong.
    address: "0x3600000000000000000000000000000000000000",
    decimals: 6,
    routes: [RouteKind.Cctp],
    source: ARC_DOCS,
    confirmed: true,
  },
  {
    family: "evm",
    chain: "arc-testnet",
    symbol: "USDC",
    representation: "native",
    name: "USD Coin",
    address: "0x3600000000000000000000000000000000000000",
    decimals: 6,
    routes: [RouteKind.Cctp],
    source: ARC_DOCS,
    confirmed: true,
  },
  {
    family: "evm",
    chain: "arc",
    symbol: "EURC",
    representation: "native",
    name: "Euro Coin",
    address: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
    decimals: 6,
    routes: [RouteKind.AxelarIts],
    source: ARC_DOCS,
    confirmed: true,
  },
  {
    family: "evm",
    chain: "arc-testnet",
    symbol: "EURC",
    representation: "native",
    name: "Euro Coin",
    address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    decimals: 6,
    routes: [RouteKind.AxelarIts],
    source: ARC_DOCS,
    confirmed: true,
  },
  {
    family: "evm",
    chain: "ethereum",
    symbol: "USDC",
    representation: "native",
    name: "USD Coin",
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
    routes: [RouteKind.Cctp, RouteKind.AxelarIts, RouteKind.Allbridge],
    source: CIRCLE_PUBLISHED,
    confirmed: false,
  },
  {
    family: "evm",
    chain: "sepolia",
    symbol: "USDC",
    representation: "native",
    name: "USD Coin",
    address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    decimals: 6,
    routes: [RouteKind.Cctp, RouteKind.AxelarIts],
    source: CIRCLE_PUBLISHED,
    confirmed: false,
  },
  {
    family: "evm",
    chain: "base",
    symbol: "USDC",
    representation: "native",
    name: "USD Coin",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    routes: [RouteKind.Cctp, RouteKind.AxelarIts, RouteKind.Allbridge],
    source: CIRCLE_PUBLISHED,
    confirmed: false,
  },
  {
    family: "evm",
    chain: "base-sepolia",
    symbol: "USDC",
    representation: "native",
    name: "USD Coin",
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    decimals: 6,
    routes: [RouteKind.Cctp, RouteKind.AxelarIts],
    source: CIRCLE_PUBLISHED,
    confirmed: false,
  },
];

export function assetsOn(chainKey: ChainKey): readonly Asset[] {
  return ASSETS.filter((asset) => asset.chain === chainKey);
}

/**
 * An asset identified by everything that makes it unique on its chain.
 *
 * The chain alone is not enough, because the same ticker can be issued natively and wrapped by a
 * rail. The symbol alone is not enough for the same reason. What is left is the chain, the
 * representation and the on-chain handle: an EVM contract address, or a Stellar code and issuer.
 */
export interface EvmAssetIdentity {
  readonly family: "evm";
  readonly chain: ChainKey;
  readonly representation: AssetRepresentation;
  readonly address: Hex;
}

export interface StellarAssetIdentity {
  readonly family: "stellar";
  readonly chain: ChainKey;
  readonly representation: AssetRepresentation;
  readonly code: string;
  readonly issuer: string;
}

export type AssetIdentity = EvmAssetIdentity | StellarAssetIdentity;

export function assetIdentity(asset: Asset): AssetIdentity {
  if (isEvmAsset(asset)) {
    return {
      family: "evm",
      chain: asset.chain,
      representation: asset.representation,
      address: asset.address,
    };
  }
  return {
    family: "stellar",
    chain: asset.chain,
    representation: asset.representation,
    code: asset.code,
    issuer: asset.issuer,
  };
}

/** A stable key for maps, logs and cache entries. EVM addresses compare case insensitively. */
export function assetIdentityKey(identity: AssetIdentity): string {
  if (identity.family === "evm") {
    return `evm:${identity.chain}:${identity.representation}:${identity.address.toLowerCase()}`;
  }
  return `stellar:${identity.chain}:${identity.representation}:${identity.code}:${identity.issuer}`;
}

export function sameAssetIdentity(left: AssetIdentity, right: AssetIdentity): boolean {
  return assetIdentityKey(left) === assetIdentityKey(right);
}

/** Everything the caller knows about the asset it wants. `symbol` is optional, never required. */
export interface AssetQuery {
  readonly chain: ChainKey;
  /** The ticker, when the caller has one. Matching on symbol alone may be ambiguous. */
  readonly symbol?: string;
  /** Native issuance or an ITS representation. Required to separate two same-symbol entries. */
  readonly representation?: AssetRepresentation;
  /** EVM contract address. Case insensitive. */
  readonly address?: string;
  /** Stellar classic asset code, the other half of an issuer based identity. */
  readonly code?: string;
  /** Stellar issuing account. */
  readonly issuer?: string;
  /** Stellar Asset Contract id, when that is what the caller holds. */
  readonly sacId?: string;
  /** Only assets this rail can carry. */
  readonly route?: RouteKind;
}

export type AssetResolutionReason = "not-found" | "ambiguous";

/**
 * A lookup that either names exactly one asset or says why it could not.
 *
 * Never returns the first match. A duplicate symbol is a question the caller has to answer with a
 * representation or an address, not a race the registry settles silently.
 */
export type AssetResolution =
  | { readonly ok: true; readonly asset: Asset }
  | {
      readonly ok: false;
      readonly reason: AssetResolutionReason;
      readonly candidates: readonly Asset[];
    };

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function matchesAssetQuery(asset: Asset, query: AssetQuery): boolean {
  if (asset.chain !== query.chain) return false;
  if (query.symbol !== undefined && asset.symbol !== query.symbol) return false;
  if (query.representation !== undefined && asset.representation !== query.representation) {
    return false;
  }
  if (query.route !== undefined && !asset.routes.includes(query.route)) return false;

  if (isEvmAsset(asset)) {
    if (query.code !== undefined || query.issuer !== undefined || query.sacId !== undefined) {
      return false;
    }
    return query.address === undefined || sameHex(asset.address, query.address);
  }

  if (query.address !== undefined) return false;
  if (query.code !== undefined && asset.code !== query.code) return false;
  if (query.issuer !== undefined && asset.issuer !== query.issuer) return false;
  if (query.sacId !== undefined && asset.sacId !== query.sacId) return false;
  return true;
}

/** Resolve an asset without ever falling back to the first of several matches. */
export function resolveAsset(
  query: AssetQuery,
  registry: readonly Asset[] = ASSETS,
): AssetResolution {
  const candidates = registry.filter((asset) => matchesAssetQuery(asset, query));
  const [only] = candidates;
  if (only !== undefined && candidates.length === 1) return { ok: true, asset: only };
  if (candidates.length === 0) return { ok: false, reason: "not-found", candidates };
  return { ok: false, reason: "ambiguous", candidates };
}

/** Resolve the one asset a specific rail carries for a ticker on a chain. */
export function resolveAssetForRoute(
  chainKey: ChainKey,
  route: RouteKind,
  symbol: string,
  registry: readonly Asset[] = ASSETS,
): AssetResolution {
  return resolveAsset({ chain: chainKey, route, symbol }, registry);
}

/** Every asset carrying a symbol on a chain, so a caller can render the choice it has to make. */
export function assetsMatching(
  chainKey: ChainKey,
  symbol: string,
  registry: readonly Asset[] = ASSETS,
): readonly Asset[] {
  return registry.filter((asset) => asset.chain === chainKey && asset.symbol === symbol);
}

export function assetByIdentity(
  identity: AssetIdentity,
  registry: readonly Asset[] = ASSETS,
): Asset | null {
  const matches = registry.filter(
    (asset) =>
      asset.family === identity.family &&
      assetIdentityKey(assetIdentity(asset)) === assetIdentityKey(identity),
  );
  const [only] = matches;
  return only !== undefined && matches.length === 1 ? only : null;
}

/**
 * Legacy symbol-only lookup. Returns null when a chain carries more than one asset with the
 * ticker, because picking one of them for the caller is how an ITS representation gets mistaken
 * for native USDC. New code should use `resolveAsset`, `resolveAssetForRoute` or
 * `assetByIdentity`; this remains for callers that only know a ticker and a chain.
 */
export function assetOn(
  chainKey: ChainKey,
  symbol: string,
  registry: readonly Asset[] = ASSETS,
): Asset | null {
  const matches = assetsMatching(chainKey, symbol, registry);
  const [only] = matches;
  return only !== undefined && matches.length === 1 ? only : null;
}

export function isEvmAsset(asset: Asset): asset is EvmAsset {
  return asset.family === "evm";
}

export function isStellarAsset(asset: Asset): asset is StellarAsset {
  return asset.family === "stellar";
}

/**
 * Whether a symbol exists on both ends of a hop.
 *
 * Follows `assetOn`, so a symbol that resolves ambiguously on either end counts as absent rather
 * than as whichever entry happened to be listed first.
 */
export function pairExists(
  from: ChainKey,
  to: ChainKey,
  symbol: string,
  registry: readonly Asset[] = ASSETS,
): boolean {
  return assetOn(from, symbol, registry) !== null && assetOn(to, symbol, registry) !== null;
}

/**
 * Every rail that can carry a symbol from one chain to another, in no particular order.
 *
 * Symbol-only, and therefore ambiguous where a chain lists two representations of the same
 * ticker. Returns nothing in that case; use `resolveAssetForRoute` on both ends when the
 * representation matters, which for a real transfer it always does.
 */
export function routesForPair(
  from: ChainKey,
  to: ChainKey,
  symbol: string,
  registry: readonly Asset[] = ASSETS,
): readonly RouteKind[] {
  const source = assetOn(from, symbol, registry);
  const destination = assetOn(to, symbol, registry);
  if (source === null || destination === null) return [];
  return source.routes.filter((route) => destination.routes.includes(route));
}
