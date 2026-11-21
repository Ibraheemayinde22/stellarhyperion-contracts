import type { RouteKind } from "./routes.js";
import { ROUTE_KINDS } from "./routes.js";
import type { RouterSnapshot } from "./quotes.js";

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
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${path} must be a non-negative decimal integer string`);
  }
  return BigInt(value);
};

/** Parse an external provider snapshot without treating it as a live quote or configuration. */
export function parseRouteHealthSnapshot(input: unknown): RouteHealthSnapshot {
  if (!input || typeof input !== "object") throw new TypeError("route health snapshot must be an object");
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== ROUTE_HEALTH_VERSION) throw new RangeError("unsupported route health version");
  const rawRecords = value.records;
  if (!Array.isArray(rawRecords)) throw new TypeError("route health records must be an array");
  const records = rawRecords.map((raw, index): RouteHealthRecord => {
    if (!raw || typeof raw !== "object") throw new TypeError(`records.${index} must be an object`);
    const record = raw as Record<string, unknown>;
    if (!isRoute(record.route)) throw new TypeError(`records.${index}.route is invalid`);
    if (!isStatus(record.status)) throw new TypeError(`records.${index}.status is invalid`);
    if (typeof record.scope !== "string" || record.scope.length === 0) throw new TypeError(`records.${index}.scope is required`);
    if (typeof record.provider !== "string" || record.provider.length === 0) throw new TypeError(`records.${index}.provider is required`);
    return {
      route: record.route,
      status: record.status,
      measuredAt: timestamp(record.measuredAt, `records.${index}.measuredAt`),
      scope: record.scope,
      provider: record.provider,
    };
  });
  return { schemaVersion: ROUTE_HEALTH_VERSION, capturedAt: timestamp(value.capturedAt, "capturedAt"), records };
}

/** Unknown, degraded, and unavailable providers are all conservative blockers for planning. */
export function applyRouteHealth(snapshot: RouterSnapshot, health: RouteHealthSnapshot): RouterSnapshot {
  const chainSupported = { ...snapshot.chainSupported };
  for (const record of health.records) chainSupported[record.route] = record.status === "healthy";
  return { ...snapshot, chainSupported };
}
