import { MAX_DECIMALS, MAX_FEE_BPS } from "../amounts.js";
import { ROUTE_KINDS, type RouteKind } from "../routes.js";
import type { RouterSnapshot } from "../quotes.js";

export const MAX_WORD = (1n << 256n) - 1n;

export function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
  return value;
}

export function boundedNumber(value: unknown, max: number, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${path} must be an integer between 0 and ${String(max)}`);
  }
  return value;
}

export function decimal(value: unknown, path: string, max = MAX_WORD): bigint {
  if (
    typeof value !== "string" ||
    value.length > max.toString().length ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    throw new TypeError(`${path} must be a canonical non-negative decimal integer string`);
  }
  const result = BigInt(value);
  if (result > max) throw new RangeError(`${path} exceeds its integer limit`);
  return result;
}

export function flags(value: unknown, path: string): Partial<Record<RouteKind, boolean>> {
  const raw = object(value, path);
  const result: Partial<Record<RouteKind, boolean>> = {};
  for (const [key, flag] of Object.entries(raw)) {
    const route = ROUTE_KINDS.find((route) => String(route) === key);
    if (route === undefined) throw new TypeError(`${path}.${key} is not a supported route`);
    result[route] = boolean(flag, `${path}.${key}`);
  }
  return result;
}

/** Validate runtime arithmetic before bounded planners enter their integer search. */
export function validatePlanningSnapshot(snapshot: RouterSnapshot): void {
  const state = object(snapshot, "snapshot");
  boolean(state.paused, "snapshot.paused");
  boolean(state.tokenRegistered, "snapshot.tokenRegistered");
  boolean(state.tokenEnabled, "snapshot.tokenEnabled");
  boundedNumber(state.feeBps, MAX_FEE_BPS, "snapshot.feeBps");
  boundedNumber(state.tokenDecimals, MAX_DECIMALS, "snapshot.tokenDecimals");
  flags(state.routeEnabled, "snapshot.routeEnabled");
  flags(state.adapterSet, "snapshot.adapterSet");
  flags(state.chainSupported, "snapshot.chainSupported");
  const flow = object(state.flowAvailable, "snapshot.flowAvailable");
  for (const [key, amount] of Object.entries(flow)) {
    if (
      !ROUTE_KINDS.some((route) => String(route) === key) ||
      typeof amount !== "bigint" ||
      amount < 0n ||
      amount > MAX_WORD
    ) {
      throw new TypeError(
        `snapshot.flowAvailable.${key} must be a supported route with a non-negative uint256`,
      );
    }
  }
}
