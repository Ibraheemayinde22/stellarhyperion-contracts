import { CHAINS, isChainKey, type ChainKey, type NetworkMode } from "./chains.js";
import { RouteKind, routeFromSlug, type RouteSlug } from "./routes.js";
import { ASSETS } from "./registry/assets.js";

const PREFIX = "hyperion-lane:v1:";

export interface LaneKeyInput {
  readonly network: NetworkMode;
  readonly sourceChain: ChainKey;
  readonly sourceAsset: string;
  readonly destinationChain: ChainKey;
  readonly destinationAsset: string;
  /** The canonical route slug, not an arbitrary provider display name. */
  readonly provider: RouteSlug;
}

const encode = (value: readonly string[]): string => encodeURIComponent(JSON.stringify(value));
const decode = (value: string): string[] => {
  try {
    const decoded: unknown = JSON.parse(decodeURIComponent(value));
    if (!Array.isArray(decoded) || decoded.some((part) => typeof part !== "string"))
      throw new RangeError("lane key payload is invalid");
    return decoded as string[];
  } catch {
    throw new RangeError("lane key payload is malformed");
  }
};

function validate(input: unknown): LaneKeyInput {
  if (typeof input !== "object" || input === null)
    throw new RangeError("lane input must be an object");
  const { network, sourceChain, sourceAsset, destinationChain, destinationAsset, provider } =
    input as Record<string, unknown>;
  if (network !== "mainnet" && network !== "testnet")
    throw new RangeError("lane network must be mainnet or testnet");
  if (
    typeof sourceChain !== "string" ||
    !isChainKey(sourceChain) ||
    typeof destinationChain !== "string" ||
    !isChainKey(destinationChain)
  )
    throw new RangeError("lane chains must be known protocol chain keys");
  if (sourceChain === destinationChain)
    throw new RangeError("lane source and destination chains must differ");
  if (CHAINS[sourceChain].network !== network || CHAINS[destinationChain].network !== network)
    throw new RangeError("lane chains must belong to the selected network");
  if (
    typeof sourceAsset !== "string" ||
    typeof destinationAsset !== "string" ||
    typeof provider !== "string"
  )
    throw new RangeError("lane assets and provider must be strings");
  for (const [name, value] of [
    ["source asset", sourceAsset],
    ["destination asset", destinationAsset],
    ["provider", provider],
  ] as const) {
    if (value.length === 0 || value.length > 512)
      throw new RangeError(`${name} is empty or too long`);
  }
  const route = routeFromSlug(provider);
  const chains = [sourceChain, destinationChain];
  if (
    chains.some((key) =>
      route === RouteKind.Cctp
        ? CHAINS[key].cctpDomain === null
        : route === RouteKind.AxelarIts || route === RouteKind.AxelarGmp
          ? CHAINS[key].axelarName === null
          : !ASSETS.some((asset) => asset.chain === key && asset.routes.includes(route)),
    )
  )
    throw new RangeError("lane provider is unavailable for this chain pair");
  return {
    network,
    sourceChain,
    sourceAsset,
    destinationChain,
    destinationAsset,
    provider: provider as RouteSlug,
  };
}

/** Build a deterministic, collision-resistant lane key from exact asset identities. */
export function laneKey(input: LaneKeyInput): string {
  const value = validate(input);
  return (
    PREFIX +
    encode([
      value.network,
      value.sourceChain,
      value.sourceAsset,
      value.destinationChain,
      value.destinationAsset,
      value.provider,
    ])
  );
}

/** Parse and validate a key before treating it as an executable lane. */
export function parseLaneKey(key: string): LaneKeyInput {
  if (typeof key !== "string" || key.length > 20_000 || !key.startsWith(PREFIX))
    throw new RangeError("lane key version or length is unsupported");
  const parts = decode(key.slice(PREFIX.length));
  if (parts.length !== 6 || parts.some((part) => part.length === 0))
    throw new RangeError("lane key has the wrong number of fields");
  const [network, sourceChain, sourceAsset, destinationChain, destinationAsset, provider] =
    parts as [string, string, string, string, string, string];
  return validate({
    network: network as NetworkMode,
    sourceChain: sourceChain as ChainKey,
    sourceAsset,
    destinationChain: destinationChain as ChainKey,
    destinationAsset,
    provider: provider as RouteSlug,
  });
}
