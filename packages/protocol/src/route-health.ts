import type { RouteKind } from "./routes.js";
import { ROUTE_KINDS } from "./routes.js";
import type { RouterSnapshot } from "./quotes.js";
import { decimal, object, validatePlanningSnapshot } from "./quotes/validation.js";

export const ROUTE_HEALTH_VERSION = 1 as const;
export type RouteHealthStatus = "healthy" | "degraded" | "unavailable" | "unknown";

export interface RouteHealthRecord {
  readonly route: RouteKind;
  readonly status: RouteHealthStatus;
  readonly measuredAt: bigint;
  readonly scope: string;
  readonly provider: string;
}

export interface RouteHealthSnapshot {
  readonly schemaVersion: typeof ROUTE_HEALTH_VERSION;
  readonly capturedAt: bigint;
  readonly records: readonly RouteHealthRecord[];
}

const isRoute = (value: unknown): value is RouteKind =>
  typeof value === "number" && Number.isInteger(value) && ROUTE_KINDS.includes(value as RouteKind);

const isStatus = (value: unknown): value is RouteHealthStatus =>
  value === "healthy" || value === "degraded" || value === "unavailable" || value === "unknown";

const timestamp = (value: unknown, path: string): bigint => {
  return decimal(value, path, (1n << 64n) - 1n);
};

/** Parse an external provider snapshot without treating it as a live quote or configuration. */
export function parseRouteHealthSnapshot(input: unknown): RouteHealthSnapshot {
  const value = object(input, "route health snapshot");
  if (value.schemaVersion !== ROUTE_HEALTH_VERSION)
    throw new RangeError("unsupported route health version");
  const rawRecords = value.records;
  if (!Array.isArray(rawRecords) || rawRecords.length > 1024)
    throw new TypeError("route health records must be an array with at most 1024 entries");
  const capturedAt = timestamp(value.capturedAt, "capturedAt");
  const seen = new Set<string>();
  const records = rawRecords.map((raw, index): RouteHealthRecord => {
    const record = object(raw, `records.${String(index)}`);
    if (!isRoute(record.route)) throw new TypeError(`records.${String(index)}.route is invalid`);
    if (!isStatus(record.status)) throw new TypeError(`records.${String(index)}.status is invalid`);
    if (
      typeof record.scope !== "string" ||
      record.scope.trim().length === 0 ||
      record.scope.length > 256
    )
      throw new TypeError(`records.${String(index)}.scope is required`);
    if (
      typeof record.provider !== "string" ||
      record.provider.trim().length === 0 ||
      record.provider.length > 256
    )
      throw new TypeError(`records.${String(index)}.provider is required`);
    const measuredAt = timestamp(record.measuredAt, `records.${String(index)}.measuredAt`);
    if (measuredAt > capturedAt)
      throw new RangeError(`records.${String(index)}.measuredAt exceeds capturedAt`);
    const key = JSON.stringify([record.route, record.scope, record.provider]);
    if (seen.has(key))
      throw new TypeError(`records.${String(index)} duplicates a route, scope and provider`);
    seen.add(key);
    return {
      route: record.route,
      status: record.status,
      measuredAt,
      scope: record.scope,
      provider: record.provider,
    };
  });
  return { schemaVersion: ROUTE_HEALTH_VERSION, capturedAt, records };
}

export interface RouteHealthContext {
  readonly scope: string;
  readonly provider: string;
  readonly now: bigint;
  readonly maxAge: bigint;
}

/** Unknown, degraded, and unavailable providers are all conservative blockers for planning. */
export function applyRouteHealth(
  snapshot: RouterSnapshot,
  health: RouteHealthSnapshot,
  context?: RouteHealthContext,
): RouterSnapshot {
  validatePlanningSnapshot(snapshot);
  // Revalidate typed inputs at the runtime boundary too; a cast is not provider evidence.
  if (typeof health.capturedAt !== "bigint") throw new TypeError("capturedAt must be a bigint");
  for (const [index, record] of health.records.entries()) {
    if (typeof record.measuredAt !== "bigint")
      throw new TypeError(`records.${String(index)}.measuredAt must be a bigint`);
  }
  const parsed = parseRouteHealthSnapshot({
    ...health,
    capturedAt: health.capturedAt.toString(),
    records: health.records.map((record) => ({
      ...record,
      measuredAt: record.measuredAt.toString(),
    })),
  });
  if (
    context &&
    (typeof context.now !== "bigint" ||
      typeof context.maxAge !== "bigint" ||
      context.now < 0n ||
      context.maxAge < 0n ||
      typeof context.scope !== "string" ||
      typeof context.provider !== "string" ||
      context.scope.trim() === "" ||
      context.provider.trim() === "")
  )
    throw new TypeError("invalid route health context");
  const chainSupported: Partial<Record<RouteKind, boolean>> = {};
  for (const route of ROUTE_KINDS) {
    const records = parsed.records.filter(
      (record) =>
        record.route === route &&
        (!context || (record.scope === context.scope && record.provider === context.provider)),
    );
    chainSupported[route] =
      snapshot.chainSupported[route] === true &&
      records.length > 0 &&
      records.every(
        (record) =>
          record.status === "healthy" &&
          (!context ||
            (parsed.capturedAt <= context.now &&
              record.measuredAt <= context.now &&
              context.now - record.measuredAt <= context.maxAge)),
      );
  }
  return { ...snapshot, chainSupported };
}
