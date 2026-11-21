/**
 * Where Hyperion actually lives, once it has been deployed somewhere.
 *
 * Nothing in this file is a constant. Addresses come from `deployments/<network>.json`, which the
 * deploy scripts write and a human reviews, and the loader below checks the shape rather than
 * casting it. That matters more than it sounds: an address with a transposed character parses
 * fine as a string, passes a cast without complaint, and turns into a transfer to nobody. The
 * validator refuses the file instead, at start up, where somebody is watching.
 *
 * Deliberately not baked into the bundle either. A frontend that hard codes a router address is a
 * frontend that needs a release to follow a redeployment, and the one time that matters is during
 * an incident.
 */
import type { Hex } from "./bytes.js";
import type { ChainKey } from "./chains.js";
import { isChainKey } from "./chains.js";
import type { AssetIdentity, AssetRepresentation } from "./registry/assets.js";
import type { RouteKind } from "./routes.js";
import { ROUTE_KINDS, ROUTE_SLUGS, tryRouteFromSlug } from "./routes.js";
import { isStellarAddress } from "./addresses.js";

/** The schema version of a deployment file, so an old file fails loudly rather than oddly. */
export const DEPLOYMENT_SCHEMA_VERSION = 1;

export interface DeployedAtEvm {
  /** Block the router landed in, as a string because JSON numbers stop being exact above 2^53. */
  readonly blockNumber: string;
  /** ISO 8601, UTC. */
  readonly timestamp: string;
  readonly txHash: Hex;
}

export interface DeployedAtStellar {
  readonly ledger: number;
  readonly timestamp: string;
}

export interface EvmTokenDeployment {
  /** The ticker this token represents. Defaults to the record key when the file omits it. */
  readonly symbol: string;
  /** Native issuance or an ITS representation of the same ticker. */
  readonly representation: AssetRepresentation;
  readonly address: Hex;
  readonly decimals: number;
  /** The flow ceiling the router was configured with, in this asset's own units. */
  readonly flowLimit: string;
  /** Which rails this asset is registered for here. */
  readonly routes: readonly RouteKind[];
}

export interface StellarTokenDeployment {
  /** The ticker this token represents. Defaults to the record key when the file omits it. */
  readonly symbol: string;
  /** Native issuance or an ITS representation of the same ticker. */
  readonly representation: AssetRepresentation;
  /** The Stellar Asset Contract id, which is what Soroban calls. */
  readonly sacId: string;
  readonly code: string;
  readonly issuer: string;
  readonly decimals: number;
  readonly flowLimit: string;
  readonly routes: readonly RouteKind[];
}

export interface EvmDeployment {
  readonly family: "evm";
  readonly chain: ChainKey;
  readonly chainId: number;
  readonly router: Hex;
  readonly adapters: Readonly<Partial<Record<RouteKind, Hex>>>;
  /** Keyed by symbol, because that is what a person picks from a list. */
  readonly tokens: Readonly<Record<string, EvmTokenDeployment>>;
  readonly treasury: Hex;
  readonly admin: Hex;
  readonly guardian: Hex;
  readonly feeBps: number;
  /** Seconds. The router's own flow window, not a rail's. */
  readonly flowWindow: number;
  readonly timelockDelay: number;
  readonly deployedAt: DeployedAtEvm;
  /** The commit the bytecode was built from. The only thing tying an address to a source tree. */
  readonly commit: string;
}

export interface StellarDeployment {
  readonly family: "stellar";
  readonly chain: ChainKey;
  readonly networkPassphrase: string;
  readonly router: string;
  readonly adapters: Readonly<Partial<Record<RouteKind, string>>>;
  readonly tokens: Readonly<Record<string, StellarTokenDeployment>>;
  readonly treasury: string;
  readonly admin: string;
  readonly guardian: string;
  readonly feeBps: number;
  /** Ledgers, not seconds, because that is what the Soroban side counts in. */
  readonly flowWindow: number;
  readonly timelockDelay: number;
  /** Hex hashes of the uploaded WASM, one per contract, so an installed build is identifiable. */
  readonly wasmHashes: Readonly<Record<string, string>>;
  readonly deployedAt: DeployedAtStellar;
  readonly commit: string;
}

export type Deployment = EvmDeployment | StellarDeployment;

export interface DeploymentSet {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly networks: Readonly<Partial<Record<ChainKey, Deployment>>>;
}

/** Thrown when a deployment file does not hold together. Carries the path to the bad field. */
export class DeploymentFormatError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`deployment record invalid at ${path}: ${reason}`);
    this.name = "DeploymentFormatError";
  }
}

function fail(path: string, reason: string): never {
  throw new DeploymentFormatError(path, reason);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(path, "expected a non empty string");
  return value;
}

function asInteger(value: unknown, path: string, min = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    fail(path, `expected an integer of at least ${String(min)}`);
  }
  return value;
}

/** A decimal string, because a flow ceiling in wei does not survive a double. */
function asUintString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    // Worth its own message. A ceiling written as a JSON number is the mistake somebody makes
    // once per deployment file, and "expected a string" does not explain why.
    fail(
      path,
      "expected a decimal integer written as a string, because a large one loses precision as a JSON number",
    );
  }
  if (!/^\d+$/.test(value)) fail(path, "expected a decimal integer written as a string");
  return value;
}

function asEvmAddress(value: unknown, path: string): Hex {
  const text = asString(value, path);
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) fail(path, "expected a 20 byte hex address");
  return text as Hex;
}

function asHash(value: unknown, path: string): Hex {
  const text = asString(value, path);
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) fail(path, "expected a 32 byte hex hash");
  return text as Hex;
}

function asStellarContract(value: unknown, path: string): string {
  const text = asString(value, path);
  if (!text.startsWith("C") || !isStellarAddress(text)) {
    fail(path, "expected a Stellar contract id starting with C");
  }
  return text;
}

function asStellarAccount(value: unknown, path: string): string {
  const text = asString(value, path);
  if (!isStellarAddress(text)) fail(path, "expected a Stellar address");
  return text;
}

function asTimestamp(value: unknown, path: string): string {
  const text = asString(value, path);
  if (Number.isNaN(Date.parse(text))) fail(path, "expected an ISO 8601 timestamp");
  return text;
}

/**
 * The representation of a token record.
 *
 * Absent means `native`, which is what every record written before this field existed means, so
 * older deployment files keep loading unchanged. An unknown value is refused rather than treated
 * as native: a typo that silently promoted an ITS representation to native USDC would be the
 * expensive kind of compatible.
 */
function asRepresentation(value: unknown, path: string): AssetRepresentation {
  if (value === undefined) return "native";
  const text = asString(value, path);
  if (text !== "native" && text !== "its") {
    fail(path, 'expected "native" or "its"');
  }
  return text;
}

/** The ticker a record carries, defaulting to the map key for files that predate the field. */
function asTokenSymbol(value: unknown, path: string, key: string): string {
  return value === undefined ? key : asString(value, path);
}

function asRoutes(value: unknown, path: string): readonly RouteKind[] {
  if (!Array.isArray(value)) fail(path, "expected an array of rail slugs");
  return value.map((entry, index) => {
    const slug = asString(entry, `${path}[${String(index)}]`);
    const route = tryRouteFromSlug(slug);
    if (route === null) {
      fail(
        `${path}[${String(index)}]`,
        `unknown rail "${slug}", expected one of ${ROUTE_KINDS.map((kind) => ROUTE_SLUGS[kind]).join(", ")}`,
      );
    }
    return route;
  });
}

function asAdapters<T>(
  value: unknown,
  path: string,
  read: (entry: unknown, entryPath: string) => T,
): Partial<Record<RouteKind, T>> {
  const record = asRecord(value, path);
  const out: Partial<Record<RouteKind, T>> = {};
  for (const [slug, entry] of Object.entries(record)) {
    const route = tryRouteFromSlug(slug);
    if (route === null) fail(`${path}.${slug}`, "unknown rail slug");
    out[route] = read(entry, `${path}.${slug}`);
  }
  return out;
}

function readEvmDeployment(
  raw: Record<string, unknown>,
  chain: ChainKey,
  path: string,
): EvmDeployment {
  const tokensRaw = asRecord(raw.tokens, `${path}.tokens`);
  const tokens: Record<string, EvmTokenDeployment> = {};
  for (const [symbol, entry] of Object.entries(tokensRaw)) {
    const tokenPath = `${path}.tokens.${symbol}`;
    const token = asRecord(entry, tokenPath);
    tokens[symbol] = {
      symbol: asTokenSymbol(token.symbol, `${tokenPath}.symbol`, symbol),
      representation: asRepresentation(token.representation, `${tokenPath}.representation`),
      address: asEvmAddress(token.address, `${tokenPath}.address`),
      decimals: asInteger(token.decimals, `${tokenPath}.decimals`),
      flowLimit: asUintString(token.flowLimit, `${tokenPath}.flowLimit`),
      routes: asRoutes(token.routes, `${tokenPath}.routes`),
    };
  }

  const deployedAt = asRecord(raw.deployedAt, `${path}.deployedAt`);
  return {
    family: "evm",
    chain,
    chainId: asInteger(raw.chainId, `${path}.chainId`, 1),
    router: asEvmAddress(raw.router, `${path}.router`),
    adapters: asAdapters(raw.adapters, `${path}.adapters`, asEvmAddress),
    tokens,
    treasury: asEvmAddress(raw.treasury, `${path}.treasury`),
    admin: asEvmAddress(raw.admin, `${path}.admin`),
    guardian: asEvmAddress(raw.guardian, `${path}.guardian`),
    feeBps: asInteger(raw.feeBps, `${path}.feeBps`),
    flowWindow: asInteger(raw.flowWindow, `${path}.flowWindow`, 1),
    timelockDelay: asInteger(raw.timelockDelay, `${path}.timelockDelay`),
    deployedAt: {
      blockNumber: asUintString(deployedAt.blockNumber, `${path}.deployedAt.blockNumber`),
      timestamp: asTimestamp(deployedAt.timestamp, `${path}.deployedAt.timestamp`),
      txHash: asHash(deployedAt.txHash, `${path}.deployedAt.txHash`),
    },
    commit: asString(raw.commit, `${path}.commit`),
  };
}

function readStellarDeployment(
  raw: Record<string, unknown>,
  chain: ChainKey,
  path: string,
): StellarDeployment {
  const tokensRaw = asRecord(raw.tokens, `${path}.tokens`);
  const tokens: Record<string, StellarTokenDeployment> = {};
  for (const [symbol, entry] of Object.entries(tokensRaw)) {
    const tokenPath = `${path}.tokens.${symbol}`;
    const token = asRecord(entry, tokenPath);
    tokens[symbol] = {
      symbol: asTokenSymbol(token.symbol, `${tokenPath}.symbol`, symbol),
      representation: asRepresentation(token.representation, `${tokenPath}.representation`),
      sacId: asStellarContract(token.sacId, `${tokenPath}.sacId`),
      code: asString(token.code, `${tokenPath}.code`),
      issuer: asStellarAccount(token.issuer, `${tokenPath}.issuer`),
      decimals: asInteger(token.decimals, `${tokenPath}.decimals`),
      flowLimit: asUintString(token.flowLimit, `${tokenPath}.flowLimit`),
      routes: asRoutes(token.routes, `${tokenPath}.routes`),
    };
  }

  const hashesRaw = asRecord(raw.wasmHashes, `${path}.wasmHashes`);
  const wasmHashes: Record<string, string> = {};
  for (const [name, entry] of Object.entries(hashesRaw)) {
    const hash = asString(entry, `${path}.wasmHashes.${name}`);
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      fail(`${path}.wasmHashes.${name}`, "expected 64 lowercase hex characters");
    }
    wasmHashes[name] = hash;
  }

  const deployedAt = asRecord(raw.deployedAt, `${path}.deployedAt`);
  return {
    family: "stellar",
    chain,
    networkPassphrase: asString(raw.networkPassphrase, `${path}.networkPassphrase`),
    router: asStellarContract(raw.router, `${path}.router`),
    adapters: asAdapters(raw.adapters, `${path}.adapters`, asStellarContract),
    tokens,
    treasury: asStellarAccount(raw.treasury, `${path}.treasury`),
    admin: asStellarAccount(raw.admin, `${path}.admin`),
    guardian: asStellarAccount(raw.guardian, `${path}.guardian`),
    feeBps: asInteger(raw.feeBps, `${path}.feeBps`),
    flowWindow: asInteger(raw.flowWindow, `${path}.flowWindow`, 1),
    timelockDelay: asInteger(raw.timelockDelay, `${path}.timelockDelay`),
    wasmHashes,
    deployedAt: {
      ledger: asInteger(deployedAt.ledger, `${path}.deployedAt.ledger`, 1),
      timestamp: asTimestamp(deployedAt.timestamp, `${path}.deployedAt.timestamp`),
    },
    commit: asString(raw.commit, `${path}.commit`),
  };
}

/**
 * Read a deployment set, checking every field.
 *
 * Takes `unknown` on purpose. The input is a parsed JSON file or an HTTP response body, and both
 * of those are somebody else's output no matter how much this repository wrote them.
 */
export function parseDeploymentSet(value: unknown): DeploymentSet {
  const raw = asRecord(value, "$");
  const schemaVersion = asInteger(raw.schemaVersion, "$.schemaVersion", 1);
  if (schemaVersion !== DEPLOYMENT_SCHEMA_VERSION) {
    fail(
      "$.schemaVersion",
      `expected ${String(DEPLOYMENT_SCHEMA_VERSION)}, found ${String(schemaVersion)}`,
    );
  }

  const networksRaw = asRecord(raw.networks, "$.networks");
  const networks: Partial<Record<ChainKey, Deployment>> = {};
  for (const [key, entry] of Object.entries(networksRaw)) {
    const path = `$.networks.${key}`;
    if (!isChainKey(key)) fail(path, "unknown chain key");
    const record = asRecord(entry, path);
    const family = asString(record.family, `${path}.family`);
    if (family === "evm") {
      networks[key] = readEvmDeployment(record, key, path);
    } else if (family === "stellar") {
      networks[key] = readStellarDeployment(record, key, path);
    } else {
      fail(`${path}.family`, `expected "evm" or "stellar", found "${family}"`);
    }
  }

  return {
    schemaVersion,
    generatedAt: asTimestamp(raw.generatedAt, "$.generatedAt"),
    networks,
  };
}

export function isEvmDeployment(deployment: Deployment): deployment is EvmDeployment {
  return deployment.family === "evm";
}

export function isStellarDeployment(deployment: Deployment): deployment is StellarDeployment {
  return deployment.family === "stellar";
}

export function deploymentFor(set: DeploymentSet, chain: ChainKey): Deployment | null {
  return set.networks[chain] ?? null;
}

/** The adapter for a rail on a chain, or null when that rail is not wired up there. */
export function adapterFor(set: DeploymentSet, chain: ChainKey, route: RouteKind): string | null {
  const deployment = set.networks[chain];
  if (deployment === undefined) return null;
  return deployment.adapters[route] ?? null;
}

/** The token entries of a deployment, with the family the record declares. */
function deployedTokens(
  deployment: Deployment,
): readonly (EvmTokenDeployment | StellarTokenDeployment)[] {
  if (isEvmDeployment(deployment)) return Object.values(deployment.tokens);
  return Object.values(deployment.tokens);
}

export function tokenFor(
  set: DeploymentSet,
  chain: ChainKey,
  symbol: string,
): EvmTokenDeployment | StellarTokenDeployment | null {
  const deployment = set.networks[chain];
  if (deployment === undefined) return null;
  const matches = deployedTokens(deployment).filter((token) => token.symbol === symbol);
  // A record may list native USDC and an ITS representation of it under the same ticker. Picking
  // the first would price the wrong decimals and register the wrong address on the next deploy,
  // so an ambiguous symbol answers null and the caller has to name the representation.
  const [only] = matches;
  return only !== undefined && matches.length === 1 ? only : null;
}

/** Everything the caller knows about the token it wants, without relying on a symbol alone. */
export interface TokenQuery {
  /** The ticker. Matching on symbol alone may be ambiguous. */
  readonly symbol?: string;
  /** Native issuance or an ITS representation. Required to separate two same-symbol tokens. */
  readonly representation?: AssetRepresentation;
  /** EVM contract address. Case insensitive. */
  readonly address?: string;
  /** Stellar classic asset code. */
  readonly code?: string;
  /** Stellar issuing account. */
  readonly issuer?: string;
  /** Stellar Asset Contract id. */
  readonly sacId?: string;
  /** Only tokens registered for this rail. */
  readonly route?: RouteKind;
}

export type TokenResolution =
  | { readonly ok: true; readonly token: EvmTokenDeployment | StellarTokenDeployment }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "ambiguous";
      readonly candidates: readonly (EvmTokenDeployment | StellarTokenDeployment)[];
    };

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function matchesTokenQuery(
  token: EvmTokenDeployment | StellarTokenDeployment,
  query: TokenQuery,
): boolean {
  if (query.symbol !== undefined && token.symbol !== query.symbol) return false;
  if (query.representation !== undefined && token.representation !== query.representation) {
    return false;
  }
  if (query.route !== undefined && !token.routes.includes(query.route)) return false;

  if ("address" in token) {
    if (query.code !== undefined || query.issuer !== undefined || query.sacId !== undefined) {
      return false;
    }
    return query.address === undefined || sameHex(token.address, query.address);
  }

  if (query.address !== undefined) return false;
  if (query.code !== undefined && token.code !== query.code) return false;
  if (query.issuer !== undefined && token.issuer !== query.issuer) return false;
  if (query.sacId !== undefined && token.sacId !== query.sacId) return false;
  return true;
}

/** Resolve one deployed token, or say why the record cannot name exactly one. */
export function resolveToken(
  set: DeploymentSet,
  chain: ChainKey,
  query: TokenQuery,
): TokenResolution {
  const deployment = set.networks[chain];
  if (deployment === undefined) return { ok: false, reason: "not-found", candidates: [] };
  const candidates = deployedTokens(deployment).filter((token) => matchesTokenQuery(token, query));
  const [only] = candidates;
  if (only !== undefined && candidates.length === 1) return { ok: true, token: only };
  if (candidates.length === 0) return { ok: false, reason: "not-found", candidates };
  return { ok: false, reason: "ambiguous", candidates };
}

/** The identity a deployment record's token actually has on its chain. */
export function tokenIdentity(
  chain: ChainKey,
  token: EvmTokenDeployment | StellarTokenDeployment,
): AssetIdentity {
  if ("address" in token) {
    return {
      family: "evm",
      chain,
      representation: token.representation,
      address: token.address,
    };
  }
  return {
    family: "stellar",
    chain,
    representation: token.representation,
    code: token.code,
    issuer: token.issuer,
  };
}

/** Look a token up by its full identity instead of by its ticker. */
export function tokenByIdentity(
  set: DeploymentSet,
  identity: AssetIdentity,
): EvmTokenDeployment | StellarTokenDeployment | null {
  const deployment = set.networks[identity.chain];
  if (deployment === undefined) return null;
  const matches = deployedTokens(deployment).filter(
    (token) =>
      tokenIdentity(identity.chain, token).family === identity.family &&
      matchesTokenQuery(
        token,
        identity.family === "evm"
          ? {
              representation: identity.representation,
              address: identity.address,
            }
          : {
              representation: identity.representation,
              code: identity.code,
              issuer: identity.issuer,
            },
      ),
  );
  const [only] = matches;
  return only !== undefined && matches.length === 1 ? only : null;
}

/** Every chain in a set that has a router, which is the list a chain picker should offer. */
export function deployedChains(set: DeploymentSet): readonly ChainKey[] {
  return Object.keys(set.networks).filter(isChainKey);
}
