#!/usr/bin/env node
/**
 * Read-only orphaned-custody audit for one token on the Soroban router.
 *
 * Compares router custody with the router's tracked unsettled claim liability, and lists every
 * configured adapter and rail receiver with the balance it holds. Inbound deliveries either pay
 * their fixed recipient or park a claim in the router, and outbound dispatch hands funds to the
 * rail in the same transaction, so at rest the router should hold exactly its unsettled claims
 * and adapters/receivers should hold nothing. Anything else is reported as unexplained.
 *
 * The tool is offline. It reads a snapshot of on-chain view results (see `docs/claim-operations.md`
 * for the read-only `stellar contract invoke --send=no` calls that produce one), needs no key, and
 * cannot sweep, transfer or reassign anything. It never estimates: a missing or unreadable input
 * is reported as unknown, never as zero.
 *
 * This lives off-chain on purpose: the router WASM is at the 64KB ledger limit, and every fact the
 * audit needs is already exposed by existing router and token views.
 *
 * Usage:
 *   node script/stellar/custody-audit.mjs --snapshot <file.json>
 *   node script/stellar/custody-audit.mjs < snapshot.json
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CUSTODY_AUDIT_VERSION = 1;
export const ROUTES = ["cctp", "axelar-its", "axelar-gmp", "allbridge"];
const ROLES = ["adapter", "rail-receiver"];

/**
 * An exact non-negative token amount, or `null` when the value is absent, unreadable or not an
 * exact integer. Numbers are accepted only when they are safe integers, so nothing is rounded.
 */
export function readAmount(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  return BigInt(value.trim());
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`snapshot.${field} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Unsettled claims from `claim_liability(token)`. `known: false` means the counter cannot be
 * trusted (an unmigrated instance or a failed read), so the liability is unknown, not zero.
 */
function unsettledClaims(liability) {
  if (liability === undefined || liability === null || typeof liability !== "object") return null;
  if (liability.known !== true) return null;
  return readAmount(liability.outstanding);
}

/** Validate and de-duplicate holders, keeping the first route that names each address. */
function readHolders(holders) {
  if (holders === undefined) return [];
  if (!Array.isArray(holders)) throw new Error("snapshot.holders must be an array");
  const seen = new Map();
  for (const [index, entry] of holders.entries()) {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`snapshot.holders[${index}] must be an object`);
    }
    const route = requireString(entry.route, `holders[${index}].route`);
    if (!ROUTES.includes(route)) {
      throw new Error(`snapshot.holders[${index}].route must be one of ${ROUTES.join(", ")}`);
    }
    const role = requireString(entry.role, `holders[${index}].role`);
    if (!ROLES.includes(role)) {
      throw new Error(`snapshot.holders[${index}].role must be one of ${ROLES.join(", ")}`);
    }
    const address = requireString(entry.address, `holders[${index}].address`);
    const balance = readAmount(entry.balance);
    const existing = seen.get(address);
    if (existing === undefined) {
      seen.set(address, { route, roles: [role], address, balance });
    } else {
      if (!existing.roles.includes(role)) existing.roles.push(role);
      // Two reads of one address must agree; otherwise neither is trusted.
      if (existing.balance !== balance) existing.balance = null;
    }
  }
  return [...seen.values()];
}

const show = (amount) => (amount === null ? null : amount.toString());

/**
 * Classify one snapshot. Pure: the same snapshot always yields the same report.
 *
 * Status: `shortfall` when router custody is known to be below unsettled claims (even if other
 * inputs are unknown); otherwise `unknown` if anything needed is missing; otherwise `unexplained`
 * if the router holds more than its claims or any holder holds anything; otherwise `reconciled`.
 */
export function auditCustody(snapshot) {
  if (snapshot === null || typeof snapshot !== "object") throw new Error("snapshot must be an object");
  const token = requireString(snapshot.token, "token");
  const router = requireString(snapshot.router, "router");
  const routerCustody = readAmount(snapshot.routerBalance);
  const claims = unsettledClaims(snapshot.claimLiability);
  const holders = readHolders(snapshot.holders).filter((holder) => holder.address !== router);

  const routerUnexplained =
    routerCustody === null || claims === null ? null : routerCustody - claims;
  let holderUnexplained = 0n;
  for (const holder of holders) {
    holderUnexplained = holder.balance === null || holderUnexplained === null
      ? null
      : holderUnexplained + holder.balance;
  }

  let status;
  if (routerUnexplained !== null && routerUnexplained < 0n) status = "shortfall";
  else if (routerUnexplained === null || holderUnexplained === null) status = "unknown";
  else if (routerUnexplained > 0n || holderUnexplained > 0n) status = "unexplained";
  else status = "reconciled";

  return {
    version: CUSTODY_AUDIT_VERSION,
    token,
    router,
    routerCustody: show(routerCustody),
    unsettledClaims: show(claims),
    routerUnexplained: show(routerUnexplained),
    holders: holders.map((holder) => ({
      route: holder.route,
      roles: holder.roles,
      address: holder.address,
      balance: show(holder.balance),
    })),
    holderUnexplained: show(holderUnexplained),
    status,
    // The report is evidence only. Settling claims is `settle_claim`; disposing of unexplained
    // funds is a separate, reviewed operation this tool cannot perform.
    movesFunds: false,
  };
}

export function runCli(argv = process.argv) {
  const args = argv.slice(2);
  const flag = args.indexOf("--snapshot");
  const text =
    flag === -1 ? readFileSync(0, "utf8") : readFileSync(resolve(args[flag + 1] ?? ""), "utf8");
  const report = auditCustody(JSON.parse(text));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`custody-audit: ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  }
}
