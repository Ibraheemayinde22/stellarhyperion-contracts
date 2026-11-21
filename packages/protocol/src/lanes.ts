import { CHAINS, isChainKey, type ChainKey, type NetworkMode } from "./chains.js";
import { routeFromSlug, type RouteSlug } from "./routes.js";

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
    return decoded;
  } catch {
    throw new RangeError("lane key payload is malformed");
  }
};

function validate(input: LaneKeyInput): LaneKeyInput {
  if (input.network !== "mainnet" && input.network !== "testnet")
    throw new RangeError("lane network must be mainnet or testnet");
  if (!isChainKey(input.sourceChain) || !isChainKey(input.destinationChain))
    throw new RangeError("lane chains must be known protocol chain keys");
  if (input.sourceChain === input.destinationChain)
    throw new RangeError("lane source and destination chains must differ");
  if (CHAINS[input.sourceChain].network !== input.network || CHAINS[input.destinationChain].network !== input.network)
    throw new RangeError("lane chains must belong to the selected network");
  for (const [name, value] of [
    ["source asset", input.sourceAsset],
    ["destination asset", input.destinationAsset],
    ["provider", input.provider],
  ] as const) {
    if (value.length === 0 || value.length > 512) throw new RangeError(`${name} is empty or too long`);
  }
  routeFromSlug(input.provider);
  return input;
}

/** Build a deterministic, collision-resistant lane key from exact asset identities. */
export function laneKey(input: LaneKeyInput): string {
  const value = validate(input);
  return PREFIX + encode([
    value.network,
    value.sourceChain,
    value.sourceAsset,
    value.destinationChain,
    value.destinationAsset,
    value.provider,
  ]);
}

/** Parse and validate a key before treating it as an executable lane. */
export function parseLaneKey(key: string): LaneKeyInput {
  if (!key.startsWith(PREFIX)) throw new RangeError("lane key version is unsupported");
  const parts = decode(key.slice(PREFIX.length));
  if (parts.length !== 6 || parts.some((part) => part.length === 0))
    throw new RangeError("lane key has the wrong number of fields");
  const [network, sourceChain, sourceAsset, destinationChain, destinationAsset, provider] = parts;
  return validate({
    network: network as NetworkMode,
    sourceChain: sourceChain as ChainKey,
    sourceAsset,
    destinationChain: destinationChain as ChainKey,
    destinationAsset,
    provider: provider as RouteSlug,
  });
}
