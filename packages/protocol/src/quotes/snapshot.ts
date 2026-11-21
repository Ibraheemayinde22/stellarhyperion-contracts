import type { RouteKind } from "../routes.js";
import { ROUTE_KINDS } from "../routes.js";
import type { QuoteRequest, RouteQuote, RouterSnapshot } from "../quotes.js";

export const QUOTE_SNAPSHOT_VERSION = 1 as const;
export type QuoteSnapshotSource = "router-snapshot";

/** A quote snapshot is historical data, never a promise that a price is fresh. */
export interface QuoteSnapshot {
  readonly capturedAt: bigint;
  readonly amountUnit: string;
  readonly destinationUnit: string;
  readonly request: Omit<QuoteRequest, "route">;
  readonly router: RouterSnapshot;
  readonly quotes: readonly RouteQuote[];
}

export interface SerializedQuoteSnapshot {
  readonly schemaVersion: number;
  readonly source: QuoteSnapshotSource;
  readonly capturedAt: string;
  readonly amountUnit: string;
  readonly destinationUnit: string;
  readonly request: { readonly amount: string; readonly strkey: string; readonly destinationDecimals: number };
  readonly router: Omit<RouterSnapshot, "flowAvailable"> & { readonly flowAvailable: Record<string, string> };
  readonly quotes: ReadonlyArray<{
    readonly route: number;
    readonly available: boolean;
    readonly reason: number;
    readonly grossAmount: string;
    readonly fee: string;
    readonly netAmount: string;
    readonly destinationAmount: string;
    readonly flowAvailable: string;
    readonly waitsOnAttestation: boolean;
    readonly isCanonical: boolean;
  }>;
}

const integer = (value: unknown, field: string): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${field} must be a non-negative decimal integer string`);
  }
  return BigInt(value);
};

const route = (value: unknown, field: string): RouteKind => {
  if (typeof value !== "number" || !Number.isInteger(value) || !ROUTE_KINDS.includes(value as RouteKind)) {
    throw new TypeError(`${field} is not a supported route`);
  }
  return value as RouteKind;
};

/** Serialize a quote snapshot without allowing JSON numbers to narrow bigint values. */
export function serializeQuoteSnapshot(snapshot: QuoteSnapshot): string {
  return JSON.stringify({
    schemaVersion: QUOTE_SNAPSHOT_VERSION,
    source: "router-snapshot" satisfies QuoteSnapshotSource,
    capturedAt: snapshot.capturedAt.toString(),
    amountUnit: snapshot.amountUnit,
    destinationUnit: snapshot.destinationUnit,
    request: { ...snapshot.request, amount: snapshot.request.amount.toString() },
    router: {
      ...snapshot.router,
      flowAvailable: Object.fromEntries(
        Object.entries(snapshot.router.flowAvailable).map(([key, value]) => [key, value.toString()]),
      ),
    },
    quotes: snapshot.quotes.map((quote) => ({
      ...quote,
      grossAmount: quote.grossAmount.toString(),
      fee: quote.fee.toString(),
      netAmount: quote.netAmount.toString(),
      destinationAmount: quote.destinationAmount.toString(),
      flowAvailable: quote.flowAvailable.toString(),
    })),
  });
}

/** Parse and validate a persisted snapshot. Unknown versions fail before any value is used. */
export function parseQuoteSnapshot(serialized: string): QuoteSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    throw new TypeError("quote snapshot is not valid JSON");
  }
  if (!raw || typeof raw !== "object") throw new TypeError("quote snapshot must be an object");
  const value = raw as Record<string, any>;
  if (value.schemaVersion !== QUOTE_SNAPSHOT_VERSION) throw new RangeError("unsupported quote snapshot version");
  if (value.source !== "router-snapshot") throw new TypeError("quote snapshot source is invalid");
  if (typeof value.amountUnit !== "string" || typeof value.destinationUnit !== "string") {
    throw new TypeError("quote snapshot units are required");
  }
  const request = value.request;
  if (!request || typeof request.strkey !== "string" || !Number.isInteger(request.destinationDecimals)) {
    throw new TypeError("quote snapshot request is invalid");
  }
  const router = value.router;
  if (!router || typeof router !== "object" || !router.flowAvailable) throw new TypeError("router snapshot is invalid");
  const flowAvailable: Partial<Record<RouteKind, bigint>> = {};
  for (const [key, amount] of Object.entries(router.flowAvailable)) flowAvailable[route(Number(key), "flowAvailable")] = integer(amount, `flowAvailable.${key}`);
  const quotes = value.quotes;
  if (!Array.isArray(quotes)) throw new TypeError("quote snapshot quotes are invalid");
  return {
    capturedAt: integer(value.capturedAt, "capturedAt"),
    amountUnit: value.amountUnit,
    destinationUnit: value.destinationUnit,
    request: { amount: integer(request.amount, "request.amount"), strkey: request.strkey, destinationDecimals: request.destinationDecimals },
    router: { ...router, flowAvailable },
    quotes: quotes.map((item, index) => ({
      route: route(item.route, `quotes.${index}.route`), available: item.available, reason: item.reason,
      grossAmount: integer(item.grossAmount, `quotes.${index}.grossAmount`), fee: integer(item.fee, `quotes.${index}.fee`),
      netAmount: integer(item.netAmount, `quotes.${index}.netAmount`), destinationAmount: integer(item.destinationAmount, `quotes.${index}.destinationAmount`),
      flowAvailable: integer(item.flowAvailable, `quotes.${index}.flowAvailable`), waitsOnAttestation: item.waitsOnAttestation, isCanonical: item.isCanonical,
    })),
  };
}
